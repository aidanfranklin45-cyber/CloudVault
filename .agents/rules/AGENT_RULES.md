---
trigger: always_on
description: Combined operational rules, database protocols, and tiered context selection for token optimization.
globs: "**/*"
---

# AGENT OPERATIONAL RULES & SYSTEM DIRECTIVES

## 1. ARCHITECTURAL INVARIANTS & BUSINESS LOGIC RULES

### Dynamic Financial & Location Data (Strict Rule)
- NEVER hardcode monetary values, prices, service fees, discounts, or tax rates anywhere in the codebase (backend, frontend, or edge logic).
- All pricing matrices, rate calculations, and tax percentages MUST be resolved dynamically from the database/service layer using the active location/tenant context.
- Never introduce static numeric fallback constants (e.g., `const tax = 0.08`, `const baseRate = 25`) to make a function compile or mock an incomplete flow.
- If required location or pricing configuration is missing, throw a descriptive domain error or handle the missing state explicitly.

### Execution Standards
- When creating or modifying calculation functions, enforce explicit context/config parameters in the function signatures.
- Before completing any task involving pricing, billing, or regional compliance, run a self-check to ensure zero hardcoded numeric business literals were introduced.

---

## 2. CONTEXT SELECTION & TOKEN OPTIMIZATION PROTOCOL

Optimize context efficiency by gathering only the information necessary to resolve the prompt.

- Default to Focused Search: Use targeted search tools (`grep`, `rg`, file/symbol search) to pinpoint relevant code rather than reading broad directories.
- Targeted Context Reading: Read only the relevant files or functions related to the task. Avoid bundling unrelated modules into context.
- Dependency Tracing (Graphify): Use Graphify only when tracing cross-file data flows or RPC/schema dependencies, scoped strictly to 1–2 hops.
- Full Bundling (Repomix): Do not run full repository bundling tools unless explicitly requested for multi-file architectural refactors.
- Re-indexing: Do not re-index context for localized UI edits, CSS tweaks, or isolated bug fixes.

### Rule Execution Matrix
1. **Bug fix from a stack trace or single UI element tweak?** → **TIER 1** — Inspect 1 file / 1 function directly.
2. **Feature requiring knowledge of an RPC parameter or database column?** → **TIER 2** — Grep schema or run a localized 1-hop Graphify query.
3. **Platform-wide system overhaul?** → **TIER 3** — Filtered Repomix bundle (only on explicit user request).

### Re-Indexing Policy
- **Minor Changes:** Do NOT re-index for CSS, minor bug fixes, or UI tweaks.
- **Major Changes:** Execute `npm run refresh-context` ONLY after adding major architectural components, new DB schemas, or new routes.

---

## 3. IMPASSE DETECTOR & LOOP CIRCUIT BREAKER
- Threshold: If any tool call or script fails with the exact same error twice in a row, HALT immediately. Do NOT run it a 3rd time without altering inputs.

---

## 4. DEPLOYMENT PROTOCOL (Firebase Hosting)
- Auto-Deploy: After modifying frontend files (`.html`, `.css`, `.js`, `supabase-config.js`), run `npx firebase-tools deploy --only hosting` from `C:\Users\Aidan\OneDrive\Desktop\Antigravity_Workspace\CloudVault`.
- Version Control: After verifying changes, execute standard git commands (git add ., git commit -m "descriptive message", git push) to push modifications to GitHub.

---

## 5. DATABASE PROTOCOL (Supabase MCP)
- Project ID: `xbxvebnrjryvksvtufqj`
- Always use the Supabase MCP server (`execute_sql`, `list_tables`) as the primary database interface.
- Verify all schema modifications with a follow-up query.

---

## 6. PROJECT REFERENCE & BOUNDARIES
- Stack: Vanilla HTML/CSS/JS, Firebase Hosting, Supabase (Postgres + Auth).
- Core Files: index.html, login.html, dashboard.html, admin.html, supabase-config.js.
- Single source of truth for Supabase client configuration lives in supabase-config.js.