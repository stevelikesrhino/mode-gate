---
name: load
description: load current development progress from WIP.md
---

# Load Skill

1. Look for `WIP.md` in the project root
2. If found, read and parse the file to extract:
   - Title/goal
   - Completed work
   - Full TODO checklist hierarchy
   - Context/Scaffold files or entry points
3. Preserve exact checkbox state for every task and nested subtask.
4. Report what is done and not done down to the deepest listed subtask.
5. Treat an unchecked parent with checked children as partially complete, not done.
6. Do not collapse nested subtasks into a parent summary.
7. Display progress in a compact structure:
   - Done: completed bullets and checked TODO/sub-TODO items
   - Not done: unchecked TODO/sub-TODO items, preserving hierarchy
   - Partial: unchecked parents that contain at least one checked child
   - Resume context: key files or entry points from Context/Scaffold
8. Present the next actionable TODO items without losing their parent task context.
