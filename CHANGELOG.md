# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-15

### Added

- 盖章：一条命令扫描项目近 30 分钟内改动过的文件与命令记录，生成 `seal-out/receipt.json` 与 `seal-out/receipt.html`。
- 验真：重算链哈希并逐个比对文件哈希，输出 `通过 N/N` 或 `不通过 N/N：…`，退出码 0 / 1。
- 接管简报：`resume` 把凭证翻译成改了哪些文件、验过什么、下一步是什么的人话简报。
- 链式哈希：`--prev` 接上一份凭证的哈希，每次盖章把历史串成一条不可回改的链。
- 一页 A4 凭证：凭证渲染成可直接打印或发群的单页 HTML，强调色区分通过 / 部分完成 / 阻塞。
