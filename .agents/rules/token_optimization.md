---
description: Combined operational rules, database protocols, and tiered context selection for token optimization.
globs: "**/*"
alwaysApply: true
---

# AGENT OPERATIONAL RULES & SYSTEM DIRECTIVES

## 1. CONTEXT SELECTION & TOKEN OPTIMIZATION PROTOCOL

You must select the **minimum required context scope** using the following tiered hierarchy before executing any task. DO NOT run Repomix or Graphify by default.

### Tier 1: Targeted Local Search (DEFAULT — ALL BUG FIXES & SMALL UI EDITS)
- ALWAYS start here for localized bugs, single-file edits, or stack trace fixes.
- Use fast, local CLI tools (`grep`, `rg`, or IDE symbol search) to find specific functions, variable names, or UI IDs.
- Read ONLY the exact functions or single files identified in the stack trace or user query.
- No Sequential Searches: Never call `list_dir`, `find_files`, or open sequential source files to locate code.
- Targeted Reading Only: Open and read ONLY the specific file being actively edited.

### Tier 2: Subgraph Tracing (FUNCTION DEPENDENCIES & CROSS-FILE DATA FLOW)
- Use Graphify ONLY when you need to inspect how a specific function flows across files (e.g., tracing a Supabase RPC call from `admin.html` down to `schema.sql`).
- Execute local Graphify traces constrained to **1–2 hops** for the target symbol. DO NOT output or read the entire repository graph.

### Tier 3: Full Repomix Bundle (ARCHITECTURAL REFACTORS ONLY)
- Use Repomix ONLY when the user **explicitly** requests multi-file architectural refactoring.
- ALWAYS ensure `.repomixignore` is active to strip out static assets, lockfiles, and migrations before reading the output.

### Rule Execution Matrix
1. **Bug fix from a stack trace or single UI element tweak?** → **TIER 1** — Inspect 1 file / 1 function directly.
2. **Feature requiring knowledge of an RPC parameter or database column?** → **TIER 2** — Grep schema or run a localized 1-hop Graphify query.
3. **Platform-wide system overhaul?** → **TIER 3** — Filtered Repomix bundle (only on explicit user request).

### Re-Indexing Policy
- **Minor Changes:** Do NOT re-index for CSS, minor bug fixes, or UI tweaks.
- **Major Changes:** Execute `npm run refresh-context` ONLY after adding major architectural components, new DB schemas, or new routes.

## 2. IMPASSE DETECTOR & LOOP CIRCUIT BREAKER
- Threshold: If any tool call or script fails with the exact same error twice in a row, HALT immediately. Do NOT run it a 3rd time without altering inputs.

## 3. DEPLOYMENT PROTOCOL (Firebase Hosting)
- Auto-Deploy: After modifying frontend files (.html, .css, .js, supabase-config.js), run npx firebase-tools deploy --only hosting from C:\Users\Aidan\OneDrive\Desktop\Antigravity_Workspace\CloudVault.
- Skip hosting deploys for database-only (SQL migration) changes.

## 4. DATABASE PROTOCOL (Supabase MCP)
- Project ID: xbxvebnrjryvksvtufqj.
- Always use the supabase MCP server (execute_sql, list_tables) as the primary database interface.
- Verify all schema modifications with a follow-up query.

## 5. PROJECT REFERENCE & BOUNDARIES
- Stack: Vanilla HTML/CSS/JS, Firebase Hosting, Supabase (Postgres + Auth).
- Core Files: index.html, login.html, dashboard.html, admin.html, supabase-config.js.
- Single source of truth for Supabase client configuration lives in supabase-config.js.
