#!/usr/bin/env node
'use strict';
/**
 * seal 自测：node test/run.js
 * 零依赖，跑完打印通过数与失败明细，有失败则退出码 1。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'seal.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-test-'));
const t0 = Date.now();

let pass = 0;
const failed = [];

function seal(cwd, args = []) {
  return cp.spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 90000 });
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

/* ---------- ① 空目录 ---------- */
console.log('① 空目录跑 seal');
{
  const d = dir('empty');
  const r = seal(d);
  const j = path.join(d, 'seal-out', 'receipt.json');
  const h = path.join(d, 'seal-out', 'receipt.html');
  ok('退出码 0，不报错', r.status === 0, r.stderr);
  ok('产出 receipt.json 与 receipt.html', fs.existsSync(j) && fs.existsSync(h));
  const rec = fs.existsSync(j) ? JSON.parse(fs.readFileSync(j, 'utf8')) : {};
  ok('files 为空数组、git 为 null', Array.isArray(rec.files) && rec.files.length === 0 && rec.git === null);
  ok('结构齐全（schema/id/created_at/cwd/summary/status/commands/chain）',
    ['schema', 'id', 'created_at', 'cwd', 'summary', 'status', 'files', 'commands', 'git', 'chain']
      .every((k) => k in rec) && rec.schema === 'seal/1');
  ok('空目录也能 verify 通过', seal(d, ['verify']).status === 0);
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
  ok('文件条目含 path/bytes/sha256/mtime',
    rec.files.length === 2 && rec.files.every((f) => f.path && f.bytes > 0 && /^[0-9a-f]{64}$/.test(f.sha256) && f.mtime));
  ok('summary / status / todo 按参数写入',
    rec.summary === '两个文件的小交付' && rec.status === 'done' && rec.todo === '补一条测试');
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
    return r2.todo === '接着收尾' && seal(d2c, ['verify']).status === 0;
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
  const v1 = seal(d, ['verify']);
  ok('重跑一致时 verify 通过', v1.status === 0 && /通过 3\/3/.test(v1.stdout), v1.stdout);

  put(d, 'seal-out/probe.txt', 'B\n'); // 只改驱动数据，凭证里的文件哈希不受影响
  const v2 = seal(d, ['verify']);
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
