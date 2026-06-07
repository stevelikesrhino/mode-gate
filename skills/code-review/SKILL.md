---
name: code-review
description: Review uncommitted changes or specified code based on P0-P4 priority.
---

# Code Review Skill
Goal: Provide a concise, priority-driven code review to ensure quality, correctness, and adherence to project standards.

## Process
1. **Target Identification**:
    - Run `git status` to check for uncommitted changes.
    - If changes exist: Use `git diff` to analyze the modifications.
    - If no changes exist: Ask the user for the specific review target (e.g., file path, commit hash, or branch).

2. **Analysis**:
    - Evaluate the code independently for logical correctness, performance, security, and project-specific conventions.
    - Focus on high-impact issues first.
    - Do NOT assume dirty entries, previous faulty logic, etc. Assume previous code works properly.
    - Do not force-find issues if the code is already clean and correct.

3. **Categorization**:
    - **P0 (Critical)**: Fatal bugs, security vulnerabilities, or crashes. (Must Fix)
    - **P1 (High)**: Logic errors, significant performance issues, or major architectural violations. (Should Fix)
    - **P2 (Medium)**: Code smells, missing edge case handling, or minor convention issues. (Suggested)
    - **P3 (Low)**: Style improvements, naming suggestions, or minor nitpicks.
    - **P4 (Trivial)**: Extremely minor nitpicks or trivial style issues.

## Output Format
- **Summary**: A brief overview of the changes.
- **Findings**: Grouped by priority from P0 to P4.
- If no issues are found across any priority level, reply "LGTM" with a brief summary instead.
