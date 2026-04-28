# Mode Gate

为 [PI Coding Agent](https://github.com/badlogic/pi-mono) 设计的三模式权限控制系统，控制 AI 可以执行的操作。

#### 更新：
- 添加 line-edit：行数+哈希算法为基础的编辑工具，防止千问3.5 + llama.cpp造成的Tokenizer问题无法正确匹配中文(CJK)+英文的新旧字符串，导致无法编辑特定文档。Opus完成了大部分的代码。
- 添加 latex2md：将 AI 输出的 LaTeX 格式和数学符号转换为易读的 Markdown 文本。
- 添加 spinner-verbs：为 AI 提供的加载状态动词库，使等待过程更具趣味性。

- 示例：
> 喵喵喵喵is a cat <br>
> 汪汪汪汪is a dog

在千问3.5 27B + llama cpp的环境下，自带编辑器百分百出错

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

## 配置
- **修改 grep 提示工具**：在 `extensions/line-edit/index.ts` 中修改 `DEFAULT_GREP` 常量，以更改提示 AI 使用的工具名称（例如将其改为 `rg`）。

- **可选模式列表**：在 `extensions/mode-gate/index.ts` 中修改 `AVAILABLE_MODES`，以控制 `/mode` 选择器和 `Shift+Tab` 循环中出现的模式。
  - 例如：`["watched", "yolo"]`
  - 如需启用 explore：`["explore", "watched", "yolo"]`

## 安装

1. 安装 PI Coding Agent：`npm install -g @mariozechner/pi-coding-agent`
2. 克隆此仓库
3. 进入line-edit的页面并安装 line-edit 扩展依赖：`cd extensions/line-edit && npm install`
4. 将扩展文件夹复制到你的 PI 扩展目录
5. 在设置中启用

## 贡献

欢迎提交 PR，但我只做功能开发——代码审查反正可能是 AI 做的。

## 致谢

- [oh-my-pi](https://github.com/nicholasgasior/oh-my-pi) — line-edit 扩展的 hashline 编辑和 diff 生成参考实现
- [diff](https://www.npmjs.com/package/diff) — Myers diff 算法（BSD-3-Clause）

## 许可证

MIT

---

# Mode Gate

A three-mode permission control system for [PI Coding Agent](https://github.com/badlogic/pi-mono), controlling what the AI can do.

### Update:
- Added line-edit — a line-number + hash based editing tool to work around Qwen3.5 + llama.cpp tokenizer issues that prevent correct matching of CJK+English old/new strings, making certain documents uneditable. Opus wrote most of the code. Opt out if you're not using CJK characters.
- Added latex2md — converts LaTeX formatting and math symbols in AI responses to readable Markdown.
- Added spinner-verbs — a collection of creative verbs for the AI's working message to make the waiting process more engaging.

Example:
> 喵喵喵喵is a cat <br>
> 汪汪汪汪is a dog

With Qwen3.5 27B and llama.cpp, the default edit tool will consistently fail.

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

## Configuration
- **Change grep nudge tool**: Modify the `DEFAULT_GREP` constant in `extensions/line-edit/index.ts` to change the tool name suggested to the AI in nudge messages (e.g., change it to `rg`).

- **Available modes**: Modify `AVAILABLE_MODES` in `extensions/mode-gate/index.ts` to control which modes appear in the `/mode` picker and `Shift+Tab` cycle.
  - Example: `["watched", "yolo"]`
  - To enable explore: `["explore", "watched", "yolo"]`

## Install

1. Install PI Coding Agent: `npm install -g @mariozechner/pi-coding-agent`
2. Clone this repo
3. Install line-edit extension dependencies *inside line-edit folder*: `cd extensions/line-edit && npm install`
4. Copy extension folders to your PI extensions directory
5. Enable in settings

## Contributing

PRs are welcome, but I just do features — code is probably reviewed by AI anyway.

## Credits

- [oh-my-pi](https://github.com/nicholasgasior/oh-my-pi) — Reference implementation for hashline editing and diff generation in line-edit extension
- [diff](https://www.npmjs.com/package/diff) — Myers diff algorithm (BSD-3-Clause)

## License

MIT
