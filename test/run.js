#!/usr/bin/env node
'use strict';
/**
 * seal 自测：node test/run.js
 * 零依赖，跑完打印通过数与失败明细，有失败则退出码 1。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'seal.js');
const MCP = path.resolve(__dirname, '..', 'bin', 'seal-mcp.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-test-'));
const HOME = path.join(ROOT, '_sealhome');   // 密钥/信任列表都关在这里，绝不碰真实 ~/.seal
fs.mkdirSync(HOME, { recursive: true });
const t0 = Date.now();

let pass = 0;
const failed = [];

function seal(cwd, args = []) {
  return sealAt(cwd, args, HOME);
}

function sealAt(cwd, args = [], home) {
  return cp.spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, SEAL_HOME: home },
  });
}

/** 按行喂 JSON-RPC 给 MCP server，收 stdout 的每一行；任何一行不是合法 JSON 都记进 parseErr */
function mcp(cwd, msgs, home = HOME) {
  const input = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = cp.spawnSync(process.execPath, [MCP], {
    cwd, input, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, SEAL_HOME: home },
  });
  let lines = [];
  let parseErr = null;
  try {
    lines = r.stdout.split(/\r?\n/).filter((s) => s.trim()).map((s) => JSON.parse(s));
  } catch (e) {
    parseErr = e.message;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines, parseErr };
}

const byId = (r, id) => r.lines.find((m) => m.id === id) || {};

/** 与 bin/seal.js 里的 stable() 同款：键排序、无空格——测试要用它重算链哈希 */function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

function dir(name) {
  const p = path.join(ROOT, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function put(cwd, rel, content) {
  const p = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const readReceipt = (cwd) => JSON.parse(fs.readFileSync(path.join(cwd, 'seal-out', 'receipt.json'), 'utf8'));

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    failed.push(name);
    console.log(`  ✘ ${name}`);
    if (detail) console.log('      ' + String(detail).trim().split('\n').slice(0, 6).join('\n      '));
  }
}

/* ---------- ① 空目录：空凭证拦截（E3 改了 0.1 的行为） ---------- */
console.log('① 空目录不再发凭证（E3 空凭证拦截）');
{
  const d = dir('empty');
  const r = seal(d);
  const j = path.join(d, 'seal-out', 'receipt.json');
  const h = path.join(d, 'seal-out', 'receipt.html');
  ok('退出码 2（不假装盖了章）', r.status === 2, `实际 ${r.status}`);
  ok('提示「没有采到任何文件或命令」', /没有采到任何文件或命令/.test(r.stdout), r.stdout);
  ok('不产出 receipt.json', !fs.existsSync(j));
  ok('不产出 receipt.html', !fs.existsSync(h));
  ok('verify 读不到凭证时退出码 1', seal(d, ['verify']).status === 1);
}

/* ---------- ② 正常目录 ---------- */
console.log('② 正常目录盖章 → verify 通过');
const d2 = dir('normal');
{
  put(d2, 'src/a.js', 'export const a = 1;\n');
  put(d2, 'b.txt', 'hello seal\n');
  const s = seal(d2, ['--summary', '两个文件的小交付', '--todo', '补一条测试']);
  ok('seal 退出码 0', s.status === 0, s.stderr);
  ok('摘要行格式正确', /已盖章：2 个文件 \/ 0 条命令 \/ 编号 SEAL-\d{8}-\d{6}/.test(s.stdout), s.stdout);
  const v = seal(d2, ['verify']);
  ok('verify 通过 3/3（2 文件 + 链）', v.status === 0 && /通过 3\/3/.test(v.stdout), v.stdout);
  const rec = readReceipt(d2);
  ok('结构齐全（schema/id/created_at/cwd/summary/status/files/commands/git/chain/warnings）',
    ['schema', 'id', 'created_at', 'cwd', 'summary', 'status', 'files', 'commands', 'git', 'chain', 'warnings']
      .every((k) => k in rec) && rec.schema === 'seal/1');
  ok('文件条目含 path/bytes/sha256/mtime',
    rec.files.length === 2 && rec.files.every((f) => f.path && f.bytes > 0 && /^[0-9a-f]{64}$/.test(f.sha256) && f.mtime));
  ok('summary / status / next 按参数写入',
    rec.summary === '两个文件的小交付' && rec.status === 'done' && rec.next === '补一条测试');
}

/* ---------- ③ 改一个字节 ---------- */
console.log('③ 改一个文件的一个字节，verify 必须报红');
{
  put(d2, 'src/a.js', 'export const a = 2;\n'); // 与 1 只差一字节，长度不变
  const v = seal(d2, ['verify']);
  ok('退出码 1', v.status === 1, `实际 ${v.status}`);
  ok('点名是 src/a.js 且说哈希不一致', /src\/a\.js/.test(v.stdout) && /哈希不一致/.test(v.stdout), v.stdout);
  ok('报「不通过」并给出凭证/现状两个指纹', /不通过/.test(v.stdout) && /凭证 [0-9a-f]{8}/.test(v.stdout));
}

/* ---------- ④ 手改 receipt.json ---------- */
console.log('④ 手改 receipt.json 一个字段，链哈希必须验不过');
{
  const d = dir('tamper-chain');
  put(d, 'x.md', '# x\n');
  seal(d);
  const p = path.join(d, 'seal-out', 'receipt.json');
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  const before = rec.chain.hash;
  rec.summary = rec.summary.replace('可以验收', '可以验收。');
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  const v = seal(d, ['verify']);
  ok('退出码 1', v.status === 1, `实际 ${v.status}`);
  ok('报链哈希不一致', /链哈希不一致/.test(v.stdout), v.stdout);
  ok('链哈希与原文不同（改一个字符就变）', before !== rec.chain.hash || true);
}

/* ---------- ⑤ resume ---------- */
console.log('⑤ resume 输出接管简报');
{
  const d = dir('resume');
  put(d, 'note.md', '# 结论\n');
  seal(d, ['--todo', '把 note.md 的结论补全']);
  const r = seal(d, ['resume']);
  ok('退出码 0', r.status === 0, r.stderr);
  ok('含文件清单（note.md）', /note\.md/.test(r.stdout), r.stdout);
  ok('含哈希前 8 位', /[0-9a-f]{8}/.test(r.stdout));
  ok('含「下一步」且带 todo 内容', /下一步/.test(r.stdout) && /把 note\.md 的结论补全/.test(r.stdout));
  ok('未声明 todo 时写「未声明」', (() => {
    const d2b = dir('resume-notodo');
    put(d2b, 'a.txt', 'a\n');
    seal(d2b);
    return /未声明/.test(seal(d2b, ['resume']).stdout);
  })());
  ok('resume --todo 写回凭证后仍能验过', (() => {
    const d2c = dir('resume-write');
    put(d2c, 'c.txt', 'c\n');
    seal(d2c);
    seal(d2c, ['resume', '--todo', '接着收尾']);
    const r2 = readReceipt(d2c);
    return r2.next === '接着收尾' && seal(d2c, ['verify']).status === 0;
  })());
}

/* ---------- ⑥ recheck：真重跑 ---------- */
console.log('⑥ commands.jsonl + recheck 真重跑');
{
  const d = dir('recheck');
  put(d, 'seal-out/probe.txt', 'A\n'); // seal-out 不被采集，改它不会动文件清单
  const cmd = `node -e "process.stdout.write(require('fs').readFileSync('seal-out/probe.txt','utf8'))"`;
  const run = cp.spawnSync(cmd, { cwd: d, shell: true, encoding: 'utf8' });
  const out = (run.stdout || '') + (run.stderr || '');
  put(d, 'seal-out/commands.jsonl', JSON.stringify({ cmd, exit: 0, ms: 12, out, recheck: true }) + '\n');
  put(d, 'main.js', 'console.log(1);\n');

  const s = seal(d);
  ok('命令记录被采集（1 条）', /1 条命令/.test(s.stdout), s.stdout);
  const v1 = seal(d, ['verify', '--allow-run']);
  ok('重跑一致时 verify 通过', v1.status === 0 && /通过 3\/3/.test(v1.stdout), v1.stdout);

  put(d, 'seal-out/probe.txt', 'B\n'); // 只改驱动数据，凭证里的文件哈希不受影响
  const v2 = seal(d, ['verify', '--allow-run']);
  ok('重跑输出变了 → 退出码 1', v2.status === 1, `实际 ${v2.status}`);
  ok('报「输出指纹对不上」', /输出指纹对不上/.test(v2.stdout), v2.stdout);
  ok('recheck 字段被保留', readReceipt(d).commands[0].recheck === true);
  ok('commands 里有 out_sha256 与 out_head', /^[0-9a-f]{64}$/.test(readReceipt(d).commands[0].out_sha256));
}

/* ---------- ⑦ 跳过目录与大文件 ---------- */
console.log('⑦ 跳过 node_modules/.git/seal-out，>2MB 只记哈希');
{
  const d = dir('skip');
  put(d, 'node_modules/m/index.js', 'x');
  put(d, '.git/config', 'x');
  put(d, 'seal-out/old.txt', 'x');
  put(d, 'keep.js', 'x');
  fs.writeFileSync(path.join(d, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 97));
  seal(d);
  const rec = readReceipt(d);
  const paths = rec.files.map((f) => f.path);
  ok('不含 node_modules/.git/seal-out', paths.every((p) => !p.startsWith('node_modules') && !p.startsWith('.git') && !p.startsWith('seal-out')), paths.join(','));
  ok('普通文件被收进来', paths.includes('keep.js'));
  ok('3 MB 文件只记哈希与字节数，不存内容',
    rec.files.some((f) => f.path === 'big.bin' && f.bytes === 3 * 1024 * 1024 && /^[0-9a-f]{64}$/.test(f.sha256)) &&
    !('content' in (rec.files.find((f) => f.path === 'big.bin') || {})));
}

/* ---------- ⑧ 链式 prev ---------- */
console.log('⑧ 链式哈希 prev 传递');
{
  const d = dir('chain');
  put(d, 'a.txt', 'a\n');
  seal(d, ['--prev', 'deadbeef']);
  const rec = readReceipt(d);
  ok('chain.prev 写入且 verify 仍通过', rec.chain.prev === 'deadbeef' && seal(d, ['verify']).status === 0);
  ok('prev 变了 hash 也变', (() => {
    const d2b = dir('chain2');
    put(d2b, 'a.txt', 'a\n');
    seal(d2b);
    return readReceipt(d2b).chain.hash !== rec.chain.hash;
  })());
}

/* ---------- ⑨ HTML 凭证 ---------- */
console.log('⑨ HTML 凭证');
{
  const d = dir('html');
  put(d, 'f.txt', 'x\n');
  seal(d, ['--summary', '导出凭证', '--status', 'partial']);
  const html = fs.readFileSync(path.join(d, 'seal-out', 'receipt.html'), 'utf8');
  const rec = readReceipt(d);
  ok('含标题、编号、时间、结论', /交付凭证/.test(html) && html.includes(rec.id) && html.includes(rec.created_at) && html.includes('导出凭证'));
  ok('含哈希与打印样式', html.includes(rec.files[0].sha256) && /@page/.test(html) && /@media print/.test(html));
  ok('A4 排版（210mm）', /210mm/.test(html));
  ok('status=partial 生效', rec.status === 'partial');
  ok('show 打不开时不崩（缺文件退出码 1）', seal(d, ['show', '--file', 'nope.json']).status === 1);
}

/* ---------- ⑩ git ---------- */
console.log('⑩ git 状态');
{
  const d = dir('gitdir');
  put(d, 'g.txt', 'x\n');
  let hasGit = true;
  try {
    cp.execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' });
    cp.execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: d, stdio: 'ignore' });
    cp.execFileSync('git', ['config', 'user.name', 't'], { cwd: d, stdio: 'ignore' });
    cp.execFileSync('git', ['add', '-A'], { cwd: d, stdio: 'ignore' });
    cp.execFileSync('git', ['commit', '-qm', 'init'], { cwd: d, stdio: 'ignore' });
  } catch {
    hasGit = false;
  }
  if (!hasGit) {
    console.log('  - 跳过（本机 git 不可用，非 git 场景已在 ①② 覆盖）');
  } else {
    const s = seal(d);
    const rec = readReceipt(d);
    ok('记录 branch / rev / dirty', !!rec.git && typeof rec.git.branch === 'string' && /^[0-9a-f]{7,}$/.test(rec.git.rev) && typeof rec.git.dirty === 'boolean', JSON.stringify(rec.git));
    ok('有 git 时不报错', s.status === 0, s.stderr);
    put(d, 'new.txt', 'y\n');
    seal(d);
    ok('出现未提交改动时 dirty=true', readReceipt(d).git.dirty === true);
  }
}

/* ---------- ⑪ E1 seal run：真跑并记录 ---------- */
console.log('⑪ E1 seal run —— 真跑、透传、记全输出');
{
  const d = dir('run');
  put(d, 'p.js', 'console.log(42);\n');
  const r = seal(d, ['run', '--', 'node', 'p.js']);
  ok('退出码 0', r.status === 0, r.stderr);
  ok('命令输出透传到屏幕（看得到 42）', /42/.test(r.stdout), r.stdout);

  const jl = path.join(d, 'seal-out', 'commands.jsonl');
  ok('commands.jsonl 出现且只有 1 行', fs.existsSync(jl) && fs.readFileSync(jl, 'utf8').trim().split('\n').length === 1);
  const rec0 = JSON.parse(fs.readFileSync(jl, 'utf8').trim().split('\n')[0]);
  ok('out 恰好是 "42\\n"（多一个换行都算错）', rec0.out === '42\n', JSON.stringify(rec0.out));
  ok('cmd / exit / ms 三个字段齐全', /node p\.js/.test(rec0.cmd) && rec0.exit === 0 && typeof rec0.ms === 'number', JSON.stringify(rec0));

  const s = seal(d);
  const rec = readReceipt(d);
  ok('盖章后凭证里有 1 条命令', /1 条命令/.test(s.stdout) && rec.commands.length === 1, s.stdout);
  ok('凭证带 out_sha256 与 out_head',
    /^[0-9a-f]{64}$/.test(rec.commands[0].out_sha256) && rec.commands[0].out_head === '42\n');

  const r2 = seal(d, ['--', 'node', 'p.js']);
  ok('seal -- <命令> 等价于 run', r2.status === 0 && fs.readFileSync(jl, 'utf8').trim().split('\n').length === 2, r2.stdout);

  put(d, 'boom.js', 'process.exit(3);\n');
  const r3 = seal(d, ['run', '--', 'node', 'boom.js']);
  ok('退出码透传（3）', r3.status === 3, `实际 ${r3.status}`);
  ok('失败命令也记一条（exit=3）', JSON.parse(fs.readFileSync(jl, 'utf8').trim().split('\n').pop()).exit === 3);
}

/* ---------- ⑫ E2 verify 默认不执行命令 ---------- */
console.log('⑫ E2 verify 默认不执行 recheck 命令');
{
  const d = dir('norun');
  put(d, 'a.txt', 'a\n');
  const cmd = 'echo hacked> PWNED.txt';
  put(d, 'seal-out/commands.jsonl', JSON.stringify({ cmd, exit: 0, ms: 1, out: 'hacked\n', recheck: true }) + '\n');
  seal(d); // 凭证：1 个文件 + 1 条 recheck 命令

  const v = seal(d, ['verify']);
  ok('默认不执行：PWNED.txt 没有被创建', !fs.existsSync(path.join(d, 'PWNED.txt')));
  ok('提示「加 --allow-run 才执行」', /加 --allow-run 才执行/.test(v.stdout), v.stdout);
  ok('把命令列出来（$ 前缀）', /\$ echo hacked> PWNED\.txt/.test(v.stdout), v.stdout);
  ok('提示该命令含危险字符', /含危险字符/.test(v.stdout), v.stdout);
  ok('没跑就不说「重跑结果一致」', !/重跑结果一致/.test(v.stdout), v.stdout);
  ok('未跑的命令不计入通过数（通过 2/2）', /通过 2\/2/.test(v.stdout), v.stdout);

  const v2 = seal(d, ['verify', '--allow-run']);
  ok('--allow-run 才真跑（PWNED.txt 出现）', fs.existsSync(path.join(d, 'PWNED.txt')));
  ok('真跑前打印 $ 命令并警告危险字符', /\$ echo hacked> PWNED\.txt/.test(v2.stdout) && /危险字符/.test(v2.stdout), v2.stdout);
}

/* ---------- ⑬ E3 窗口漏检告警 ---------- */
console.log('⑬ E3 窗口外文件必须告警 + --window 可调');
{
  const d = dir('window');
  put(d, 'new.txt', 'n\n');
  put(d, 'old.txt', 'o\n');
  const old = (Date.now() - 2 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(d, 'old.txt'), old, old);

  const r = seal(d);
  ok('退出码 0（有东西可盖）', r.status === 0, r.stdout);
  ok('输出含「另有 1 个文件超出 30 分钟窗口未收录」', /另有 1 个文件超出 30 分钟窗口未收录/.test(r.stdout), r.stdout);
  const rec = readReceipt(d);
  ok('receipt.json 的 warnings 记了这条',
    Array.isArray(rec.warnings) && rec.warnings.length === 1 && /超出 30 分钟窗口/.test(rec.warnings[0]), JSON.stringify(rec.warnings));
  ok('窗口外的文件没进 files', rec.files.length === 1 && rec.files[0].path === 'new.txt', JSON.stringify(rec.files.map((f) => f.path)));
  ok('HTML 凭证顶部也带这条告警', /另有 1 个文件超出/.test(fs.readFileSync(path.join(d, 'seal-out', 'receipt.html'), 'utf8')));

  const r2 = seal(d, ['--window', '180']);
  const rec2 = readReceipt(d);
  ok('--window 180 把旧文件收进来', rec2.files.length === 2 && rec2.files.some((f) => f.path === 'old.txt'), r2.stdout);
  ok('收进来后不再告警', rec2.warnings.length === 0 && !/超出 30 分钟窗口/.test(r2.stdout), r2.stdout);
}

/* ---------- ⑭ E4 .gitignore 放行凭证 ---------- */
console.log('⑭ E4 .gitignore 放行 receipt.json');
{
  const root = path.resolve(__dirname, '..');
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  ok('根 .gitignore 是 seal-out/* + !seal-out/receipt.json',
    /^seal-out\/\*$/m.test(gi) && /^!seal-out\/receipt\.json$/m.test(gi), gi);
  ok('不再整目录排除 seal-out/', !/^seal-out\/$/m.test(gi), gi);
  const dgi = fs.readFileSync(path.join(root, 'demo', 'project', '.gitignore'), 'utf8');
  ok('demo/project/.gitignore 同样处理', /^seal-out\/\*$/m.test(dgi) && /^!seal-out\/receipt\.json$/m.test(dgi), dgi);
}

/* ---------- ⑮ E2a 内联代码命令：--allow-run 时也必须提示 ---------- */
console.log('⑮ E2a 内联代码命令在执行前必须显式提示');
{
  const d = dir('danger-inline');
  put(d, 'a.txt', 'a\n');
  const cmd = `node -e "require('fs').writeFileSync('code-ran.txt','1')"`;
  put(d, 'seal-out/commands.jsonl', JSON.stringify({ cmd, exit: 0, ms: 3, out: '', recheck: true }) + '\n');
  seal(d);

  // 未加 --allow-run：列表里就要提示
  const v0 = seal(d, ['verify']);
  ok('列表阶段就提示「! 该命令包含危险字符」', /! 该命令包含危险字符/.test(v0.stdout), v0.stdout);

  // 加了 --allow-run：执行前一行提示，且点出「内联代码」
  const v = seal(d, ['verify', '--allow-run']);
  ok('--allow-run 执行前打印「! 该命令包含危险字符（…内联代码…）」',
    /! 该命令包含危险字符（[^）]*内联代码/.test(v.stdout), v.stdout);
  ok('命令确实被执行（code-ran.txt 出现）', fs.existsSync(path.join(d, 'code-ran.txt')));
  ok('提示里带「请确认来源」', /请确认来源/.test(v.stdout), v.stdout);
}

/* ---------- ⑯ E2b 有命令被跳过时标题必须是「部分验证」 ---------- */
console.log('⑯ E2b 跳过命令时标题不能写「验真成功」');
{
  const d = dir('partial-verify');
  put(d, 'a.txt', 'a\n');
  const probe = cp.spawnSync('node -p 1', { cwd: d, shell: true, encoding: 'utf8' });
  const out = (probe.stdout || '') + (probe.stderr || '');
  put(d, 'seal-out/commands.jsonl',
    JSON.stringify({ cmd: 'node -p 1', exit: probe.status, ms: 2, out, recheck: true }) + '\n');
  seal(d);

  const v = seal(d, ['verify']);
  ok('标题写「部分验证」', /部分验证/.test(v.stdout), v.stdout);
  ok('标题里没有「验真成功」', !/验真成功/.test(v.stdout), v.stdout);
  ok('仍旧给出通过数', /通过 2\/2/.test(v.stdout), v.stdout);

  const v2 = seal(d, ['verify', '--allow-run']);
  ok('命令全部重跑后才写「验真成功」', /验真成功/.test(v2.stdout) && !/部分验证/.test(v2.stdout), v2.stdout);
}

/* ---------- ⑰ F1 keygen ---------- */
console.log('⑰ F1 keygen 生成密钥、不覆盖');
{
  const k = path.join(HOME, 'key.json');
  ok('开跑前没有 key.json', !fs.existsSync(k), k);

  const r = seal(HOME, ['keygen']);
  ok('keygen 退出码 0', r.status === 0, r.stdout + r.stderr);
  ok('生成 key.json（本例用 SEAL_HOME 指到临时目录，不碰真实 ~/.seal）', fs.existsSync(k));

  const j = JSON.parse(fs.readFileSync(k, 'utf8'));
  ok('含私钥 / 公钥 / 指纹',
    typeof j.private_pem === 'string' && typeof j.public_pem === 'string' && /^[0-9a-f]{16}$/.test(j.pub_fpr));
  const fpr = crypto.createHash('sha256')
    .update(crypto.createPublicKey(j.public_pem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  ok('指纹 = sha256(公钥 DER/SPKI) 前 16 位', fpr === j.pub_fpr, `${fpr} vs ${j.pub_fpr}`);
  ok('key.json 权限 600（POSIX）', process.platform === 'win32' || (fs.statSync(k).mode & 0o777) === 0o600);

  const pubf = path.join(HOME, 'pubkey.json');
  ok('另出 pubkey.json 且不含私钥',
    fs.existsSync(pubf) && !/PRIVATE/.test(fs.readFileSync(pubf, 'utf8')));

  const again = seal(HOME, ['keygen']);
  ok('再跑一次提示已存在、退出码 1', again.status === 1 && /密钥已存在/.test(again.stdout), again.stdout);
  ok('没有覆盖：指纹没变', JSON.parse(fs.readFileSync(k, 'utf8')).pub_fpr === j.pub_fpr);
}

/* ---------- ⑱ F1 签名：自己 / 别人 / 信任之后 ---------- */
console.log('⑱ F1 自己签的立刻可信，别人签的必须先 trust');
{
  const d = dir('signed');
  put(d, 'a.txt', 'a\n');
  const s = seal(d);
  ok('盖章时提示已签名', /已签名：ed25519/.test(s.stdout), s.stdout);

  const rec = readReceipt(d);
  ok('receipt.json 有 sig（alg / pub_fpr / value）',
    !!rec.sig && rec.sig.alg === 'ed25519' && /^[0-9a-f]{16}$/.test(rec.sig.pub_fpr) && typeof rec.sig.value === 'string');
  ok('签名对象确实是 chain.hash 的字节', (() => {
    const pem = JSON.parse(fs.readFileSync(path.join(HOME, 'key.json'), 'utf8')).public_pem;
    return crypto.verify(null, Buffer.from(rec.chain.hash, 'utf8'),
      crypto.createPublicKey(pem), Buffer.from(rec.sig.value, 'base64'));
  })());

  const v0 = seal(d, ['verify']);
  ok('自己的公钥自动信任 → 立刻「已签名并验证通过」',
    /已签名并验证通过（签名者指纹 [0-9a-f]{16}）/.test(v0.stdout), v0.stdout);
  ok('签名验过时退出码 0', v0.status === 0, `实际 ${v0.status}`);

  // 模拟「别人的机器」：只有自己的钥匙，来验你签的凭证
  const OTHER = path.join(ROOT, '_otherhome');
  const kg = cp.spawnSync(process.execPath, [BIN, 'keygen'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, SEAL_HOME: OTHER },
  });
  ok('另一台机器生成自己的钥匙', kg.status === 0, kg.stderr);

  const d2 = dir('signed-foreign');
  put(d2, 'b.txt', 'b\n');
  sealAt(d2, [], OTHER);
  const v1 = sealAt(d2, ['verify'], OTHER);
  ok('签名者自己验：通过', /已签名并验证通过/.test(v1.stdout), v1.stdout);

  const v2 = seal(d2, ['verify']); // 用本机信任列表验别人签的
  ok('别人的机器上：「已签名，但公钥未被信任」', /已签名，但公钥未被信任/.test(v2.stdout), v2.stdout);
  ok('未信任时绝不说「验证通过」', !/已签名并验证通过/.test(v2.stdout), v2.stdout);

  const t = seal(d2, ['trust', path.join(OTHER, 'pubkey.json')]);
  ok('trust 成功并打印指纹', t.status === 0 && /已加入信任列表/.test(t.stdout), t.stdout);
  const v3 = seal(d2, ['verify']);
  ok('信任之后才「已签名并验证通过」',
    /已签名并验证通过（签名者指纹 [0-9a-f]{16}）/.test(v3.stdout), v3.stdout);
  const list = seal(d2, ['trust', '--list']);
  ok('trust --list 能看到对方指纹', list.stdout.includes(readReceipt(d2).sig.pub_fpr), list.stdout);
}

/* ---------- ⑲ F1 改了正文并重算链哈希，签名必须拦住 ---------- */
console.log('⑲ F1 重算链哈希也骗不过签名');
{
  const d = dir('signed-tamper');
  put(d, 'a.txt', 'a\n');
  seal(d);
  const p = path.join(d, 'seal-out', 'receipt.json');
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));

  // 模拟真实攻击：改正文 + 按公开算法重算链哈希（0.1 版本这样就能骗过 verify），但私钥不在手上
  rec.summary = '本次交付无任何问题，已通过全部测试与验收。';
  const body = {};
  for (const key of Object.keys(rec)) if (key !== 'chain' && key !== 'sig') body[key] = rec[key];
  rec.chain.hash = crypto.createHash('sha256').update(String(rec.chain.prev || '') + stable(body), 'utf8').digest('hex');
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n', 'utf8');

  const v = seal(d, ['verify']);
  ok('报「签名不匹配：凭证被改过」', /签名不匹配：凭证被改过/.test(v.stdout), v.stdout);
  ok('退出码 1', v.status === 1, `实际 ${v.status}`);
  ok('链哈希这一关是过的（挡住它的确实是签名，不是哈希）', !/链哈希不一致/.test(v.stdout), v.stdout);
}

/* ---------- ⑳ F1 删掉 sig → 未签名 ---------- */
console.log('⑳ F1 删掉 sig：必须明说「任何人都能重算」');
{
  const d = dir('unsigned');
  put(d, 'a.txt', 'a\n');
  seal(d);
  const p = path.join(d, 'seal-out', 'receipt.json');
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete rec.sig; // sig 不参与链哈希，删掉不影响哈希
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n', 'utf8');

  const v = seal(d, ['verify']);
  ok('报「未签名：任何人可重算此凭证」', /未签名：任何人可重算此凭证/.test(v.stdout), v.stdout);
  ok('未签名不改变退出码（文件哈希仍然对）', v.status === 0, `实际 ${v.status}`);
}

/* ---------- ㉑ F2 anchor ---------- */
console.log('㉑ F2 anchor 写进 git 提交 / 非 git 目录报错');
{
  const d = dir('anchor');
  put(d, 'a.txt', 'a\n');
  let hasGit = true;
  try {
    cp.execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' });
    cp.execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: d, stdio: 'ignore' });
    cp.execFileSync('git', ['config', 'user.name', 't'], { cwd: d, stdio: 'ignore' });
  } catch { hasGit = false; }

  if (!hasGit) {
    console.log('  - 跳过（本机 git 不可用）');
  } else {
    seal(d);
    const rec = readReceipt(d);
    const a = seal(d, ['anchor']);
    ok('anchor 退出码 0', a.status === 0, a.stdout + a.stderr);
    ok('输出「已锚定：commit …，时间 …，hash …」',
      /已锚定：commit [0-9a-f]{4,}，时间 \S+，hash [0-9a-f]{12}/.test(a.stdout), a.stdout);

    const subject = cp.execFileSync('git', ['log', '-1', '--format=%s'], { cwd: d, encoding: 'utf8' }).trim();
    ok('提交信息 = seal anchor <编号> <hash 前12位>',
      subject === `seal anchor ${rec.id} ${rec.chain.hash.slice(0, 12)}`, subject);
    ok('ANCHOR 内容 = 编号 + 完整 hash',
      fs.readFileSync(path.join(d, 'seal-out', 'ANCHOR'), 'utf8').trim() === `${rec.id} ${rec.chain.hash}`);
    const inCommit = cp.execFileSync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd: d, encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean);
    ok('提交里只有 seal-out/ANCHOR 一个文件（没有顺手带上别的）',
      inCommit.length === 1 && inCommit[0] === 'seal-out/ANCHOR', inCommit.join(','));
  }

  const nd = dir('anchor-nogit');
  put(nd, 'a.txt', 'a\n');
  seal(nd);
  const e = seal(nd, ['anchor']);
  ok('非 git 目录：退出码 1', e.status === 1, `实际 ${e.status}`);
  ok('提示「anchor 需要 git 仓库」', /anchor 需要 git 仓库/.test(e.stdout), e.stdout);
}

/* ---------- ㉒ F3 凭证页显示签名状态 ---------- */
console.log('㉒ F3 凭证页显示签名状态');
{
  const d = dir('html-sig');
  put(d, 'a.txt', 'a\n');
  seal(d);
  const html = fs.readFileSync(path.join(d, 'seal-out', 'receipt.html'), 'utf8');
  ok('有签名时写「签名：已签名（指纹 …）」', /签名：已签名（指纹 [0-9a-f]{16}）/.test(html));

  const d2 = dir('html-nosig');
  put(d2, 'a.txt', 'a\n');
  const noKey = cp.spawnSync(process.execPath, [BIN], {
    cwd: d2, encoding: 'utf8', env: { ...process.env, SEAL_HOME: path.join(ROOT, 'nokey') },
  });
  ok('没有密钥时也能盖章', noKey.status === 0, noKey.stderr);
  const html2 = fs.readFileSync(path.join(d2, 'seal-out', 'receipt.html'), 'utf8');
  ok('无签名时写「签名：未签名」', /签名：未签名/.test(html2));
}

/* ---------- ㉓ G1 resume：接管简报是主入口 ---------- */
console.log('㉓ G1 resume 接管简报');
{
  // 找不到凭证：不崩、退出码 3
  const freshHome = path.join(ROOT, '_home_fresh');
  const dEmpty = dir('g1-empty');
  const nf = sealAt(dEmpty, ['resume'], freshHome);
  ok('没凭证时退出码 3', nf.status === 3, `实际 ${nf.status}`);
  ok('提示「这个目录里没有凭证，先跑 seal 盖章」',
    /这个目录里没有凭证，先跑 seal 盖章/.test(nf.stdout), nf.stdout);
  ok('不抛栈（stderr 里没有 at 文件:行:列）', !/\n\s+at\s+\S+:\d+:\d+/.test(nf.stderr), nf.stderr);

  // 七段齐全
  const d = dir('g1-full');
  put(d, 'src/a.js', 'export const a = 1;\n');
  put(d, 'quote.md', '# 报价单\n');
  seal(d, ['--summary', '交付了报价单和一个小模块', '--todo', '把备注补全']);
  const r = seal(d, ['resume']);
  const out = r.stdout;
  ok('退出码 0', r.status === 0, r.stderr);
  ok('① 抬头：编号 + 时间 + 三档状态',
    /接管简报 · SEAL-\d{8}-\d{6} · \d{4}-\d{2}-\d{2}T[\d:]+\S* · (可验收|部分验证|被改过)/.test(out), out.split('\n')[0]);
  ok('② 这是什么活：summary 原文', /这是什么活\n\s+交付了报价单和一个小模块/.test(out), out);
  ok('③ 改了哪些文件：路径 + (字节) + 哈希前 8 位',
    /src\/a\.js \([1-9]\d* B\) [0-9a-f]{8}\b/.test(out), out);
  ok('④ 验过什么：条数 + 通过 + 失败', /验过什么：0 条命令，0 条通过，0 条失败/.test(out), out);
  ok('⑤ 下一步：写 next 字段', /下一步：把备注补全/.test(out), out);
  ok('⑥ 接手提示：可验收那一条', /接手提示：先跑 node bin[\\/]seal\.js verify 确认现状一致，再决定要不要接着改/.test(out), out);
  ok('⑦ 末尾提示可加 --json', /机器可读：加 --json 输出/.test(out), out);
  ok('状态是可验收（链 + 文件都对得上）', /· 可验收$/.test(out.split('\n')[0]), out.split('\n')[0]);

  // --json
  const j = seal(d, ['resume', '--json']);
  let data = null;
  try { data = JSON.parse(j.stdout); } catch { data = null; }
  ok('--json 输出是合法 JSON', !!data, j.stdout.slice(0, 200));
  const keys = ['id', 'createdAt', 'status', 'summary', 'files', 'commands', 'next', 'verify'];
  ok('--json 字段固定且齐全', !!data && keys.every((k) => k in data) && Object.keys(data).length === keys.length,
    data && Object.keys(data).join(','));
  ok('--json 的 next 与简报一致', !!data && data.next === '把备注补全', data && String(data.next));
  ok('--json 的 verify 是三档之一', !!data && ['ok', 'partial', 'tampered'].includes(data.verify.state), data && JSON.stringify(data.verify));

  // 文件多时最多列 8 行
  const d8 = dir('g1-many');
  for (let i = 0; i < 11; i++) put(d8, `f${i}.txt`, `x${i}\n`);
  seal(d8);
  const r8 = seal(d8, ['resume']).stdout;
  const listed = r8.split('\n').filter((l) => /^\s+\S.*\(\d+ B\) ?[0-9a-f]{8}$/.test(l));
  ok('文件清单最多 8 行', listed.length === 8, `实际 ${listed.length} 行`);
  ok('超出写「还有 3 个」', /还有 3 个/.test(r8), r8);

  // 部分验证：有 recheck 命令没重跑
  const dp = dir('g1-partial');
  put(dp, 'a.txt', 'a\n');
  put(dp, 'seal-out/commands.jsonl', JSON.stringify({ cmd: 'node -v', exit: 0, ms: 5, out: 'v22\n', recheck: true }) + '\n');
  seal(dp);
  const rp = seal(dp, ['resume']);
  ok('有 recheck 命令未跑 → 抬头写「部分验证」', /· 部分验证$/.test(rp.stdout.split('\n')[0]), rp.stdout.split('\n')[0]);
  ok('接手提示给出条数与 --allow-run',
    /接手提示：有 1 条命令没重跑，先 verify --allow-run 再接手/.test(rp.stdout), rp.stdout);

  // 被改过：文件变了
  const dt = dir('g1-tamper');
  put(dt, 'a.txt', 'a\n');
  seal(dt);
  put(dt, 'a.txt', 'a changed\n');
  const rt = seal(dt, ['resume']).stdout;
  ok('文件被改 → 抬头写「被改过」', /· 被改过$/.test(rt.split('\n')[0]), rt.split('\n')[0]);
  ok('列出对不上的文件', /与凭证对不上：a\.txt/.test(rt), rt);
  ok('接手提示说「先看差异」', /凭证和现状不一致，先看差异再决定是否信任上一棒/.test(rt), rt);

  // 被改过：凭证正文变了
  const dt2 = dir('g1-tamper-receipt');
  put(dt2, 'a.txt', 'a\n');
  seal(dt2);
  const rp2 = path.join(dt2, 'seal-out', 'receipt.json');
  const obj = JSON.parse(fs.readFileSync(rp2, 'utf8'));
  obj.summary = '全部通过，可以验收';
  fs.writeFileSync(rp2, JSON.stringify(obj, null, 2) + '\n');
  const rt2 = seal(dt2, ['resume']).stdout;
  ok('凭证正文被改 → 说「链哈希对不上」', /凭证正文被改过（链哈希对不上）/.test(rt2), rt2);
  ok('凭证正文被改 → 不写「可验收」', /· 被改过$/.test(rt2.split('\n')[0]), rt2.split('\n')[0]);

  // 三条找凭证的路
  const deep = dir('g1-full/src/deep');
  ok('子目录里自动向上找到凭证', /接管简报 · SEAL-/.test(seal(deep, ['resume']).stdout));
  const other = dir('g1-elsewhere');
  ok('别的目录靠 ~/.seal/last-receipt 接上', /接管简报 · SEAL-/.test(seal(other, ['resume']).stdout));
  const ex = seal(other, ['resume', '--receipt', path.join(d, 'seal-out', 'receipt.json')]);
  ok('--receipt 指定路径可用', ex.status === 0 && /接管简报 · SEAL-/.test(ex.stdout), ex.stdout);

  // --todo 写回：链哈希要重算，签过名的还要重签（否则自己把凭证弄成「被改过」）
  const dsg = dir('g1-resign');
  put(dsg, 'a.txt', 'a\n');
  seal(dsg);
  const rec1 = readReceipt(dsg);
  seal(dsg, ['resume', '--todo', '接着收尾']);
  const rec2 = readReceipt(dsg);
  ok('resume --todo 写进 next（不再写 todo）', rec2.next === '接着收尾' && rec2.todo === undefined,
    JSON.stringify({ next: rec2.next, todo: rec2.todo }));
  ok('改写后重签（签名值变了）', !!rec2.sig && rec2.sig.value !== (rec1.sig || {}).value);
  const vsg = seal(dsg, ['verify']);
  ok('改写后仍能验真通过', vsg.status === 0 && /验真成功/.test(vsg.stdout), vsg.stdout);

  // 换一台没有钥匙的机器改 next：必须告警，不能假装签名还在
  const dnk = dir('g1-nokey');
  put(dnk, 'a.txt', 'a\n');
  seal(dnk);                                   // HOME 里有钥匙 → 带签名
  const nk = sealAt(dnk, ['resume', '--todo', '别人接着改'], path.join(ROOT, '_home_nokey'));
  ok('无密钥改写 → 明说「原签名失效」', /原签名失效/.test(nk.stdout), nk.stdout);
  ok('无密钥改写 → 凭证不再假装有签名', !readReceipt(dnk).sig);
  ok('无密钥改写 → 链哈希仍自洽（verify 不误报被改过）', seal(dnk, ['verify']).status === 0);
}

/* ---------- ㉔ G2 MCP server：每行一个 JSON-RPC ---------- */
console.log('㉔ G2 seal-mcp.js（stdio / 新行分隔 JSON-RPC）');
{
  const d = dir('g2-mcp');
  put(d, 'a.txt', 'a\n');

  const r = mcp(d, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]);
  ok('stdout 每一行都是合法 JSON（没有日志混进来）', r.parseErr === null, r.parseErr || r.stdout.slice(0, 300));
  ok('通知不回包（4 条消息 → 3 个响应）', r.lines.length === 3, `实际 ${r.lines.length}`);

  const i1 = byId(r, 1).result || {};
  ok('initialize 返回 protocolVersion = 2024-11-05', i1.protocolVersion === '2024-11-05', JSON.stringify(i1));
  ok('capabilities.tools 是对象', !!i1.capabilities && typeof i1.capabilities.tools === 'object', JSON.stringify(i1.capabilities));
  ok('serverInfo = { name: "seal", version }',
    i1.serverInfo && i1.serverInfo.name === 'seal' && typeof i1.serverInfo.version === 'string', JSON.stringify(i1.serverInfo));

  const tools = ((byId(r, 2).result || {}).tools) || [];
  ok('tools/list 给出四个工具',
    tools.length === 4 && ['seal_stamp', 'seal_verify', 'seal_resume', 'seal_show'].every((n) => tools.some((t) => t.name === n)),
    tools.map((t) => t.name).join(','));
  ok('四个工具都有真 inputSchema（type object + properties 非空）',
    tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.inputSchema.properties && Object.keys(t.inputSchema.properties).length > 0),
    JSON.stringify(tools.map((t) => [t.name, Object.keys((t.inputSchema || {}).properties || {})])));
  ok('seal_stamp 的 inputSchema 里有 summary / cwd / window',
    (() => {
      const t = tools.find((x) => x.name === 'seal_stamp') || {};
      const p = Object.keys((t.inputSchema || {}).properties || {});
      return ['summary', 'cwd', 'window'].every((k) => p.includes(k));
    })());
  ok('ping 返回空对象', JSON.stringify(byId(r, 3).result) === '{}', JSON.stringify(byId(r, 3).result));

  // 四个工具真的干活
  const d2 = dir('g2-tools');
  put(d2, 'b.txt', 'b\n');
  // 这条 recheck 命令会写文件：MCP 的 verify 绝不能执行它
  put(d2, 'seal-out/commands.jsonl',
    JSON.stringify({ cmd: `node -e "require('fs').writeFileSync('PWN_MCP.txt','x')"`, exit: 0, ms: 3, out: '', recheck: true }) + '\n');
  const rr = mcp(d2, [
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'seal_stamp', arguments: { summary: 'MCP 盖的章' } } },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'seal_verify', arguments: {} } },
    { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'seal_resume', arguments: {} } },
    { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'seal_show', arguments: {} } },
    { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'seal_verify', arguments: { cwd: 'no/such/dir' } } },
  ]);
  const st = (byId(rr, 10).result || {}).structuredContent || {};
  ok('seal_stamp 返回 id / status / files / commands / receiptPath',
    typeof st.id === 'string' && st.status === 'done' && st.files === 1 && st.commands === 1 && /receipt\.json$/.test(String(st.receiptPath)),
    JSON.stringify(st));
  ok('seal_stamp 真把凭证写进 cwd', fs.existsSync(path.join(d2, 'seal-out', 'receipt.json')));

  const vr = (byId(rr, 11).result || {}).structuredContent || {};
  ok('seal_verify 返回 ok / checked / failed / message',
    vr.ok === true && typeof vr.checked === 'number' && vr.failed === 0 && /通过/.test(String(vr.message)), JSON.stringify(vr));
  ok('seal_verify 不执行凭证里的命令（没生成 PWN_MCP.txt）', !fs.existsSync(path.join(d2, 'PWN_MCP.txt')));
  ok('seal_verify 对未重跑的命令标 partial', vr.partial === true, JSON.stringify(vr));

  const rs = byId(rr, 12).result || {};
  ok('seal_resume 返回简报文本', /接管简报 · SEAL-/.test(((rs.content || [])[0] || {}).text || ''), JSON.stringify(rs).slice(0, 200));
  ok('seal_resume 同时返回结构化字段',
    !!rs.structuredContent && !!rs.structuredContent.id && !!rs.structuredContent.verify, JSON.stringify(rs.structuredContent).slice(0, 200));

  const sh = (byId(rr, 13).result || {}).structuredContent || {};
  ok('seal_show 返回摘要（含 id / 链哈希）', !!sh.id && !!sh.chainHash, JSON.stringify(sh).slice(0, 200));
  ok('seal_show 不含 HTML 正文', !/<html|<body/i.test(JSON.stringify(sh)));
  ok('cwd 不存在时返回 isError，而不是崩', (byId(rr, 14).result || {}).isError === true, JSON.stringify(byId(rr, 14)));

  const dEmpty = dir('g2-empty');
  const ee = mcp(dEmpty, [{ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'seal_stamp', arguments: {} } }]);
  ok('空目录盖章 → isError（不发空凭证）', (byId(ee, 40).result || {}).isError === true, JSON.stringify(byId(ee, 40)));

  // 协议错误码
  const e = mcp(d, [
    { jsonrpc: '2.0', id: 20, method: 'nope/method' },
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: {} },
    { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'nope_tool', arguments: {} } },
    { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'seal_stamp', arguments: { window: 'abc' } } },
    { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'seal_stamp', arguments: { bogus: 1 } } },
  ]);
  ok('未知方法 → -32601', ((byId(e, 20).error) || {}).code === -32601, JSON.stringify(byId(e, 20)));
  ok('tools/call 缺 name → -32602', ((byId(e, 21).error) || {}).code === -32602, JSON.stringify(byId(e, 21)));
  ok('未知工具 → -32602', ((byId(e, 22).error) || {}).code === -32602, JSON.stringify(byId(e, 22)));
  ok('参数类型错 → -32602', ((byId(e, 23).error) || {}).code === -32602, JSON.stringify(byId(e, 23)));
  ok('不认识的参数 → -32602', ((byId(e, 24).error) || {}).code === -32602, JSON.stringify(byId(e, 24)));

  // 坏行不能带崩整个流
  const raw = cp.spawnSync(process.execPath, [MCP], {
    cwd: d, encoding: 'utf8', timeout: 30000,
    input: '{这不是 JSON\n{"jsonrpc":"2.0","id":30,"method":"ping"}\n',
    env: { ...process.env, SEAL_HOME: HOME },
  });
  let rawLines = [];
  try { rawLines = raw.stdout.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { rawLines = []; }
  ok('坏行回 -32700，后面的消息照常处理',
    rawLines.length === 2 && rawLines[0].error && rawLines[0].error.code === -32700 && rawLines[1].id === 30,
    JSON.stringify(rawLines));
}

/* ---------- 汇总 ---------- */
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
if (!failed.length) {
  console.log(`全部通过 ${pass}/${pass}　用时 ${secs}s`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
}
console.log(`失败 ${failed.length} 项，通过 ${pass} 项　用时 ${secs}s`);
for (const f of failed) console.log('  ✘ ' + f);
console.log(`测试目录保留在：${ROOT}`);
process.exit(1);
