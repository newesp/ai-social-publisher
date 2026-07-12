# Model Selection Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select and locally remember provider-specific LLM and image models for each generation.

**Architecture:** `model-config.js` owns provider defaults/options. The wizard stores non-sensitive choices in `localStorage` and sends them with the existing generate payload. Generator adapters receive those selected values; this adds no settings, DB, encryption, or shared credentials.

**Tech Stack:** Next.js App Router, React, Mantine, Node test runner, localStorage.

## Global Constraints

- Gemini LLM: `gemini-3.1-flash-lite-image` default; `gemini-3.1-flash-image` alternative.
- Gemini image: `gemini-2.5-flash-lite` default; `gemini-3.1-flash-lite` and `gemini-3.5-flash` alternatives.
- OpenAI exposes its existing one-option models: `gpt-4o`, `gpt-image-2`.
- Persist preferences only in browser `localStorage`.
- Do not add backend model validation, settings/DB persistence, encryption, or live provider/publishing tests.

---

### Task 1: Model Contract And Generator Propagation

**Files:** Modify `src/lib/ai/model-config.js`, `src/lib/ai/llm-service.js`, `src/lib/ai/image-service.js`, `src/lib/ai/generated-response.js`; test `tests/model-config.test.js`, `tests/llm-service.test.js`, `tests/image-service.test.js`.

**Produces:** `getModelOptions(kind, provider)`, selected-model-aware `getLLMModel(provider, requestedModel)` and `getImageModel(provider, requestedModel)`.

- [ ] Add failing tests for the exact Gemini model lists/defaults and for selected models reaching the LLM/image request builders.
- [ ] Run `npm.cmd test -- tests/model-config.test.js tests/llm-service.test.js tests/image-service.test.js`; verify the new expectations fail because selected model support is absent.
- [ ] Implement `MODEL_OPTIONS` with:

```js
llm: { google: ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"], openai: ["gpt-4o"] }
image: { google: ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"], openai: ["gpt-image-2"] }
```

- [ ] Resolve defaults from the first option; forward `body.llmModel` and `body.imageModel` through `buildGeneratedResponse` into existing generators.
- [ ] Re-run the focused tests; expect pass.
- [ ] Commit with `feat: support selected generation models`.

### Task 2: Wizard Selects And Browser Preferences

**Files:** Create `src/lib/wizard/model-preferences.js`; modify `src/lib/wizard/wizard-flow.js`, `src/components/CreatePostWizard.js`; test `tests/model-preferences.test.js`, `tests/wizard-ui.test.js`.

**Produces:** `MODEL_PREFERENCES_KEY = "ai-social-publisher:model-preferences"`, safe read/write helpers, and wizard form fields `llmModel` / `imageModel`.

- [ ] Add failing tests for JSON read/write, invalid stored JSON fallback, restored Gemini selections, OpenAI single-option controls, and model fields in the generate payload.
- [ ] Run `npm.cmd test -- tests/model-preferences.test.js tests/wizard-ui.test.js`; verify failure because helper/control code is absent.
- [ ] Implement client-only hydration with `useEffect`, persist each provider/model choice to `localStorage`, and select the remembered provider choice or first configured default on provider change.
- [ ] Render model `<Select>` controls beside existing provider controls in step 2, using `getModelOptions`.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit with `feat: remember selected generation models`.

### Task 3: Verify

- [ ] Run `npm.cmd test`; expect all tests pass.
- [ ] Run `npm.cmd run build`; expect runtime configuration validation and Next.js build pass.
- [ ] Run `git diff --check`; expect no whitespace errors.
