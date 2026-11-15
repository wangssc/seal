#!/usr/bin/env node
'use strict';
/**
 * seal · 给 agent 干的活盖个章。零依赖、单文件、离线，Node 18+。
 *   node bin\seal.js [--summary ..] [--status ..] [--todo ..] [--prev ..]   盖章
 *   node bin\seal.js verify|resume|show [--file ..]                        验 / 接管 / 打开
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { receiptHTML } = require('../lib/render.js');

const OUT = 'seal-out';
const SKIP = new Set(['node_modules', '.git', OUT]);
const WINDOW_MS = 30 * 60 * 1000;
const VERSION = 'seal/1';

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

/** 递归收集 30 分钟内变动的文件；跳过 node_modules / .git / seal-out */
function walk(dir, base, out, now) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(abs, base, out, now); continue; }
    if (!e.isFile()) continue;
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (now - st.mtimeMs > WINDOW_MS) continue;
    out.push({ abs, rel: path.relative(base, abs).split(path.sep).join('/'), st });
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

/** 除 chain 之外的主体，用于算链哈希 */
function bodyOf(r) {
  const b = {};
  for (const k of Object.keys(r)) if (k !== 'chain') b[k] = r[k];
  return b;
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

function loadReceipt(opts) {
  const rel = typeof opts.file === 'string' && opts.file ? opts.file : path.join(OUT, 'receipt.json');
  const file = path.resolve(process.cwd(), rel);
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = r.cwd && fs.existsSync(r.cwd) ? r.cwd : path.dirname(path.dirname(file));
  return { r, file, base, html: path.join(path.dirname(file), 'receipt.html') };
}

/* ---------------- 命令 ---------------- */

function cmdSeal(opts) {
  const cwd = process.cwd();
  const nowD = new Date();
  const found = [];
  walk(cwd, cwd, found, Date.now());
  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const files = found.map((f) => ({ path: f.rel, bytes: f.st.size, sha256: sha256File(f.abs), mtime: localISO(f.st.mtime) }));
  const commands = readCommands(cwd);
  const git = readGit(cwd);
  const status = ['done', 'partial', 'blocked'].includes(opts.status) ? opts.status : 'done';

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
  };
  if (typeof opts.todo === 'string') r.todo = opts.todo;

  const prev = typeof opts.prev === 'string' ? opts.prev : '';
  r.chain = { alg: 'sha256', prev, hash: chainHash(prev, bodyOf(r)) };

  const { j, h } = writeReceipt(cwd, r);
  console.log(`已盖章：${files.length} 个文件 / ${commands.length} 条命令 / 编号 ${r.id}`);
  console.log(`  凭证 ${path.relative(cwd, j)} · 网页 ${path.relative(cwd, h)}`);
  return 0;
}

function cmdVerify(opts) {
  let ctx;
  try { ctx = loadReceipt(opts); } catch (e) {
    console.log(`不通过：读不到凭证（${e.message}）`);
    return 1;
  }
  const { r, base } = ctx;
  const fails = [];
  let pass = 0, total = 0;

  // ① 链哈希
  total++;
  const want = chainHash(r.chain && r.chain.prev, bodyOf(r));
  if (r.chain && r.chain.alg === 'sha256' && r.chain.hash === want) pass++;
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

  // ③ 声明要重跑的命令，真的重跑
  for (const c of r.commands || []) {
    if (c.recheck !== true) continue;
    total++;
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

  if (!fails.length) {
    console.log(`通过 ${pass}/${total}　凭证 ${r.id} 验真成功，现状与盖章时一致。`);
    return 0;
  }
  console.log(`不通过 ${pass}/${total}：${fails[0]}`);
  for (const m of fails.slice(1)) console.log(`  · ${m}`);
  return 1;
}

function cmdResume(opts) {
  let ctx;
  try { ctx = loadReceipt(opts); } catch (e) {
    console.log(`读不到凭证：${e.message}`);
    return 1;
  }
  let r = ctx.r;

  // --todo 写回凭证：改完必须重算链哈希，否则自己把凭证验挂了
  if (typeof opts.todo === 'string') {
    const prev = (r.chain && r.chain.prev) || '';
    const next = bodyOf(r);
    next.todo = opts.todo;
    next.chain = { alg: 'sha256', prev, hash: chainHash(prev, bodyOf(next)) };
    fs.writeFileSync(ctx.file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(path.dirname(ctx.file), 'receipt.html'), receiptHTML(next), 'utf8');
    r = next;
  }

  const L = [];
  L.push(`接管简报 · ${r.id}`);
  L.push('='.repeat(56));
  L.push(`这是什么活：${r.summary}`);
  L.push(`工作目录：${r.cwd}`);
  L.push(`做到哪一步：${r.status}　（${r.created_at} 盖章）`);
  L.push('');
  L.push(`改了哪些文件（${(r.files || []).length} 个，哈希只给前 8 位）`);
  if (!r.files || !r.files.length) L.push('  （无文件变动）');
  for (const f of r.files || []) L.push(`  - ${f.path}  ${f.bytes} B  ${short(f.sha256).replace('…', '')}`);
  L.push('');
  const cs = r.commands || [];
  L.push(`验过什么（${cs.length} 条命令）`);
  if (!cs.length) L.push('  （没有命令记录）');
  for (const c of cs) L.push(`  - ${c.cmd}　退出 ${c.exit === null ? '—' : c.exit}　${c.ms === null ? '—' : c.ms + ' ms'}　输出指纹 ${short(c.out_sha256)}`);
  L.push('');
  L.push(`还没做的 / 下一步：${r.todo || '未声明'}`);
  L.push('');
  L.push(`接手提示：先跑 node bin\\seal.js verify --file ${path.join(OUT, 'receipt.json')} 确认现状没被动过，再按上面「下一步」继续。`);
  const text = L.join('\n');
  console.log(text);
  return 0;
}

function cmdShow(opts) {
  let ctx;
  try { ctx = loadReceipt(opts); } catch (e) {
    console.log(`读不到凭证：${e.message}`);
    return 1;
  }
  const html = ctx.html;
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'seal';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(`seal · 给 agent 干的活盖章

  node bin\\seal.js [--summary 一句话] [--status done|partial|blocked] [--todo 下一步] [--prev 上一段哈希]
  node bin\\seal.js verify [--file 路径]
  node bin\\seal.js resume [--file 路径]
  node bin\\seal.js show   [--file 路径]

产物：seal-out\\receipt.json（可验）、seal-out\\receipt.html（可打印）
`);
    return 0;
  }
  if (cmd === 'seal') return cmdSeal(opts);
  if (cmd === 'verify') return cmdVerify(opts);
  if (cmd === 'resume') return cmdResume(opts);
  if (cmd === 'show') return cmdShow(opts);
  console.log(`不认识的命令：${cmd}（可用：seal / verify / resume / show）`);
  return 1;
}

process.exitCode = main();
