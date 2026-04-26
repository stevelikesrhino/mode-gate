---
name: save
description: save current development progress to WIP.md
---

# Save Skill
1. Ask the user for the feature name/context (if not provided)
2. Use git status/git diff to find all modified files
3. Inspect only enough changed-file context to assess implementation state
4. Categorize into: fully implemented, partially implemented, and not yet started
5. Write/update a WIP.md at the project root using this compact structure:
    - Title
    - Completed: concise bullets for finished work
    - TODO: task checklist with nested subtasks
    - Context/Scaffold: only key files or entry points needed to resume
6. Keep WIP.md under 80 lines.
7. Preserve task/subtask checklist hierarchy.
8. Do not paste code, diffs, logs, or long explanations.
9. Prefer updating existing checklist items over appending new sections.
10. Completed bullets should summarize outcomes, not implementation details.
11. Each pending task should be one checkbox line; subtasks may be nested checkboxes.
12. File paths belong in the Context/Scaffold section, not inside every task unless essential.
13. A parent TODO must remain unchecked while any nested sub-TODO is unchecked.
14. Only mark a parent TODO done when all required child TODOs are done.
15. If a parent has mixed child states, keep the parent unchecked and let child checkboxes show progress.
16. When you finish editing the file, briefly summarize what you wrote.
