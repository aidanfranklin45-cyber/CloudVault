# AGENT INSTRUCTIONS & TOKEN OPTIMIZATION RULES

## 1. Just-In-Time (JIT) Context Protocol
To prevent token waste and API credit depletion, always operate under a **Just-In-Time Context** approach:

- **Small Bug Fixes & UI Tweaks**: Read ONLY the specific file or function mentioned in the bug report or stack trace. Do NOT fetch whole repository trees or large file bundles.
- **Targeted Symbol Lookup**: Use targeted search (`grep`, `rg`, or direct file views) to locate relevant function definitions or UI IDs instead of reading unreferenced files.
- **Sequential Tool Call Minimization**: Avoid calling directory listings (`list_dir`) or opening multiple adjacent files unless strictly required to resolve a broken dependency or import.

## 2. Codebase Dumps & Repomix Usage
- **Strict Limitation**: Full codebase dumps (e.g., Repomix bundles) are strictly reserved for **large multi-file architectural refactoring** or platform migration tasks.
- **Ignore Filter**: Whenever generating or consuming repository bundles, ensure `.repomixignore` is respected so heavy lockfiles (`package-lock.json`), build folders, images, and temporary test scripts are stripped out.

## 3. Practical Workflow: Trunk-Based Integration
- **Iterate Locally First**: Edit files, inspect logs/stack traces, and verify changes directly. Do NOT run the full end-to-end test suite (`npx playwright test`) for localized UI tweaks, copy updates, or isolated CSS/HTML changes. Only run specific, targeted test specs or deno functions when modifying critical business logic or financial calculations.
- **Commit When the "Contract" Passes**: Once a discrete task passes local verification, bundle the changes into a single atomic commit.
- **Push on Verified Task Completion**: Push directly to `main` as soon as the specific task is verified to maintain continuous flow without turning CI into a bottleneck.
- **Circuit Breaker**: If a command or tool call fails twice consecutively with the same error, stop and analyze the root cause before attempting again.
