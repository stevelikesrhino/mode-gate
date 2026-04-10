# AGENTS.md - pi-coding-agent Configuration & Extensions

This directory is the configuration and extension home for the `pi-coding-agent`. It is not the core source code of the agent itself.

## Project Context
- **Root Purpose**: Configuration, session management, and custom extensions/skills.
- **Core Source**: The agent's core logic is located at `/Users/steve/github-source/pi-mono/packages/coding-agent`. Refer to that directory to understand how the agent works, how it loads extensions, and how its tools are implemented.
- **Extensions**: Custom toolsets that augment the agent's capabilities.
- **Skills**: Specialized instructions/workflows for the agent.

## Extensions Development
Extensions are located in the `extensions/` directory.

### Architecture
- Each extension is typically a TypeScript project.
- Entry point is usually an `index.ts` exporting a default function: `export default function (pi: ExtensionAPI) { ... }`.
- Extensions use the `@mariozechner/pi-coding-agent` API to define tools and hook into agent events.

### Coding Guidelines (TypeScript)
- **Tool Definition**: Use `defineTool()` to create new tools.
- **Parameter Validation**: Use `@sinclair/typebox` (`Type.Object`, `Type.String`, etc.) to define the schema for tool parameters. This ensures LLMs provide correctly typed arguments.
- **Error Handling**: Use `try-catch` blocks within tool `execute` functions and throw descriptive `Error` objects to provide feedback to the agent.
- **Formatting**:
    - Use clear, descriptive comments for tools and complex logic.
    - Prefer explicit types over `any`.
    - Use async/await for all I/O operations.
- **Consistency**: Follow the pattern established in `extensions/line-edit/index.ts`.

### Tooling
- Since extensions are loaded dynamically by the agent, you generally don't need to run a separate build process for them unless they have complex dependencies.
- **Do NOT** attempt to run lint or compile commands in this directory unless specifically requested.

## Skills Development
Skills are located in the `skills/` directory.
- Each skill contains a `SKILL.md` file describing its purpose and the steps to execute it.

## Project-Specific Instructions
- **Interactions**: When investigating how a feature interacts with the agent, go directly to the core source directory mentioned above.
- **Safety**: Be mindful of file system operations within extensions; use `withFileMutationQueue` for safe file edits.
- **User Context**: The user is a Java backend engineer. While they are improving the agent, they are not deeply familiar with TypeScript. Keep code changes clean and well-documented.

## Useful Paths
- **Core Source**: `/Users/steve/github-source/pi-mono/packages/coding-agent`
    - Logic: `src/`
    - Documentation: `docs/`
- **Agent Configuration** (`/Users/steve/.pi/agent/`):
    - Extensions: `extensions/`
    - Skills: `skills/`
    - Sessions: `sessions/`
    - Settings: `settings.json`
    - Models: `models.json`
    - Auth: `auth.json`

