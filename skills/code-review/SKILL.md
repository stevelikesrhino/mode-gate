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
    - Trace ALL the code that's related to scope of changes.
    - Find bugs. Don't hang up too much on "what if DB jitters" "what if network disconnects". If infra problem leads to very severe issues that's not fixable, point out.
    - Assume the business logic is corret.
    - Be thorough about your analysis. Think carefully. False positive is worse than no positive.
    - If you find edge cases or boundary conditions, verify them against actual data/code before raising issues.
    - Group by P0 to P4.
| Priority | Classification          | Meaning                                                                                                                                    |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0**   | **Critical / Incident** | Production down, data loss/corruption, security breach, payments broken, or core flow blocked for most users. Requires immediate response. |
| **P1**   | **High / Urgent**       | Major functionality broken for many users, but not total outage. Limited workaround may exist. Fix ASAP.                                   |
| **P2**   | **Medium / Important**  | Noticeable bug affecting some users or a non-core workflow. Workaround usually exists. Prioritize in normal sprint/release.                |
| **P3**   | **Low / Minor**         | Small bug, edge case, UI issue, copy problem, or low-impact behavior. Fix when convenient.                                                 |
| **P4**   | **Trivial / Polish**    | Cosmetic nit, cleanup, inconsistency, or nice-to-have improvement. Backlog material.                                                       |
 
    - **Evidence Requirement**: P2 and above must include code snippet as evidence (with file path and line number). No conclusions without code backing.

    - If all good? Say LGTM.
