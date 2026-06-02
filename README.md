# Mode Gate

为 [PI Coding Agent](https://github.com/badlogic/pi-mono) 设计的权限控制系统。

## 模式

| 模式 | 描述 |
|------|------|
| **watched** | 每次编辑或破坏性操作前确认。（默认） |
| **explore** | 只读。仅允许安全命令。（需开启 `exploreAvailable`） |
| **yolo** | 无提示，完全访问。 |

## 功能

- **line-edit** *(Deprecated)* — 基于 LINE#HASH 锚点的文件编辑，解决 CJK tokenizer 问题（已移至 `line-edit` 分支）
- **latex2md** — 将 LaTeX 输出转为可读 Markdown
- **自定义允许/拒绝** — watched 模式下可为决策添加 follow up
- **批量批准** — 一次性批准同类操作
- **不可逆命令检测** — 拦截 rm, mv, sed, git push 等

## 快速开始

- `Shift+Tab` — 循环切换模式
- `/mode <name>` — 直接切换

## 设置（可选）

添加到 `settings.json`（全局）或 `.pi/settings.json`（项目）。只需配置想修改的部分：

```json
{
  "modeGate": {
    "readPreview": true,
    "exploreAvailable": true,
    "defaultGrep": "rg", 		// line-edit
    "readMaxBytes": 20480, 		// line-edit
    "readMaxLines": 2000, 		// line-edit
    "fullReadNudgeThreshold": 3 // line-edit
  }
}
```

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `readPreview` | `false` | 在 TUI 中显示读取预览 |
| `exploreAvailable` | `false` | 启用只读 explore 模式；开启后 Shift+Tab 顺序为 watched → explore → yolo |
| `defaultGrep` | `"rg"` | 建议使用的 grep 工具 (line-edit) |
| `readMaxBytes` | `20480` | hashline read 输出截断前的最大字节数 (line-edit) |
| `readMaxLines` | `2000` | hashline read 输出截断前的最大行数 (line-edit) |
| `fullReadNudgeThreshold` | `3` | 同一文件连续截断读取达到该次数后建议 grep (line-edit) |

## 安装

1. `npm install -g @earendil-works/pi-coding-agent`
2. `git clone`
3. `cd extensions/mode-gate && npm install`
4. 将 `mode-gate` 复制到 PI 的 extensions 目录（剩下的 extension 也可以玩玩～）
5. 在 `settings.json` 中配置（可选）

---

# Mode Gate

A permission control system for [PI Coding Agent](https://github.com/badlogic/pi-mono).

## Modes

| Mode | Description |
|------|------|
| **watched** | Confirm before each edit or destructive action. (default) |
| **explore** | Read-only. Safe commands only. (requires `exploreAvailable`) |
| **yolo** | No prompts, full access. |

## Features

- **line-edit** *(Deprecated)* — LINE#HASH anchored file editing, solves CJK tokenizer issues (moved to `line-edit` branch)
- **latex2md** — Convert LaTeX output to readable Markdown
- **Custom allow/deny** — Add follow-ups to decisions in watched mode
- **Batch approval** — Approve similar operations at once
- **Destructive command detection** — Intercept rm, mv, sed, git push, etc.

## Quick Start

- `Shift+Tab` — Cycle through modes
- `/mode <name>` — Switch directly

## Settings (optional)

Add to `settings.json` (global) or `.pi/settings.json` (project). You can configure only the settings you want to change:

```json
{
  "modeGate": {
    "readPreview": true,
    "exploreAvailable": true,
    "defaultGrep": "rg", 		// line-edit
    "readMaxBytes": 20480, 		// line-edit
    "readMaxLines": 2000, 		// line-edit
    "fullReadNudgeThreshold": 3 // line-edit
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `readPreview` | `false` | Show read preview in TUI |
| `exploreAvailable` | `false` | Enable read-only explore mode; when enabled, Shift+Tab cycles watched → explore → yolo |
| `defaultGrep` | `"rg"` | Grep tool to suggest (line-edit) |
| `readMaxBytes` | `20480` | Max bytes before truncating hashline read output (line-edit) |
| `readMaxLines` | `2000` | Max lines before truncating hashline read output (line-edit) |
| `fullReadNudgeThreshold` | `3` | Truncated reads of the same file before suggesting grep (line-edit) |

## Install

1. `npm install -g @earendil-works/pi-coding-agent`
2. `git clone`
3. `cd extensions/mode-gate && npm install`
4. Copy `mode-gate` to your PI extensions directory (feel free to try the other extensions too)
5. Configure in `settings.json` (optional)

## License

MIT
