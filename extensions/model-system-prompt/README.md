# Model system prompt

Add `systemPromptMap` to `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`:

```json
{
  "systemPromptMap": {
    "openai-codex/*": {
      "APPEND_SYSTEM.md": "CODEX.md"
    },
    "anthropic/*": {
      "SYSTEM.md": "system-prompts/claude.md",
      "APPEND_SYSTEM.md": "system-prompts/claude-extra.md"
    }
  }
}
```

- Patterns match the full `provider/modelId`, case-sensitively. `*` matches any number of characters; `?` matches one.
- The first matching entry wins. Project entries are checked before global entries; entries within each file follow their written order. Rules are not merged.
- Paths are relative to the settings file's directory. Absolute paths and `~/` paths also work. The example uses `CODEX.md` beside `settings.json`.
- `SYSTEM.md` replaces the base system instructions. `APPEND_SYSTEM.md` replaces the append section, rather than adding to the existing one. Both override the corresponding project, global, or CLI-provided prompt.
- Specify either key or both. Omitted sections stay unchanged. Project context, skills, and working-directory information are preserved.
- Settings and mapped files are reread before each user prompt; configuration changes need no reload. With no matching rule, the prompt stays unchanged.
