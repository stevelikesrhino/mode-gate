---
name: save
description: save current development progress to WIP.md
---

# Save Skill
1. Ask the user for the feature name/context (if not provided)
2. Use git status/git diff to find all modified files
3. Read each changed file to assess implementation state
4. Categorize into: fully implemented, partially implemented, and not yet started
5. Write/update a WIP.md at the project root with:
    - Feature summary
    - Implemented files (with accurate paths)
    - Partial implementation notes
    - TODO checklist for what's left
    - Unresolved problem
6. When you finish editing the file, briefly summarize what you wrote.
