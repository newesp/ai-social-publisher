# Step 3 Connected Platform Preview Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display each active Meta or LINE connection's real `displayName` as the Step 3 preview title, with Meta／LINE fallbacks.

**Architecture:** Reuse the platform connections already loaded by `CreatePostWizard`. Keep a platform-to-name map in wizard state and pass the selected name directly to `PlatformPreview`; do not change preview payload builders or persistence.

**Tech Stack:** Next.js, React, Mantine, Node test runner

## Global Constraints

- Do not add an API request or change publishing payloads.
- Do not change the sessionStorage draft format.
- Preserve active-platform filtering and all existing wizard behavior.
- Use `Meta` and `LINE` when a non-empty connection name is unavailable.

---

### Task 1: Pass active connection names to Step 3 previews

**Files:**
- Modify: `tests/wizard-ui.test.js`
- Modify: `src/components/CreatePostWizard.js`
- Modify: `src/components/PlatformPreview.js`

**Interfaces:**
- Consumes: `/api/platform-connections` response entries shaped as `{ platform, state, displayName }`.
- Produces: `PlatformPreview({ data, content, onContentChange, displayName })`, where `displayName` is optional.

- [x] **Step 1: Write the failing UI contract test**

Add assertions that `CreatePostWizard` passes `platformDisplayNames[preview.platform]` into `PlatformPreview`, and that `PlatformPreview` renders `displayName || "Meta"` and `displayName || "LINE"` without the old New ESP titles.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/wizard-ui.test.js`

Expected: FAIL because the name map, prop, and generic fallbacks do not exist yet.

- [x] **Step 3: Implement the minimal name mapping**

In `CreatePostWizard`, add `platformDisplayNames` state. When active connections load, derive trimmed non-empty names keyed by platform, clear the map on load failure, and pass the matching value to each `PlatformPreview`.

In `PlatformPreview`, pass the optional prop into Meta and LINE preview renderers and use:

```jsx
<Text fw={700}>{displayName || "Meta"}</Text>
<Text fw={700}>{displayName || "LINE"}</Text>
```

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/wizard-ui.test.js tests/platform-preview.test.js tests/platform-connection-routes.test.js`

Expected: all tests pass.

- [x] **Step 5: Run regression verification**

Run: `npm.cmd test`

Expected: all tests pass.

Run: `npm.cmd run build`

Expected: production build completes successfully.

- [ ] **Step 6: Commit and push**

```powershell
git add docs/superpowers/plans/2026-07-14-platform-preview-connection-name.md tests/wizard-ui.test.js src/components/CreatePostWizard.js src/components/PlatformPreview.js
git commit -m "fix: show connected platform names in previews"
git push origin main
```
