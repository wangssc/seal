# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-15

叙事换主入口：**接手（resume）> 凭证（receipt）> 防篡改（sign）**。凭证是副产物，接管简报才是每天都会用到的那个。

### Added

- `bin/seal-mcp.js`：零依赖 stdio MCP server，每行一个 JSON-RPC 2.0 消息（newline-delimited，不用 `Content-Length`）。实现 `initialize` / `notifications/*`（不回包）/ `ping` / `tools/list` / `tools/call`；未知方法 `-32601`，参数错 `-32602`，坏 JSON 行 `-32700`。四个工具 `seal_stamp` / `seal_verify` / `seal_resume` / `seal_show`，均带真 `inputSchema`（JSON Schema）。日志只进 stderr，stdout 纯协议。
- `resume --json`：输出裁剪版 `{ id, createdAt, status, summary, files, commands, next, verify }`，字段固定。
- 凭证新增 `next` 字段（`--todo` 写入；老凭证的 `todo` 仍可读）。`next` 参与链哈希。
- `~/.seal/last-receipt` 指针：上次盖章记下凭证绝对路径，`resume` / `show` 在没有本地凭证时可回退到它（`verify` 故意不回退——验真不能被全局指针指错对象）。

### Changed

- **`resume` 升级为接管简报**：抬头一行「编号 · 时间 · 状态」（可验收 / 部分验证 / 被改过），七段固定结构，文件清单最多 8 行，末尾一行**按状态给的可执行接手提示**。状态由「链哈希 + 签名 + 逐文件哈希 + 未重跑的 recheck 命令数」当场算出，不是念凭证里自报的 `status`。
- 找凭证改为三级：`--receipt` → 从 cwd 向上找 `seal-out/receipt.json` → `~/.seal/last-receipt`；都找不到时退出码 3 并提示「先跑 seal 盖章」，不抛栈。
- `seal.js` 拆出 `sealCore` / `verifyCore` / `resumeCore` / `showCore`：核心不打印、只返回结果，CLI 与 MCP 共用一套逻辑；`main()` 只在 `require.main === module` 时执行。
- README / landing 首屏改为「一个命令盖章，下一个 AI 一读就接手」，新增「在 MCP 客户端里用」一节（配置片段 + 真实调用与返回）。

### Fixed

- `resume --todo` 改写凭证后**没有重新签名**（有密钥时会把自己签过的凭证改成「签名不匹配」）。现在重算链哈希后重签；本机无密钥则删掉失效的 `sig` 并明确告警。

## [0.3.0] - 2026-11-15

### Added

- `keygen`：本机 ed25519 密钥对（`~/.seal/key.json`，0600；另出 `pubkey.json` 供发人），已有则拒绝覆盖，`--force` 才覆盖。
- 盖章自动签名：`receipt.json` 增加 `sig: { alg, pub_fpr, value }`，签名对象为 `chain.hash` 的 UTF-8 字节。链哈希计算已排除 `sig`，老凭证（无 `sig`）哈希不变。
- `trust <公钥文件>` / `trust --list`：把对方公钥加入 `~/.seal/trusted.json`，`verify` 据此区分「签了但不认识这把钥匙」与「已信任并验签通过」。
- `verify` 三档结论：未签名 / 已签名但公钥未被信任 / 已签名并验证通过 / 签名不匹配（退出码 1）。
- `anchor`：把 `chain.hash` 写入 `seal-out/ANCHOR` 并提交成一条 git 提交（只提交该路径，绝不 push）；非 git 仓库退出码 1。
- 凭证页「链哈希」区加一行小字：`签名：已签名（指纹 …）` / `签名：未签名`。

### Changed

- `.gitignore` 增加 `seal-out/ANCHOR`（由 `anchor` 自行 `git add -f`）。

## [0.2.0] - 2026-11-15

### Added

- `run` 子命令：`seal run -- <命令>`（等价 `seal -- <命令>`）真执行命令、输出原样透传、把完整 stdout+stderr 记进 `seal-out/commands.jsonl`，退出码透传；`--recheck` 标记该命令可被重新验收。此前全包没有写 commands.jsonl 的代码，凭证恒为「0 条命令」。
- `--window <分钟>`：采集窗口可调，默认仍 30 分钟。
- 凭证新增 `warnings` 数组；超出窗口但 24 小时内改过的文件会告警，并渲染到 receipt.html 顶部。

### Changed

- **verify 默认不再执行任何命令**：`recheck` 命令只列出，加 `--allow-run` 才执行；执行前对 `>` `>>` `|` `&&` `;` `rm` `del` `curl` `wget` 以及 `node -e/-p`（一行内联代码字面上没有任何符号，照样能写文件、发请求）逐条打印 `! 该命令包含危险字符（…），请确认来源可信`。有命令未重跑时标题写「部分验证」，不再写「验真成功」。此前 `verify` 会无条件执行凭证里的命令，构成 RCE。
- 空凭证拦截：没采到任何文件与命令时不再输出「已盖章」，改为提示并退出码 2。

### Fixed

- `.gitignore` 改为 `seal-out/*` + `!seal-out/receipt.json`，凭证可入库、命令日志不入库（README 早就这么承诺，规则却是整目录排除）。

## [0.1.0] - 2026-11-15

### Added

- 盖章：一条命令扫描项目近 30 分钟内改动过的文件与命令记录，生成 `seal-out/receipt.json` 与 `seal-out/receipt.html`。
- 验真：重算链哈希并逐个比对文件哈希，输出 `通过 N/N` 或 `不通过 N/N：…`，退出码 0 / 1。
- 接管简报：`resume` 把凭证翻译成改了哪些文件、验过什么、下一步是什么的人话简报。
- 链式哈希：`--prev` 接上一份凭证的哈希，每次盖章把历史串成一条不可回改的链。
- 一页 A4 凭证：凭证渲染成可直接打印或发群的单页 HTML，强调色区分通过 / 部分完成 / 阻塞。
