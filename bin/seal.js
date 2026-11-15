#!/usr/bin/env node
'use strict';
/**
 * seal · 给 agent 干的活盖个章。零依赖、单文件、离线，Node 18+。
 *   node bin\seal.js [--summary ..] [--status ..] [--todo ..] [--prev ..] [--window 分钟]   盖章
 *   node bin\seal.js run [--recheck] -- <命令>                                             跑命令并记录
 *   node bin\seal.js -- <命令>                                                             同上
 *   node bin\seal.js verify [--file ..] [--allow-run]                                      验（默认不执行命令）
 *   node bin\seal.js resume|show [--file ..]                                               接管 / 打开
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { receiptHTML } = require('../lib/render.js');

const OUT = 'seal-out';
const SKIP = new Set(['node_modules', '.git', OUT]);
const WINDOW_MIN = 30;                       // 默认采集窗口（分钟）；--window 可调
const WARN_HORIZON_MS = 24 * 3600 * 1000;    // 超出窗口但 24h 内改过的文件，算「可能属于本次交付」，要告警
const VERSION = 'seal/1';

/**
 * 凭证是别人发来的输入，里面出现的命令不可信任：这些模式只提示、不阻断。
 * node -e / node -p 必须算进来——一行内联代码就能写文件、发请求，字面上却没有任何符号。
 */
const DANGER = [
  [/>>|>/, '重定向'],
  [/\|/, '管道'],
  [/&&|\|\|/, '命令串联'],
  [/;/, '命令串联'],
  [/\brm\s/i, '删除'],
  [/\bdel\s/i, '删除'],
  [/\brmdir\s|\bdel\s+\/[sf]/i, '删除'],
  [/\bcurl\s/i, '网络'],
  [/\bwget\s/i, '网络'],
  [/\b(?:node|deno|bun)\s+(?:-e|--eval|-p|--print)\b/, '内联代码'],
  [/\b(?:bash|sh|zsh|cmd|powershell|pwsh)\s+-\w*c\b/i, '内联代码'],
];
const dangerHints = (cmd) => [...new Set(DANGER.filter(([re]) => re.test(String(cmd))).map(([, n]) => n))];

/** 危险提示行；没有命中就返回空串 */
const dangerLine = (cmd) => {
  const h = dangerHints(cmd);
  return h.length ? `  ! 该命令包含危险字符（${h.join('、')}），请确认来源可信` : '';
};


/* ---------------- 基础工具 ---------------- */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 流式哈希：多大都不整份读进内存，只留指纹不贴内容 */
function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(256 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** 规范化 JSON：键排序、无空格。改任何一个字段，字符串就变。 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const short = (h) => (h ? String(h).slice(0, 8) + '…' : '(空)');

function localISO(d) {
  const off = -d.getTimezoneOffset();
  const tz = (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + tz;
}

const stamp = (d) => '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
  pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const nx = argv[i + 1];
    if (nx !== undefined && !nx.startsWith('--')) { o[a.slice(2)] = nx; i++; } else o[a.slice(2)] = true;
  }
  return o;
}

/* ---------------- 采集 ---------------- */

/**
 * 递归收集文件，分两堆：
 *   acc.in  —— 窗口内改动过，进凭证
 *   acc.out —— 超出窗口，不进凭证（用来算「可能漏了 N 个」的告警）
 * 跳过 node_modules / .git / seal-out。
 */
function walk(dir, base, acc, now, windowMs) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs, base, acc, now, windowMs); continue; }
    if (!e.isFile()) continue;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    const item = { abs, rel: path.relative(base, abs).split(path.sep).join('/'), st };
    if (now - st.mtimeMs > windowMs) acc.out.push(item);
    else acc.in.push(item);
  }
}
function readCommands(cwd) {
  const p = path.join(cwd, OUT, 'commands.jsonl');
  if (!fs.existsSync(p)) return [];
  const rows = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const text = typeof o.out === 'string' ? o.out : '';
    const item = {
      cmd: String(o.cmd || ''), exit: Number.isFinite(o.exit) ? o.exit : null,
      ms: Number.isFinite(o.ms) ? o.ms : null,
      out_sha256: sha256(Buffer.from(text, 'utf8')), out_head: text.slice(0, 200),
    };
    if (o.recheck === true) item.recheck = true;
    rows.push(item);
  }
  return rows;
}

/** 追加一条命令记录到 seal-out/commands.jsonl（盖章时会被 readCommands 读走） */
function appendCommand(cwd, rec) {
  const dir = path.join(cwd, OUT);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'commands.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

function readGit(cwd) {
  const run = (args) => {
    try { return cp.execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch == null) return null;
  const rev = run(['rev-parse', '--short', 'HEAD']) || '';
  const por = run(['status', '--porcelain']);
  return { branch: branch || 'HEAD', rev, dirty: !!(por && por.length) };
}

/* ---------------- 凭证 ---------------- */

const chainHash = (prev, body) => sha256(Buffer.from(String(prev || '') + stable(body), 'utf8'));

/**
 * 除 chain 与 sig 之外的主体，用于算链哈希。
 * sig 必须排除：签名对象就是 chain.hash，若把 sig 算进正文会绕成循环。
 */
function bodyOf(r) {
  const b = {};
  for (const k of Object.keys(r)) if (k !== 'chain' && k !== 'sig') b[k] = r[k];
  return b;
}

/* ---------------- 密钥 / 签名 / 信任列表（ed25519，零依赖、不联网） ---------------- */

const sealHome = () => process.env.SEAL_HOME || path.join(os.homedir(), '.seal');
const keyFile = () => path.join(sealHome(), 'key.json');
const pubFile = () => path.join(sealHome(), 'pubkey.json');
const trustFile = () => path.join(sealHome(), 'trusted.json');

/** 指纹 = sha256(公钥 DER/SPKI) 前 16 位；与 PEM 的换行、头部无关 */
const fprOf = (pem) => sha256(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' })).slice(0, 16);

const loadKey = () => { try { return JSON.parse(fs.readFileSync(keyFile(), 'utf8')); } catch { return null; } };
const loadTrust = () => {
  try { const a = JSON.parse(fs.readFileSync(trustFile(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
};
function saveTrust(a) {
  fs.mkdirSync(sealHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(trustFile(), JSON.stringify(a, null, 2) + '\n', 'utf8');
}

/** 签名对象 = chain.hash 的 UTF-8 字节（README 里写死这条，别改） */
function signChain(hash) {
  const k = loadKey();
  if (!k || typeof k.private_pem !== 'string') return null;
  try {
    const value = crypto.sign(null, Buffer.from(String(hash), 'utf8'), crypto.createPrivateKey(k.private_pem)).toString('base64');
    return { alg: 'ed25519', pub_fpr: k.pub_fpr || fprOf(k.public_pem), value };
  } catch { return null; }
}

/** none（没签名）/ untrusted（公钥不认识）/ ok / bad（签名对不上） */
function sigState(r) {
  if (!r || !r.sig || typeof r.sig.value !== 'string') return { state: 'none' };
  const sig = r.sig;
  const trusted = loadTrust().find((t) => t.pub_fpr === sig.pub_fpr);
  if (!trusted) return { state: 'untrusted', fpr: sig.pub_fpr };
  try {
    const ok = crypto.verify(null,
      Buffer.from(String(r.chain && r.chain.hash), 'utf8'),
      crypto.createPublicKey(trusted.public_pem),
      Buffer.from(sig.value, 'base64'));
    return ok ? { state: 'ok', fpr: sig.pub_fpr } : { state: 'bad', fpr: sig.pub_fpr };
  } catch { return { state: 'bad', fpr: sig.pub_fpr }; }
}

function pubPemFromFile(p) {
  const raw = fs.readFileSync(p, 'utf8');
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* 不是 JSON，按 PEM 处理 */ }
  if (obj && typeof obj.public_pem === 'string') return obj.public_pem;
  if (obj && typeof obj.pub === 'string' && /BEGIN/.test(obj.pub)) return obj.pub;
  if (/-----BEGIN PUBLIC KEY-----/.test(raw)) return raw;
  throw new Error('需要 pubkey.json / key.json，或 PEM 公钥文件');
}

function cmdKeygen(opts) {
  const f = keyFile();
  if (fs.existsSync(f) && opts.force !== true) {
    console.log(`密钥已存在：${f}`);
    console.log('  覆盖请加 --force（覆盖后，之前签过的凭证一律验不过）');
    return 1;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const public_pem = publicKey.export({ type: 'spki', format: 'pem' });
  const private_pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub_fpr = fprOf(public_pem);

  fs.mkdirSync(sealHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ alg: 'ed25519', created_at: localISO(new Date()), pub_fpr, public_pem, private_pem }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(pubFile(), JSON.stringify({ alg: 'ed25519', pub_fpr, public_pem }, null, 2) + '\n', 'utf8');

  // 自己的公钥直接进本机信任列表：否则自己验自己的凭证还会显示「公钥未被信任」
  const list = loadTrust();
  if (!list.some((t) => t.pub_fpr === pub_fpr)) {
    list.push({ pub_fpr, public_pem, source: 'self (keygen)', added_at: localISO(new Date()) });
    saveTrust(list);
  }

  console.log(`已生成密钥：${f}`);
  console.log(`  指纹 ${pub_fpr}`);
  console.log(`  公钥 ${pubFile()}　- 把这个文件发给甲方，他跑 seal trust <文件> 就能验你的签名`);
  return 0;
}

function cmdTrust(opts) {
  if (opts.list === true) {
    const list = loadTrust();
    if (!list.length) {
      console.log('信任列表为空：还没有信任任何公钥');
      return 0;
    }
    console.log(`信任列表（${list.length} 个）：`);
    for (const t of list) console.log(`  ${t.pub_fpr}  ${t.source || '(未知来源)'}  ${t.added_at || ''}`);
    return 0;
  }
  const p = opts._[1];
  if (!p) {
    console.log('用法：node bin\\seal.js trust <公钥文件>　或　node bin\\seal.js trust --list');
    return 1;
  }
  let pem;
  try { pem = pubPemFromFile(p); } catch (e) {
    console.log(`读不了公钥：${e.message}`);
    return 1;
  }
  let fpr;
  try { fpr = fprOf(pem); } catch (e) {
    console.log(`不是有效公钥：${e.message}`);
    return 1;
  }
  const list = loadTrust();
  if (list.some((t) => t.pub_fpr === fpr)) {
    console.log(`已在信任列表里：${fpr}`);
    return 0;
  }
  list.push({ pub_fpr: fpr, public_pem: pem, source: path.resolve(p), added_at: localISO(new Date()) });
  saveTrust(list);
  console.log(`已加入信任列表：${fpr}（来源 ${p}）`);
  return 0;
}

const defaultSummary = (files, commands, status) => {
  const tail = status === 'done' ? '可以验收' : status === 'partial' ? '还没做完' : '卡住了';
  return `这次交付改动 ${files.length} 个文件、留下 ${commands.length} 条命令记录，${tail}。`;
};

function writeReceipt(cwd, r) {
  const dir = path.join(cwd, OUT);
  fs.mkdirSync(dir, { recursive: true });
  const j = path.join(dir, 'receipt.json');
  const h = path.join(dir, 'receipt.html');
  fs.writeFileSync(j, JSON.stringify(r, null, 2) + '\n', 'utf8');
  fs.writeFileSync(h, receiptHTML(r), 'utf8');
  return { j, h };
}

const lastPtrFile = () => path.join(sealHome(), 'last-receipt');

/** 盖章时记下「最后一份凭证在哪」，别的目录里 resume 才接得上（写失败不影响盖章） */
function writeLastPointer(file) {
  try {
    fs.mkdirSync(sealHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lastPtrFile(), path.resolve(file) + '\n', 'utf8');
  } catch { /* 指针只是便利，没有它照样能 --receipt 指定 */ }
}

/**
 * 找凭证，三条路按顺序：
 *   ① 显式 --receipt / --file
 *   ② 从 cwd 向上找 seal-out/receipt.json（在子目录里也能接上）
 *   ③ ~/.seal/last-receipt 指针——只有 resume / show 允许：
 *      验真必须指向当前项目，不能让一个全局指针把「你在验哪一份」搞错。
 */
function resolveReceipt(opts = {}) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const explicit = (typeof opts.receipt === 'string' && opts.receipt) ? opts.receipt
    : (typeof opts.file === 'string' && opts.file) ? opts.file : '';
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    return fs.existsSync(p) ? p : null;
  }
  let d = cwd;
  for (;;) {
    const p = path.join(d, OUT, 'receipt.json');
    if (fs.existsSync(p)) return p;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (opts.pointer === true) {
    try {
      const p = fs.readFileSync(lastPtrFile(), 'utf8').trim();
      if (p && fs.existsSync(p)) return p;
    } catch { /* 没指针就当没找到 */ }
  }
  return null;
}

function openReceipt(file) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = r.cwd && fs.existsSync(r.cwd) ? r.cwd : path.dirname(path.dirname(file));
  return { r, file, base, html: path.join(path.dirname(file), 'receipt.html') };
}

/* ---------------- 命令 ---------------- */

/**
 * 盖章的核心：采文件、读命令、算链哈希、签名、落盘。
 * 不做任何输出——打印归调用方，MCP 那边 stdout 是协议通道，一个 console.log 就把协议打坏。
 * 返回 { ok, code, lines, receipt, jsonPath, htmlPath }
 */
function sealCore(opts = {}) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const nowD = new Date();
  const winMin = Number(opts.window);
  const windowMin = Number.isFinite(winMin) && winMin > 0 ? winMin : WINDOW_MIN;
  const windowMs = windowMin * 60 * 1000;

  const now = Date.now();
  const acc = { in: [], out: [] };
  walk(cwd, cwd, acc, now, windowMs);
  acc.in.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const files = acc.in.map((f) => ({ path: f.rel, bytes: f.st.size, sha256: sha256File(f.abs), mtime: localISO(f.st.mtime) }));
  const commands = readCommands(cwd);
  const git = readGit(cwd);
  const status = ['done', 'partial', 'blocked'].includes(opts.status) ? opts.status : 'done';

  // 窗口外但 24h 内改过的文件：很可能就属于这次交付，只是改了超过 30 分钟，必须说出来
  const missed = acc.out.filter((f) => now - f.st.mtimeMs <= WARN_HORIZON_MS).length;
  const warnings = [];
  if (missed > 0) warnings.push(`另有 ${missed} 个文件超出 ${windowMin} 分钟窗口未收录（可用 --window 调大）`);

  // 空凭证拦截：什么都没采到就不给凭证，免得「空纸一张」被当成验收结论
  if (files.length === 0 && commands.length === 0) {
    const lines = ['没有采到任何文件或命令，未生成凭证。',
      `  窗口 ${windowMin} 分钟内的文件：0 个；命令记录：0 条。`];
    if (missed > 0) lines.push(`  注意：另有 ${missed} 个文件超出 ${windowMin} 分钟窗口未收录（可用 --window 调大）`);
    lines.push('  提示：先跑 seal run -- <命令> 记下命令，或确认你在要交付的那个目录里。');
    return { ok: false, code: 2, reason: 'empty', lines, warnings };
  }

  const r = {
    schema: VERSION,
    id: 'SEAL-' + stamp(nowD),
    created_at: localISO(nowD),
    cwd,
    summary: typeof opts.summary === 'string' ? opts.summary : defaultSummary(files, commands, status),
    status,
    files,
    commands,
    git,
    warnings,
  };
  const nextText = typeof opts.next === 'string' ? opts.next : typeof opts.todo === 'string' ? opts.todo : null;
  if (nextText !== null) r.next = nextText;

  const prev = typeof opts.prev === 'string' ? opts.prev : '';
  r.chain = { alg: 'sha256', prev, hash: chainHash(prev, bodyOf(r)) };
  const sig = signChain(r.chain.hash);
  if (sig) r.sig = sig;

  const { j, h } = writeReceipt(cwd, r);
  writeLastPointer(j);

  const lines = [`已盖章：${files.length} 个文件 / ${commands.length} 条命令 / 编号 ${r.id}`];
  for (const w of warnings) lines.push(`注意：${w}`);
  lines.push(sig ? `  已签名：ed25519，指纹 ${sig.pub_fpr}` : '  未签名：没找到密钥（seal keygen 生成后，凭证才带签名）');
  lines.push(`  凭证 ${path.relative(cwd, j)} · 网页 ${path.relative(cwd, h)}`);
  return { ok: true, code: 0, receipt: r, jsonPath: j, htmlPath: h, lines, warnings };
}

function cmdSeal(opts) {
  const res = sealCore(opts);
  for (const line of res.lines) console.log(line);
  return res.code;
}

/** 验真的核心：返回结构化结论 + 要打印的行，CLI / MCP 共用 */
function verifyCore(opts = {}) {
  const file = resolveReceipt(opts);
  if (!file) {
    const lines = ['不通过：读不到凭证（当前目录没有 seal-out/receipt.json，或用 --file 指定）'];
    return { ok: false, code: 1, lines, message: lines[0], pass: 0, total: 0, fails: [lines[0]], skipped: 0, sig: { state: 'none' } };
  }
  let ctx;
  try { ctx = openReceipt(file); } catch (e) {
    const lines = [`不通过：读不到凭证（${e.message}）`];
    return { ok: false, code: 1, lines, message: lines[0], pass: 0, total: 0, fails: [lines[0]], skipped: 0, sig: { state: 'none' } };
  }
  const { r, base } = ctx;
  const lines = [];
  const fails = [];
  let pass = 0, total = 0;

  // ① 链哈希
  total++;
  const want = chainHash(r.chain && r.chain.prev, bodyOf(r));
  const chainOK = !!(r.chain && r.chain.alg === 'sha256' && r.chain.hash === want);
  if (chainOK) pass++;
  else fails.push(`链哈希不一致（凭证 ${short(r.chain && r.chain.hash)} / 现算 ${short(want)}），凭证正文被改过`);

  // ② 文件哈希
  for (const f of r.files || []) {
    total++;
    const abs = path.join(base, f.path);
    let cur = null;
    try { cur = sha256File(abs); } catch { cur = null; }
    if (cur === null) fails.push(`${f.path} 文件不见了`);
    else if (cur !== f.sha256) fails.push(`${f.path} 哈希不一致（凭证 ${short(f.sha256)} / 现状 ${short(cur)}）`);
    else pass++;
  }

  // ③ 签名：只有「公钥在信任列表里 + 验签通过」才算防抵赖。
  //    正文一旦和链哈希对不上，签名的对象（chain.hash）就已经不代表这份正文了——直接判不匹配。
  const sig = sigState(r);
  const sigBroken = sig.state === 'bad' || (sig.state !== 'none' && !chainOK);
  if (sigBroken) fails.unshift('签名不匹配：凭证被改过');

  // ④ 声明要重跑的命令：默认只列出来，不执行（凭证是别人发来的输入，不能一验就跑代码）
  const rechecks = (r.commands || []).filter((c) => c.recheck === true);
  const allowRun = opts['allow-run'] === true;
  let skipped = 0;
  if (rechecks.length && !allowRun) {
    skipped = rechecks.length;
    lines.push(`将重跑 ${rechecks.length} 条命令（加 --allow-run 才执行）：`);
    for (const c of rechecks) {
      lines.push(`  $ ${c.cmd}`);
      const line = dangerLine(c.cmd);
      if (line) lines.push(line);
    }
  }
  if (rechecks.length && allowRun) {
    for (const c of rechecks) {
      total++;
      lines.push(`$ ${c.cmd}`);
      const line = dangerLine(c.cmd);
      if (line) lines.push(line);
      const res = cp.spawnSync(c.cmd, {
        cwd: base, shell: true, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      });
      const out = (res.stdout || '') + (res.stderr || '');
      const code = res.status === null ? 124 : res.status;
      if (code !== c.exit) fails.push(`命令「${c.cmd}」退出码对不上（凭证 ${c.exit} / 现状 ${code}）`);
      else if (sha256(Buffer.from(out, 'utf8')) !== c.out_sha256)
        fails.push(`命令「${c.cmd}」输出指纹对不上（重跑结果与凭证不同）`);
      else pass++;
    }
  }

  if (!fails.length) {
    // 有命令没重跑就只是「部分验证」——不能拿这句话去当「验真成功」
    if (skipped) {
      lines.push(`通过 ${pass}/${total}　凭证 ${r.id} 部分验证：文件与链未被动过，${skipped} 条命令未重跑（加 --allow-run 才执行）。`);
    } else {
      lines.push(`通过 ${pass}/${total}　凭证 ${r.id} 验真成功，现状与盖章时一致。`);
    }
    lines.push(sigLine(sig, true));
    return { ok: true, code: 0, lines, message: lines.join('\n'), pass, total, fails, skipped, sig, id: r.id, partial: skipped > 0 };
  }
  lines.push(`不通过 ${pass}/${total}：${fails[0]}`);
  if (skipped) lines.push(`  另有 ${skipped} 条命令未重跑（加 --allow-run 才执行）`);
  for (const m of fails.slice(1)) lines.push(`  · ${m}`);
  if (!sigBroken) lines.push(sigLine(sig, false));
  return { ok: false, code: 1, lines, message: lines.join('\n'), pass, total, fails, skipped, sig, id: r.id, partial: false };
}

function cmdVerify(opts) {
  const res = verifyCore(opts);
  for (const line of res.lines) console.log(line);
  return res.code;
}

/** 三档结论必须一眼能分开：没签 / 签了但不认识这把钥匙 / 签了且验过 */
function sigLine(s, passed) {
  if (s.state === 'none') return '未签名：任何人可重算此凭证（当前结论不构成防抵赖）';
  if (s.state === 'untrusted') return '已签名，但公钥未被信任（用 seal trust <pubkey 文件> 加入）';
  if (s.state === 'ok') {
    // 验真不通过但签名有效 = 凭证没被改，是交付的文件被改了；别把这句话说成「验真成功」
    return passed
      ? `已签名并验证通过（签名者指纹 ${s.fpr}）`
      : `凭证本身的签名有效（签名者指纹 ${s.fpr}）；不通过的是上面那些文件，不是凭证`;
  }
  return '签名不匹配：凭证被改过';
}


/* ---------------- 跑命令并记录 ---------------- */

/**
 * seal run -- <命令>：真执行、输出原样透传、把完整 stdout+stderr 记进 commands.jsonl。
 * 退出码透传被跑命令的退出码；加 --recheck 则盖章后的 verify 会认这条命令。
 */
function cmdRun(opts, argvCmd) {
  const cmd = (argvCmd || []).join(' ').trim();
  if (!cmd) {
    console.log('用法：node bin\\seal.js run [--recheck] -- <命令>');
    return 1;
  }
  const cwd = process.cwd();
  const t0 = Date.now();
  const outs = [];
  const errs = [];
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve(code); } };
    let p;
    try {
      p = cp.spawn(cmd, { cwd, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    } catch (e) {
      console.log(`启动失败：${e.message}`);
      return finish(1);
    }
    p.stdout.on('data', (b) => { process.stdout.write(b); outs.push(b); });
    p.stderr.on('data', (b) => { process.stderr.write(b); errs.push(b); });
    p.on('error', (e) => { console.log(`启动失败：${e.message}`); finish(1); });
    p.on('close', (code) => {
      const exit = code === null ? 124 : code;
      const ms = Date.now() - t0;
      const out = Buffer.concat(outs).toString('utf8') + Buffer.concat(errs).toString('utf8');
      const rec = { cmd, exit, ms, out };
      if (opts.recheck === true) rec.recheck = true;
      appendCommand(cwd, rec);
      console.log(`已记录：${cmd}　退出 ${exit}　${ms} ms → ${OUT}/commands.jsonl`);
      finish(exit);
    });
  });
}

/* ---------------- 时间锚：把 chain.hash 写进一条 git 提交 ---------------- */

/**
 * 提交时间由仓库/远端背书，事后改不了——这是「不靠自己」的那一半。
 * 只写 seal-out/ANCHOR 一个文件，只提交这一个路径；绝不 push。
 */
function cmdAnchor(opts) {
  const file = resolveReceipt(opts);
  if (!file) {
    console.log('读不到凭证：当前目录没有 seal-out/receipt.json（先用 --file 指定，或先盖章）');
    return 1;
  }
  let ctx;
  try { ctx = openReceipt(file); } catch (e) {
    console.log(`读不到凭证：${e.message}`);
    return 1;
  }
  const { r } = ctx;
  const cwd = process.cwd();
  const git = (args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  let top;
  try { top = git(['rev-parse', '--show-toplevel']).trim(); } catch {
    console.log('anchor 需要 git 仓库：当前目录不在任何 git 仓库里（先 git init，或在仓库内运行）');
    return 1;
  }

  const anchorAbs = path.join(path.dirname(file), 'ANCHOR');
  const rel = path.relative(top, anchorAbs).split(path.sep).join('/');
  const hash = String((r.chain && r.chain.hash) || '');
  fs.writeFileSync(anchorAbs, `${r.id} ${hash}\n`, 'utf8');

  const msg = `seal anchor ${r.id} ${hash.slice(0, 12)}`;
  let committed = true;
  try {
    git(['add', '-f', '--', rel]);
    git(['commit', '-m', msg, '--', rel]);
  } catch (e) {
    const text = `${e.stdout || ''}${e.stderr || ''}`;
    if (/nothing to commit|no changes added|nothing added/i.test(text)) {
      committed = false;
    } else {
      console.log(`锚定失败：${(text.trim().split('\n')[0] || e.message)}`);
      console.log('  常见原因：仓库没配 user.name / user.email，或 pre-commit 钩子失败。');
      return 1;
    }
  }

  let rev = '';
  let iso = '';
  try {
    rev = git(['rev-parse', '--short', 'HEAD']).trim();
    iso = git(['log', '-1', '--format=%cI']).trim();
  } catch { /* 取不到就打印占位，不影响结论 */ }

  if (!committed) {
    console.log(`ANCHOR 内容与上次相同，未产生新提交（当前 HEAD ${rev || '—'}）`);
    return 0;
  }
  console.log(`已锚定：commit ${rev || '—'}，时间 ${iso || '—'}，hash ${hash.slice(0, 12)}`);
  console.log('  把这行提交推到远端后，这个时间点就无法再改（seal 不会自动 push，推送是你的事）。');
  return 0;
}

/* ---------------- 接管简报（resume：v0.4 起是主入口） ---------------- */

const STATE_LABEL = { ok: '可验收', partial: '部分验证', tampered: '被改过' };

/** 接手提示：三档各一句可执行的话，别让人自己判断该不该信 */
const HINTS = {
  ok: () => '先跑 node bin\\seal.js verify 确认现状一致，再决定要不要接着改',
  partial: (n) => `有 ${n} 条命令没重跑，先 verify --allow-run 再接手`,
  tampered: () => '凭证和现状不一致，先看差异再决定是否信任上一棒',
};

const nextOf = (r) => (typeof r.next === 'string' ? r.next : typeof r.todo === 'string' ? r.todo : '');

/**
 * 凭证 vs 现状，三档：
 *   ok       链、签名、文件都对得上，没有要重跑的命令
 *   partial  对得上，但有 recheck 命令没跑——「部分验证」不能说成「验真成功」
 *   tampered 链哈希 / 签名 / 任一文件对不上
 */
function receiptState(r, base) {
  const want = chainHash(r.chain && r.chain.prev, bodyOf(r));
  const chainOK = !!(r.chain && r.chain.alg === 'sha256' && r.chain.hash === want);
  const sig = sigState(r);
  const sigBroken = sig.state === 'bad' || (sig.state !== 'none' && !chainOK);
  const changed = [];
  for (const f of r.files || []) {
    let cur = null;
    try { cur = sha256File(path.join(base, f.path)); } catch { cur = null; }
    if (cur !== f.sha256) changed.push(f.path);
  }
  const rechecks = (r.commands || []).filter((c) => c.recheck === true).length;
  const tampered = !chainOK || sigBroken || changed.length > 0;
  return { chainOK, sig, sigBroken, changed, rechecks, state: tampered ? 'tampered' : rechecks ? 'partial' : 'ok' };
}

/** 接管简报：把凭证翻成「下一个会话照着就能接着干」的七段 */
function resumeCore(opts = {}) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const file = resolveReceipt({ cwd, file: opts.file, receipt: opts.receipt, pointer: true });
  if (!file) {
    const lines = ['这个目录里没有凭证，先跑 seal 盖章',
      '  盖完再跑 resume 就接得上；凭证在别处的话，用 --receipt <路径> 指定。'];
    return { ok: false, code: 3, lines, text: lines.join('\n'), data: null, state: 'none' };
  }
  let ctx;
  try { ctx = openReceipt(file); } catch (e) {
    const lines = [`读不到凭证：${e.message}`, '这个目录里没有可用的凭证，先跑 seal 盖章'];
    return { ok: false, code: 3, lines, text: lines.join('\n'), data: null, state: 'none' };
  }

  let r = ctx.r;
  const notes = [];

  // --todo / --next 写回：链哈希要重算；签过名的还得重签，否则自己把凭证弄成「被改过」
  const nextText = typeof opts.next === 'string' ? opts.next : typeof opts.todo === 'string' ? opts.todo : null;
  if (nextText !== null) {
    const prev = (r.chain && r.chain.prev) || '';
    const hadSig = !!r.sig;                 // bodyOf 会把 sig 剔掉，先记下来才知道要不要告警
    const body = bodyOf(r);
    body.next = nextText;
    delete body.todo;                       // 老字段只读不写：一份凭证不留两个「下一步」
    body.chain = { alg: 'sha256', prev, hash: chainHash(prev, bodyOf(body)) };
    const re = signChain(body.chain.hash);
    if (re) body.sig = re;
    else if (hadSig) notes.push('本机没有密钥，改写后原签名失效——这份凭证现在显示为未签名');
    fs.writeFileSync(ctx.file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(path.dirname(ctx.file), 'receipt.html'), receiptHTML(body), 'utf8');
    r = body;
  }

  const st = receiptState(r, ctx.base);
  const label = STATE_LABEL[st.state];
  const files = r.files || [];
  const cmds = r.commands || [];
  const badCmds = cmds.filter((c) => c.exit !== 0);
  const nextOut = nextOf(r);

  const L = [`接管简报 · ${r.id || '(无编号)'} · ${r.created_at || '(无时间)'} · ${label}`, '='.repeat(68)];
  for (const n of notes) L.push(`注意：${n}`);
  L.push('这是什么活');
  L.push(`  ${r.summary || '未声明'}${r.status && r.status !== 'done' ? `（上一棒自评：${r.status}）` : ''}`);
  L.push('');
  L.push(`改了哪些文件（${files.length} 个）`);
  if (!files.length) L.push('  （没有文件变动）');
  for (const f of files.slice(0, 8)) L.push(`  ${f.path} (${f.bytes} B) ${String(f.sha256).slice(0, 8)}`);
  if (files.length > 8) L.push(`  还有 ${files.length - 8} 个`);
  if (st.state === 'tampered') {
    if (!st.chainOK) L.push('  凭证正文被改过（链哈希对不上）');
    if (st.changed.length) {
      const head = st.changed.slice(0, 3).join('、');
      L.push(`  与凭证对不上：${head}${st.changed.length > 3 ? ` 等 ${st.changed.length} 个` : ''}`);
    }
    if (st.sigBroken) L.push('  签名对不上（被改过，或不是这把钥匙签的）');
  }
  L.push('');
  L.push(`验过什么：${cmds.length} 条命令，${cmds.length - badCmds.length} 条通过，${badCmds.length} 条失败`);
  if (!cmds.length) L.push('  （没有命令记录）');
  for (const c of badCmds.slice(0, 2)) {
    const first = String(c.out_head || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '(无输出)';
    L.push(`  失败：${c.cmd}　退出 ${c.exit === null ? '—' : c.exit}`);
    L.push(`    首行输出：${first.slice(0, 120)}`);
  }
  L.push('');
  L.push(`下一步：${nextOut || '未声明'}`);
  L.push(`接手提示：${(HINTS[st.state] || HINTS.ok)(st.rechecks)}`);
  L.push('机器可读：加 --json 输出');

  const data = {
    id: r.id || null,
    createdAt: r.created_at || null,
    status: r.status || null,
    summary: r.summary || null,
    files: files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    commands: cmds.map((c) => ({ cmd: c.cmd, exit: c.exit, ms: c.ms, ok: c.exit === 0, recheck: c.recheck === true })),
    next: nextOut || null,
    verify: { state: st.state, label, filesChanged: st.changed.length, commandsSkipped: st.rechecks, signature: st.sig.state },
  };
  return { ok: true, code: 0, lines: L, text: L.join('\n'), data, notes, file, state: st.state, label };
}

function cmdResume(opts) {
  const res = resumeCore(opts);
  if (opts.json === true) {
    // --json 只吐 JSON：可以被 jq / 别的程序直接接走
    if (!res.data) {
      console.log(JSON.stringify({ error: res.lines[0], code: res.code }, null, 2));
      return res.code;
    }
    console.log(JSON.stringify(res.data, null, 2));
    return 0;
  }
  for (const line of res.lines) console.log(line);
  return res.code;
}

/** 凭证摘要（不含 HTML 正文）：给 MCP 用，也方便别的程序读 */
function showCore(opts = {}) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const file = resolveReceipt({ cwd, file: opts.file, receipt: opts.receipt, pointer: true });
  if (!file) return { ok: false, code: 1, message: '读不到凭证：这个目录里没有 seal-out/receipt.json' };
  let ctx;
  try { ctx = openReceipt(file); } catch (e) {
    return { ok: false, code: 1, message: `读不到凭证：${e.message}` };
  }
  const r = ctx.r;
  const st = receiptState(r, ctx.base);
  return {
    ok: true, code: 0, file, html: ctx.html, state: st,
    data: {
      id: r.id || null,
      createdAt: r.created_at || null,
      status: r.status || null,
      summary: r.summary || null,
      cwd: r.cwd || null,
      next: nextOf(r) || null,
      files: (r.files || []).length,
      commands: (r.commands || []).length,
      chainHash: (r.chain && r.chain.hash) || null,
      prev: (r.chain && r.chain.prev) || '',
      signature: { present: !!r.sig, alg: (r.sig && r.sig.alg) || null, pub_fpr: (r.sig && r.sig.pub_fpr) || null, state: st.sig.state },
      git: r.git || null,
      warnings: r.warnings || [],
      receiptPath: file,
      htmlPath: ctx.html,
      state: st.state,
      label: STATE_LABEL[st.state],
    },
  };
}

function cmdShow(opts) {
  const res = showCore(opts);
  if (!res.ok) {
    console.log(res.message);
    return res.code;
  }
  const html = res.html;
  if (!fs.existsSync(html)) {
    console.log(`凭证网页不存在：${html}`);
    return 1;
  }
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', html] : [html];
  try {
    const p = cp.spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => console.log(`打不开浏览器，凭证路径：${html}`));
    p.unref();
    console.log(`已用默认浏览器打开：${html}`);
  } catch {
    console.log(`打不开浏览器，凭证路径：${html}`);
  }
  return 0;
}

/* ---------------- 入口 ---------------- */

/** 在第一个 `--` 处切开：左边是 seal 自己的参数，右边是要跑的命令 */
function splitArgv(argv) {
  const i = argv.indexOf('--');
  if (i < 0) return { opts: parseArgs(argv), tail: null };
  return { opts: parseArgs(argv.slice(0, i)), tail: argv.slice(i + 1) };
}

function main() {
  const { opts, tail } = splitArgv(process.argv.slice(2));
  const cmd = opts._[0] || '';

  if (cmd === 'help' || cmd === '-h' || opts.help === true || opts.h === true) {
    console.log(`seal · 给 AI 干的活盖章：一个命令生成可验收的交付凭证，下一个 AI 一读就接手

  node bin\\seal.js [--summary 一句话] [--status done|partial|blocked] [--todo 下一步] [--prev 上一段哈希] [--window 分钟]
  node bin\\seal.js resume [--receipt 路径] [--json]  接管简报（主入口）；--json 出机器可读的裁剪版
  node bin\\seal.js run [--recheck] -- <命令>   跑一条命令并记进 seal-out\\commands.jsonl
  node bin\\seal.js -- <命令>                   同上（seal run 的简写）
  node bin\\seal.js verify [--file 路径] [--allow-run]   验真；默认不执行凭证里的任何命令
  node bin\\seal.js keygen [--force]              生成本机 ed25519 密钥（~/.seal/key.json + pubkey.json）
  node bin\\seal.js trust <公钥文件> | trust --list  把对方公钥加进信任列表
  node bin\\seal.js anchor [--file 路径]           把 chain.hash 写进一条 git 提交（只本地，不 push）
  node bin\\seal.js show   [--file 路径]
  node bin\\seal-mcp.js                          以 MCP server 方式跑（stdio，给 agent 自己调用）

产物：seal-out\\receipt.json（可验、建议入库）、seal-out\\receipt.html（可打印）
命令日志：seal-out\\commands.jsonl（可能含输出片段，不建议入库）
签名对象：chain.hash 的 UTF-8 字节；公钥指纹 = sha256(公钥 DER/SPKI) 前 16 位
`);
    return 0;
  }

  // `seal -- <命令>` 与 `seal run -- <命令>` 等价
  if (tail) {
    if (!cmd || cmd === 'seal' || cmd === 'run') return cmdRun(opts, tail);
    console.log(`不认识的命令：${cmd}（-- 之前只接受 seal 或 run）`);
    return 1;
  }

  if (!cmd || cmd === 'seal') return cmdSeal(opts);
  if (cmd === 'keygen') return cmdKeygen(opts);
  if (cmd === 'trust') return cmdTrust(opts);
  if (cmd === 'anchor') return cmdAnchor(opts);
  if (cmd === 'run') {
    console.log('用法：node bin\\seal.js run [--recheck] -- <命令>');
    return 1;
  }
  if (cmd === 'verify') return cmdVerify(opts);
  if (cmd === 'resume') return cmdResume(opts);
  if (cmd === 'show') return cmdShow(opts);
  console.log(`不认识的命令：${cmd}（可用：seal / run / verify / resume / show）`);
  return 1;
}

// 只有直接跑这个文件才当 CLI；被 seal-mcp.js require 时不能执行 main()
if (require.main === module) {
  const ret = main();
  if (ret && typeof ret.then === 'function') ret.then((code) => { process.exitCode = code; });
  else process.exitCode = ret;
}

module.exports = {
  // 核心：不打印，只返回结果——MCP 那边 stdout 是协议通道，一个 console.log 就把协议打坏
  sealCore, verifyCore, resumeCore, showCore,
  resolveReceipt, openReceipt, receiptState, nextOf,
  sha256File, chainHash, bodyOf, stable,
  OUT, VERSION,
};
