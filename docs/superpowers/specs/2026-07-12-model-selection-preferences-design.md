# Model selection preferences

## Goal

In wizard step 2, let users choose the Gemini LLM and image models for the current generation. Remember the selections in the same browser and reuse them on the next visit.

## Scope

- Keep provider selection in the current wizard flow.
- Add a model select for each provider surface.
- Gemini LLM models:
  - `gemini-3.1-flash-lite-image` (default)
  - `gemini-3.1-flash-image`
- Gemini image models:
  - `gemini-2.5-flash-lite` (default)
  - `gemini-3.1-flash-lite`
  - `gemini-3.5-flash`
- OpenAI keeps its existing single LLM and image model choices, shown as selects with one option.
- Persist the latest provider/model choices in browser `localStorage`.
- Restore those choices when the wizard opens. Changing provider restores its latest saved model or the provider default.
- Submit the selected model values to `/api/generate` and use them for the request.

## Deliberate exclusions

- No settings page controls.
- No DB records, encryption, or server-side storage for these non-sensitive preferences.
- No model allowlist validation in the backend for this iteration; the user accepts responsibility for the personal-provider-token usage.
- No changes to Meta, LINE, Instagram, publishing, or scheduling.

## Verification

- Unit tests cover default models, selected model propagation, model restoration, and the one-option OpenAI selects.
- UI tests assert both model controls are present in step 2.
- Run the full test suite and production build; do not run paid AI or publishing calls.
