# Mode Gate

为 [PI Coding Agent](https://github.com/badlogic/pi-mono) 设计的三模式权限控制系统，控制 AI 可以执行的操作。

## 模式

| 模式 | 描述 | 状态颜色 |
|------|------|----------|
| **explore** | 只读模式。可以运行安全的 bash 命令（ls, cat, grep 等）。不能编辑或写入文件。 | 绿色 |
| **watched** | 每次编辑、写入或执行破坏性命令前都会确认。 | 蓝色 |
| **yolo** | 无提示。完全访问权限。 | 黄色 |

**始终从 explore 模式开始**以确保安全。

## 快速开始

### 循环切换模式
按 `Shift+Tab` 循环切换：`explore → watched → yolo → explore`

### 直接切换模式
使用 `/mode` 命令：
```
/mode watched    # 切换到 watched 模式
/mode yolo       # 切换到 yolo 模式
/mode explore    # 切换到 explore 模式
/mode            # 打开交互式选择器
```

## 使用场景

**explore 模式**
- 代码审查和分析
- 理解新的代码库
- 运行安全的诊断命令

**watched 模式**
- 在监督下进行更改
- 你不在电脑前但想让工作继续
- 了解 AI 想要做什么

**yolo 模式**
- 完全信任 AI
- 快速原型开发
- 你正在实时监控所有操作

## 功能特性

- **自定义允许/拒绝** - watched 模式下按 Tab 可添加备注消息
  - 允许时添加消息会作为 follow-up 发送给 AI
  - 拒绝时添加备注说明原因
- **批量批准** - 为当前响应批准同一类型的操作
- **安全 bash 白名单** - explore 模式下允许（ls, cat, grep, find, git status 等）
- **破坏性命令检测** - rm, mv, sed, npm install, git push 等
- **视觉状态指示器** - 显示当前模式

## 确认对话框快捷键

在 watched 模式的确认对话框中：
- `上下方向键` - 选择选项
- `Tab` - 在"允许"或"拒绝"选项上添加备注消息
- `Enter` - 确认选择
- `Esc` - 取消

## 技能

`skills/` 文件夹包含我个人使用的工作流技能（init、load、save）。

## 安装

1. 安装 PI Coding Agent：`npm install -g @mariozechner/pi-coding-agent`
2. 克隆此仓库
3. 安装 line-edit 扩展依赖：`cd extensions/line-edit && npm install`
4. 将扩展文件夹复制到你的 PI 扩展目录
5. 在设置中启用

## 贡献

欢迎提交 PR，但我只做功能开发——代码审查反正可能是 AI 做的。

## 许可证

GPLv3

---

# Mode Gate

A three-mode permission control system for [PI Coding Agent](https://github.com/badlogic/pi-mono), controlling what the AI can do.

## Modes

| Mode | Description | Status Color |
|------|------|----------|
| **explore** | Read-only. Can run safe bash commands (ls, cat, grep, etc). Cannot edit or write files. | Green |
| **watched** | Confirms before every edit, write, or destructive command. | Blue |
| **yolo** | No prompts. Full access. | Yellow |

**Always starts in explore mode** for safety.

## Quick Start

### Cycle Modes
Press `Shift+Tab` to cycle: `explore → watched → yolo → explore`

### Direct Switch
Use the `/mode` command:
```
/mode watched    # Switch to watched mode
/mode yolo       # Switch to yolo mode
/mode explore    # Switch to explore mode
/mode            # Open interactive picker
```

## Use Cases

**explore mode**
- Code review and analysis
- Understanding new codebases
- Running safe diagnostic commands

**watched mode**
- Making changes under supervision
- Letting work continue while you're away
- Understanding what the AI wants to do

**yolo mode**
- Full trust in AI
- Rapid prototyping
- Real-time monitoring of all operations

## Features

- **Custom Allow/Deny** - Press Tab in watched mode to add a note
  - Adding a message on Allow sends it as follow-up to the AI
  - Adding a note on Deny explains the reason
- **Batch Approve** - Approve same-type operations for the current response
- **Safe Bash Whitelist** - Allowed in explore mode (ls, cat, grep, find, git status, etc)
- **Destructive Command Detection** - rm, mv, sed, npm install, git push, etc
- **Visual Status Indicator** - Shows current mode

## Confirmation Dialog Shortcuts

In watched mode confirmation dialogs:
- `Arrow keys` - Select option
- `Tab` - Add a note to Allow or Deny
- `Enter` - Confirm
- `Esc` - Cancel

## Skills

The `skills/` folder contains personal workflow skills (init, load, save) for my own use.

## Install

1. Install PI Coding Agent: `npm install -g @mariozechner/pi-coding-agent`
2. Clone this repo
3. Install line-edit extension dependencies: `cd extensions/line-edit && npm install`
4. Copy extension folders to your PI extensions directory
5. Enable in settings

## Contributing

PRs are welcome, but I just do features — code is probably reviewed by AI anyway.

## License

GPLv3
