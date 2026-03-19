# Mode Gate

为 [PI Coding Agent](https://github.com/badlogic/pi-mono) 设计的三模式权限控制系统。

A three-mode permission control system for [PI Coding Agent](https://github.com/badlogic/pi-mono).

## 模式 / Modes

| 模式 | 描述 |
|------|------|
| **explore** | 只读。仅允许安全命令。 |
| **watched** | 每次编辑或破坏性操作前确认。（默认） |
| **yolo** | 无提示，完全访问。 |

## 功能 / Features

- **line-edit** — 基于 LINE#HASH 锚点的文件编辑，解决 CJK tokenizer 问题
- **latex2md** — 将 LaTeX 输出转为可读 Markdown
- **spinner-verbs** — 某C字头软件的功能
- **自定义允许/拒绝** — watched 模式下可为决策添加follow up
- **批量批准** — 一次性批准同类操作
- **破坏性命令检测** — 拦截 rm, mv, sed, git push 等

## 快速开始 / Quick Start

- `Shift+Tab` — 循环切换模式
- `/mode <name>` — 直接切换

## 安装 / Install

1. `npm install -g @mariozechner/pi-coding-agent`
2. Clone this repo
3. `cd extensions/mode-gate && npm install`
4. Copy `mode-gate` folder to your PI extensions directory
5. Enable in settings

## License

MIT
