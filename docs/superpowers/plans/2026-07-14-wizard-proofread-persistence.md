# 發文精靈校對、暫存與帳號頭像 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成發文精靈必填導覽、sessionStorage 草稿、LLM 發布前錯字檢查、成功重設、繁體中文 UI 與 Google SSO 頭像。

**Architecture:** 將可測試規則放入 wizard/ai 純函式與服務，React 元件只協調狀態與 API。校對路由沿用 owner-scoped settings；草稿以版本化 sessionStorage 快照保存。

**Tech Stack:** Next.js App Router、React、Mantine、NextAuth、Node.js test runner。

## Global Constraints

- Step 1 未完整時不得進入 Step 2/3。
- 校對未通過或失敗時不得呼叫 `/api/posts`。
- `gemini-2.5-flash-lite` 不得出現在 Step 2 模型選項。
- 專有名詞保留，其他 UI 使用繁體中文。
- 不修改既有、與本功能無關的 auth-policy 基線失敗。

---

### Task 1: 精靈規則、草稿儲存與模型選項

**Files:**
- Create: `src/lib/wizard/wizard-draft-storage.js`
- Modify: `src/lib/wizard/wizard-flow.js`
- Modify: `src/lib/ai/model-config.js`
- Test: `tests/wizard-flow.test.js`
- Test: `tests/wizard-draft-storage.test.js`
- Test: `tests/model-config.test.js`

**Interfaces:**
- Produces: `isProductStepComplete(form)`, `canSelectWizardStep({ step, form })`, updated `shouldGenerateOnPreviewAdvance(...)`.
- Produces: `readWizardDraft(storage)`, `writeWizardDraft(storage, snapshot)`, `clearWizardDraft(storage)`.

- [ ] Add failing tests proving whitespace-only fields and empty platforms are incomplete, Steps 2/3 are blocked until complete, direct Step 3 requires generation, malformed storage is ignored, and `gemini-2.5-flash-lite` is absent from Google image options.
- [ ] Run `node --test tests/wizard-flow.test.js tests/wizard-draft-storage.test.js tests/model-config.test.js` and confirm failures are caused by missing behavior.
- [ ] Implement the pure rules and versioned sessionStorage adapter; change the Google image default/options to the first supported image-capable model.
- [ ] Re-run the focused tests and confirm all pass.

### Task 2: LLM 校對服務與安全 API

**Files:**
- Create: `src/lib/ai/proofread-service.js`
- Create: `src/lib/settings/proofread-route-handler.js`
- Create: `src/app/api/proofread/route.js`
- Modify: `src/lib/ai/llm-service.js`
- Test: `tests/proofread-service.test.js`
- Test: `tests/proofread-route.test.js`

**Interfaces:**
- Produces: `generateText({ llmProvider, llmModel, settings, prompt, fetchImpl })` for provider-neutral text calls.
- Produces: `proofreadTargets({ llmProvider, llmModel, settings, targets, fetchImpl }) -> { issues }`.
- API consumes `{ llmProvider, llmModel, targets }` and returns `{ issues }`.

- [ ] Add failing tests for Gemini/OpenAI selected-model requests, clean JSON, fenced JSON, invalid output, issue normalization, owner-scoped settings, and safe failure responses.
- [ ] Run `node --test tests/proofread-service.test.js tests/proofread-route.test.js` and confirm expected failures.
- [ ] Extract provider-neutral text generation without changing existing generation behavior; implement the proofread prompt/parser, handler, and authenticated route.
- [ ] Run focused proofread and existing LLM/generate route tests and confirm all pass.

### Task 3: 精靈 UI 導覽、持久化與發布流程

**Files:**
- Modify: `src/components/CreatePostWizard.js`
- Test: `tests/wizard-ui.test.js`

**Interfaces:**
- Consumes Task 1 wizard rules/storage and Task 2 `/api/proofread`.
- Produces UI states `checking`, `publishing`, `done`, and actionable typo issue rendering.

- [ ] Add failing UI contract tests for disabled next/steps, snapshot hydration/persistence, direct preview generation, `/api/proofread` before `/api/posts`, issue blocking, successful-status button replacement, and reset.
- [ ] Run `node --test tests/wizard-ui.test.js` and confirm the new assertions fail.
- [ ] Implement initialization/persistence effects, guarded navigation, proofread-first submit, issue panel, localized status labels, success-only「再新增貼文」and full draft reset.
- [ ] Run focused wizard, submission and model preference tests and confirm all pass.

### Task 4: Google 頭像與整體中文化

**Files:**
- Modify: `src/components/AppShellFrame.js`
- Modify: `src/lib/auth.js`
- Modify: `src/components/SettingsPanel.js`
- Modify: `src/components/PlatformPreview.js`
- Modify: `src/app/history/page.js`
- Modify: `src/lib/history/post-history.js`
- Modify: `src/app/layout.js`
- Create: `src/lib/posts/status-labels.js`
- Test: `tests/auth-session-profile.test.js`
- Test: `tests/wizard-ui.test.js`
- Test: `tests/post-history.test.js`

**Interfaces:**
- Produces `getStatusLabel(status)` and `getPlatformLabel(platform)` for UI-only labels.
- App shell consumes `/api/auth/session` and displays `user.image` with initial fallback.

- [ ] Add failing tests proving auth callbacks retain Google image/name, AppShell consumes session image, known statuses are Chinese, and remaining user-facing English copy is localized.
- [ ] Run the focused tests and confirm expected failures.
- [ ] Implement session profile preservation/avatar fallback, shared status labels, and scoped UI localization.
- [ ] Run focused auth/UI/history tests and confirm all pass.

### Task 5: 完整驗證與視覺 QA

**Files:**
- Review all files in this plan.

- [ ] Run `npm.cmd test`; confirm no new failure beyond the documented baseline auth-policy failure.
- [ ] Run `npm.cmd run build`; confirm exit code 0.
- [ ] Start the local app without publishing any real post and use browser checks for desktop and narrow viewport interaction/layout.
- [ ] Review `git diff --check`, `git diff --stat`, and scan the diff for secrets/PII.
- [ ] Request correctness, security/performance, and maintainability reviews; fix all Critical and Important findings, then repeat affected tests/build.
