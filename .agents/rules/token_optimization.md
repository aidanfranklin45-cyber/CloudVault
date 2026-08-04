---
description: Combined operational rules, database protocols, and token optimization.
globs: "**/*"
alwaysApply: true
---

# AGENT OPERATIONAL RULES & SYSTEM DIRECTIVES

## 1. CODEBASE NAVIGATION & TOKEN OPTIMIZATION (GRAPHIFY & REPOMIX)
- Fact-Finding First: Before opening raw files, always refer to graphify-out/graph.json for module relationships and repomix-output.xml (via targeted grep/file-slice commands) for type definitions and signatures.
- No Sequential Searches: Never call list_dir, find_files, or open sequential source files to locate code.
- Targeted Reading Only: Open and read ONLY the specific file being actively edited.
- Re-Indexing Policy: 
  - Minor Changes: Do NOT re-index for CSS, minor bug fixes, or UI tweaks.
  - Major Changes: Execute npm run refresh-context ONLY after adding major architectural components, new DB schemas, or new routes.

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
