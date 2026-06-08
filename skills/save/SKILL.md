---
name: save
description: save current development progress to WIP.md
---

# Save Skill
Goal: Maintain a task checklist in WIP.md. Track what needs to be done, and associate completed tasks with their commit records.

1. Review current progress and determine completion state of each task.
2. Write or update WIP.md with this structure:
    - **Solution**: (Optional) One-liner for a key design decision or constraint.
    - **Tasks**: Checklist organized by functional modules.
3. Task hierarchy rules:
    - Parent items represent modules or feature areas.
    - Child items represent atomic tasks.
    - A parent may only be checked when all children are checked.
    - When children have mixed states, keep the parent unchecked; let child checkboxes reflect progress.
    - Completed tasks should be followed by their corresponding commit hash(es) (e.g., - [x] Task name (abc1234, def5678)).
4. Constraints:
    - No implementation details.
    - No code snippets, diffs, or file paths.
    - No report-style narration; track task completion state and associated commit hashes.
