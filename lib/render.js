/**
 * 凭证网页模板：一页 A4，黑白 + 一个强调色（深墨绿 #1f4d46）。
 * 只把 receipt.json 呈现成人能看懂的一页纸：不改数据、不引外部资源、不带动画。
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-US');
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const MAX_FILES = 8, MAX_CMDS = 5; // 超出即折叠成一句「还有 N 个」
const ST = { done: ['可验收', 'DONE', '#1f4d46'], partial: ['未完成', 'PARTIAL', '#8a6a12'], blocked: ['受阻', 'BLOCKED', '#8c2b2b'] };

const CSS = `
@page{size:A4;margin:0}*{box-sizing:border-box;margin:0;padding:0}
body{background:#e7e7e3;color:#1b1b1b;font:10.5pt/1.6 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:210mm;min-height:297mm;margin:0 auto;padding:18mm;background:#fff;display:flex;flex-direction:column;box-shadow:0 1px 4px rgba(0,0,0,.14)}
.hdr{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:2.2mm;border-bottom:1.5px solid #1f4d46}
.brand{font-size:12pt;font-weight:700;letter-spacing:5px;color:#1f4d46}.hdr span:last-child{font-size:8.5pt;letter-spacing:1.4px;color:#6b6b6b}
.id{margin-top:6.5mm;font:700 16pt/1.3 ui-monospace,Consolas,monospace;letter-spacing:.4px}.meta{margin-top:2mm;font-size:8.5pt;color:#6b6b6b}
.sec{margin-top:10mm}.lbl{font-size:8.5pt;font-weight:600;letter-spacing:1.5px;color:#5c5c5c}.lbl b{color:#1f4d46;margin-right:9px;letter-spacing:0}
.sum{margin-top:2.4mm;font-size:20pt;font-weight:600;line-height:1.4}.badge{display:inline-block;padding:1px 7px;margin-right:9px;border-radius:2px;color:#fff;font-size:8.5pt;font-weight:600;letter-spacing:1px;vertical-align:4px}
table{width:100%;border-collapse:collapse;margin-top:2.4mm;border-top:1.5px solid #111;font-size:8.5pt;line-height:1.3}
th{padding:1.6mm 0 1.3mm;font-size:8.5pt;font-weight:600;text-align:left;border-bottom:1px solid #111}
td{padding:.65mm 0;vertical-align:top}tbody tr:last-child td{border-bottom:1.5px solid #111}th+th,td+td{padding-left:6mm}
.r{text-align:right;font-family:ui-monospace,Consolas,monospace;white-space:nowrap}.mono{font-family:ui-monospace,Consolas,monospace;font-size:8.5pt;word-break:break-all}
.cmd{font-family:ui-monospace,Consolas,monospace;font-size:8.5pt;overflow-wrap:break-word}.bad{color:#8c2b2b;font-weight:700}.mut{color:#666}.more{font-size:8.5pt;color:#6b6b6b}
.chain{margin-top:10mm;padding-top:2.6mm;border-top:1px solid #d8d8d2}
.warn{margin-top:4mm;padding:1.6mm 2.6mm;border-left:2.5px solid #8a6a12;background:#fdf9ec;font-size:8.5pt;line-height:1.5;color:#6b5310}
.hash{margin-top:1.8mm;font-family:ui-monospace,Consolas,monospace;font-size:8.5pt;line-height:1.5;word-break:break-all}.note{margin-top:1.2mm;font-size:8.5pt;line-height:1.45;color:#6b6b6b}
.ft{margin-top:auto;padding-top:3.4mm;border-top:1px solid #d8d8d2;display:flex;justify-content:space-between;font-size:8.5pt;color:#6b6b6b}
@media print{body{background:#fff}.sheet{box-shadow:none;min-height:296.5mm}}
`;

function receiptHTML(r) {
  const [zh, en, tint] = ST[r.status] || [String(r.status || '未知'), String(r.status || '').toUpperCase(), '#555'];
  const when = String(r.created_at || '').slice(0, 16).replace('T', ' ');
  const git = r.git ? `${r.git.branch} @ ${r.git.rev || '—'}${r.git.dirty ? '（有未提交改动）' : '（干净）'}` : '非 git 仓库';
  const files = r.files || [], cmds = r.commands || [];
  const warns = Array.isArray(r.warnings) ? r.warnings : [];
  const more = (n, unit) => `<tr><td class="more" colspan="9">还有 ${n} ${unit}，本页不逐条列出，全量在 receipt.json</td></tr>`;

  const fRows = files.length
    ? files.slice(0, MAX_FILES).map((f) => `<tr><td>${esc(f.path)}</td><td class="r">${num(f.bytes)}</td>`
      + `<td class="mono" title="${esc(f.sha256)}">${esc(String(f.sha256).slice(0, 16))}…</td></tr>`).join('')
      + (files.length > MAX_FILES ? more(files.length - MAX_FILES, '个文件') : '')
    : '<tr><td class="more" colspan="9">本次没有文件变动</td></tr>';
  const cRows = cmds.length
    ? cmds.slice(0, MAX_CMDS).map((c) => `<tr><td class="cmd">${esc(c.cmd)}</td>`
      + `<td class="r${c.exit ? ' bad' : ''}">${c.exit === null ? '—' : c.exit}</td>`
      + `<td class="r mut">${c.ms === null ? '—' : c.ms + ' ms'}</td>`
      + `<td class="mono mut" title="${esc(c.out_head || '')}">${esc(cut(c.out_head, 60) || '—')}${c.recheck ? ' ·重跑' : ''}</td></tr>`).join('')
      + (cmds.length > MAX_CMDS ? more(cmds.length - MAX_CMDS, '条命令') : '')
    : '<tr><td class="more" colspan="9">没有命令记录</td></tr>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>交付凭证 ${esc(r.id)}</title><style>${CSS}</style></head>
<body><div class="sheet">
  <div class="hdr"><span class="brand">SEAL</span><span>交付凭证 / DELIVERY RECEIPT</span></div>
  <div class="id">${esc(r.id)}</div>
  <div class="meta">生成于 <time datetime="${esc(r.created_at)}">${esc(when)}</time> · 本机离线生成 · 工作目录 ${esc(r.cwd)} · ${esc(git)}</div>
  ${warns.length ? `<div class="warn">${warns.map((w) => esc(w)).join('<br>')}</div>` : ''}
  <div class="sec"><div class="lbl"><b>01</b>结论 / CONCLUSION</div>
    <div class="sum"><span class="badge" style="background:${tint}">${esc(zh)} ${esc(en)}</span>${esc(r.summary)}</div></div>
  <div class="sec"><div class="lbl"><b>02</b>文件 / FILES　${files.length} 个</div>
    <table><thead><tr><th style="width:46%">路径</th><th class="r" style="width:14%">字节</th><th>SHA-256（前 16 位）</th></tr></thead><tbody>${fRows}</tbody></table></div>
  <div class="sec"><div class="lbl"><b>03</b>命令 / COMMANDS　${cmds.length} 条</div>
    <table><thead><tr><th style="width:34%">命令</th><th class="r" style="width:9%">退出码</th><th class="r" style="width:12%">耗时</th><th>输出摘要（前 60 字）</th></tr></thead><tbody>${cRows}</tbody></table></div>
  <div class="chain"><div class="lbl"><b>04</b>链哈希 / CHAIN</div>
    <div class="hash">${esc(r.chain && r.chain.hash)}</div>
    <div class="note">任一字被改动，此哈希即不匹配。验真 <span class="mono">node bin\\seal.js verify</span>${r.chain && r.chain.prev ? `　· 前段 ${esc(String(r.chain.prev).slice(0, 12))}…` : '　· 首段，无前序凭证'}</div>
    <div class="note">签名：${r.sig && r.sig.pub_fpr ? `已签名（指纹 ${esc(r.sig.pub_fpr)}）` : '未签名'}</div></div>
  <div class="ft"><span>Seal v0.1 · 本地生成，未上传任何内容</span><span>第 1 页 共 1 页</span></div>
</div></body></html>`;
}
module.exports = { receiptHTML };
