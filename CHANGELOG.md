# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
