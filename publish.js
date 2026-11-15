// 一次跑完：推代码 → 设描述话题 → 可选 npm 发布
// 令牌从 token.txt 读（第一行 GitHub，第二行 npm，可空），绝不写进任何被提交的文件
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = __dirname;
const tokenFile = path.join(root, 'token.txt');
if (!fs.existsSync(tokenFile)) {
  console.log('[!] 没有 token.txt。内容两行：GitHub classic 令牌（勾 repo）、npm 令牌（可空）。');
  process.exit(1);
}
const lines = fs.readFileSync(tokenFile, 'utf8').split(/\r?\n/);
const gh = (lines[0] || '').trim();
const npmToken = (lines[1] || '').trim();
if (!gh) { console.log('[!] token.txt 第一行是空的'); process.exit(1); }

const run = (cmd, args, opts = {}) => cp.spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });

// 1. 推送
const basic = Buffer.from('x:' + gh).toString('base64');
console.log('[1/3] 推送代码…');
let r = run('git', ['remote', 'remove', 'origin'], { stdio: 'ignore' });
r = run('git', ['remote', 'add', 'origin', 'https://github.com/wangssc/seal.git']);
const branch = (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'master').trim();
r = run('git', ['-c', 'http.extraheader=AUTHORIZATION: basic ' + basic, 'push', '-u', 'origin', branch + ':main']);
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0) {
  console.log('\n[!] 推送失败。常见原因：令牌没勾 repo、仓库不存在、仓库不是空的（先去删掉或改名）。');
  process.exit(1);
}

// 2. 描述与话题
console.log('[2/3] 设置仓库描述与话题…');
fetch('https://api.github.com/repos/wangssc/seal', {
  method: 'PATCH',
  headers: { Authorization: 'Bearer ' + gh, 'User-Agent': 'seal-publish', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    description: 'One command turns an AI agent\'s work into a verifiable delivery receipt — and a handoff brief the next agent can read. Zero deps, offline, Node >= 18.',
    homepage: '',
    topics: ['ai-agents', 'agent-handoff', 'provenance', 'mcp', 'cli', 'nodejs', 'audit', 'ed25519']
  })
}).then(async (res) => {
  const j = await res.json();
  if (j.full_name) console.log('  仓库：' + j.full_name + '（公开：' + !j.private + '）');
  else console.log('  [!] 设置失败：' + (j.message || res.status));

  // 3. npm（可选）
  console.log('[3/3] npm 发布…');
  if (!npmToken) { console.log('  跳过：token.txt 第二行是空的。'); return; }
  const npmrc = path.join(root, '.npmrc.publish');
  fs.writeFileSync(npmrc, '//registry.npmjs.org/:_authToken=' + npmToken + '\n');
  const p = run('npm', ['publish', '--userconfig', npmrc]);
  process.stdout.write(p.stdout || '');
  process.stderr.write(p.stderr || '');
  try { fs.unlinkSync(npmrc); } catch (e) {}
  console.log(p.status === 0 ? '  npm 已发布。' : '  npm 发布失败（不影响 GitHub 仓库）。');
}).catch((e) => console.log('  [!] 请求失败：' + e.message));
