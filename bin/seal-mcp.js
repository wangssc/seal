#!/usr/bin/env node
'use strict';
/**
 * seal MCP server · 零依赖、不联网、stdio
 *
 * 传输：每行一个 JSON-RPC 2.0 消息（newline-delimited，不带 Content-Length 头）。
 * 规矩：stdout 只走协议消息，一个 console.log 就能把整条流打坏；所有日志走 stderr。
 * 用法：node bin/seal-mcp.js        （由 MCP 客户端当子进程拉起来，不是给人手敲的）
 *
 * 实现的方法：initialize / notifications/* / ping / tools/list / tools/call
 * 未知方法 → -32601；参数不对 → -32602。
 */

const fs = require('fs');
const path = require('path');
const core = require('./seal.js');
const pkg = require('../package.json');

const PROTOCOL = '2024-11-05';
const SERVER = { name: 'seal', version: pkg.version };

/** 日志只许进 stderr：stdout 是协议通道 */
const log = (...a) => {
  try { process.stderr.write('[seal-mcp] ' + a.join(' ') + '\n'); } catch { /* stderr 关了也不能崩 */ }
};

/* ---------------- 工具定义（inputSchema 必须是真的 JSON Schema，不能空着） ---------------- */

const CWD_SCHEMA = { type: 'string', description: '项目目录，默认本 server 进程的工作目录' };
const RECEIPT_SCHEMA = { type: 'string', description: 'receipt.json 的路径；缺省从 cwd 向上找 seal-out/receipt.json' };

const TOOLS = [
  {
    name: 'seal_stamp',
    description: '给本次交付盖章：扫 cwd 内近 window 分钟改过的文件与命令日志，写 seal-out/receipt.json 和 receipt.html。返回编号、状态、文件数、命令数、凭证路径。',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话结论，会写进凭证（不传则按采集结果自动生成）' },
        cwd: CWD_SCHEMA,
        window: { type: 'number', description: '采集窗口（分钟），默认 30' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'seal_verify',
    description: '验真：重算链哈希、逐文件哈希、校验签名。凭证里标了 recheck 的命令只列出、不执行（这个工具永远不会执行凭证里的命令）。',
    inputSchema: {
      type: 'object',
      properties: { cwd: CWD_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'seal_resume',
    description: '接手上一棒：把凭证翻成接管简报（这是什么活 / 改了哪些文件 / 验过什么 / 下一步 / 接手提示）。换会话、换 agent 时先调这个。',
    inputSchema: {
      type: 'object',
      properties: { cwd: CWD_SCHEMA, receipt: RECEIPT_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'seal_show',
    description: '读凭证摘要（不含 HTML 正文）：结论、状态、文件数、命令数、链哈希、签名状态。',
    inputSchema: {
      type: 'object',
      properties: { cwd: CWD_SCHEMA, receipt: RECEIPT_SCHEMA },
      additionalProperties: false,
    },
  },
];

/* ---------------- 结果包装 ---------------- */

const asJson = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});

const asText = (text, payload) => {
  const out = { content: [{ type: 'text', text }] };
  if (payload) out.structuredContent = payload;
  return out;
};

const asError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/* ---------------- 参数校验（类型错要报 -32602，不能静默忽略） ---------------- */

function checkArgs(tool, args) {
  const props = tool.inputSchema.properties || {};
  for (const [k, v] of Object.entries(args)) {
    if (!(k in props)) return `不认识的参数 ${k}（${tool.name} 只接受：${Object.keys(props).join(' / ') || '无'}）`;
    if (v === undefined || v === null) continue;
    const want = props[k].type;
    if (want === 'string' && typeof v !== 'string') return `参数 ${k} 必须是字符串，收到 ${Array.isArray(v) ? 'array' : typeof v}`;
    if (want === 'number' && !(typeof v === 'number' && Number.isFinite(v))) return `参数 ${k} 必须是数字，收到 ${Array.isArray(v) ? 'array' : typeof v}`;
  }
  return null;
}

function resolveCwd(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'string') return { error: 'cwd 必须是字符串' };
  const p = path.resolve(input);
  try {
    if (!fs.statSync(p).isDirectory()) return { error: `cwd 不是目录：${p}` };
  } catch {
    return { error: `cwd 不存在：${p}` };
  }
  return { dir: p };
}

/* ---------------- 四个工具 ---------------- */

const HANDLERS = {
  seal_stamp(args) {
    const c = resolveCwd(args.cwd);
    if (c.error) return asError(c.error);
    const res = core.sealCore({ cwd: c.dir, summary: args.summary, window: args.window });
    if (!res.ok) return asError(res.lines.join('\n'));
    const r = res.receipt;
    const payload = {
      id: r.id,
      status: r.status,
      files: r.files.length,
      commands: r.commands.length,
      receiptPath: res.jsonPath,
    };
    const head = [`已盖章：${payload.files} 个文件 / ${payload.commands} 条命令 / 编号 ${payload.id}`];
    for (const w of res.warnings) head.push(`注意：${w}`);
    head.push(r.sig ? `已签名：ed25519，指纹 ${r.sig.pub_fpr}` : '未签名：本机没有密钥（seal keygen 生成后才带签名）');
    return asText(`${head.join('\n')}\n${JSON.stringify(payload, null, 2)}`, payload);
  },

  seal_verify(args) {
    const c = resolveCwd(args.cwd);
    if (c.error) return asError(c.error);
    // 永远不带 allow-run：验凭证不许顺带跑凭证里的代码
    const res = core.verifyCore({ cwd: c.dir });
    const payload = {
      ok: res.ok,
      checked: res.total,
      failed: res.fails.length,
      message: res.message,
      partial: res.partial === true,
    };
    return asJson(payload);
  },

  seal_resume(args) {
    const c = resolveCwd(args.cwd);
    if (c.error) return asError(c.error);
    const res = core.resumeCore({ cwd: c.dir, receipt: args.receipt });
    if (!res.ok) return asError(res.text);
    return asText(res.text, res.data);
  },

  seal_show(args) {
    const c = resolveCwd(args.cwd);
    if (c.error) return asError(c.error);
    const res = core.showCore({ cwd: c.dir, receipt: args.receipt });
    if (!res.ok) return asError(res.message);
    return asJson(res.data);
  },
};

/* ---------------- JSON-RPC ---------------- */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

function callTool(id, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.name !== 'string') {
    return fail(id, -32602, 'Invalid params: tools/call 需要 { name: string, arguments?: object }');
  }
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) {
    return fail(id, -32602, `Invalid params: 未知工具 ${params.name}（可用：${TOOLS.map((t) => t.name).join(', ')}）`);
  }
  let args = params.arguments;
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return fail(id, -32602, 'Invalid params: arguments 必须是对象');
  }
  const bad = checkArgs(tool, args);
  if (bad) return fail(id, -32602, 'Invalid params: ' + bad);

  try {
    return reply(id, HANDLERS[tool.name](args));
  } catch (e) {
    // 工具执行炸了是 tool error，不是协议错误：回 isError，别把 server 带走
    log('tool error:', (e && e.message) || String(e));
    return reply(id, asError(`工具执行失败：${(e && e.message) || String(e)}`));
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail(null, -32600, 'Invalid Request: 每行必须是一个 JSON-RPC 对象');
  }
  // 没有 id 就是通知：单向的，不许回任何东西（回了反而算协议错误）
  const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id');
  const id = msg.id === undefined ? null : msg.id;
  const method = msg.method;

  if (typeof method !== 'string') {
    if (isNotification) return;
    return fail(id, -32600, 'Invalid Request: 缺 method');
  }
  if (isNotification) return;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') return callTool(id, msg.params);
  return fail(id, -32601, `Method not found: ${method}`);
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'Parse error: 这一行不是合法 JSON');
  }
  return handleMessage(msg);
}

/* ---------------- stdio 主循环 ---------------- */

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, '');
    buf = buf.slice(i + 1);
    if (line.trim()) {
      try { handleLine(line); } catch (e) { log('handler error:', (e && e.message) || String(e)); }
    }
  }
});
process.stdin.on('end', () => {
  const rest = buf.trim();
  if (rest) {
    try { handleLine(rest); } catch (e) { log('handler error:', (e && e.message) || String(e)); }
  }
});
process.stdin.on('error', (e) => log('stdin error:', (e && e.message) || String(e)));

// 任何漏网的异常都不许打到 stdout，也不许静默死掉
process.on('uncaughtException', (e) => log('uncaught:', (e && e.stack) || String(e)));
process.on('unhandledRejection', (e) => log('unhandled:', (e && e.message) || String(e)));

// --help / --version 不该把 stdio 服务起起来，也不该污染 stdout 协议
const _argv = process.argv.slice(2);
if (_argv.includes('--version') || _argv.includes('-v')) {
  process.stdout.write(`${SERVER.version}\n`);
  process.exit(0);
}
if (_argv.includes('--help') || _argv.includes('-h')) {
  process.stdout.write(
    [
      'seal-mcp ' + SERVER.version + ' · MCP server (stdio, newline-delimited JSON-RPC 2.0)',
      '',
      '用法：node bin/seal-mcp.js            （MCP 客户端以子进程方式启动它）',
      '      node bin/seal-mcp.js --version  （打印版本）',
      '',
      '工具：' + TOOLS.map((t) => t.name).join(', '),
      '调试信息只写 stderr；stdout 只走协议。',
      ''
    ].join('\n')
  );
  process.exit(0);
}

log(`ready · protocol ${PROTOCOL} · v${SERVER.version} · ${TOOLS.length} tools`);
