import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_PREFERENCES_KEY,
  getPreferredModel,
  readModelPreferences,
  writeModelPreferences,
} from "../src/lib/wizard/model-preferences.js";
import { getInitialPostForm } from "../src/lib/wizard/wizard-flow.js";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("reads and writes non-sensitive provider-specific model preferences", () => {
  const storage = createStorage();
  const preferences = {
    llm: { google: "gemini-3.5-flash" },
    image: { google: "gemini-3.1-flash-image" },
  };

  assert.equal(writeModelPreferences(preferences, storage), true);
  assert.equal(storage.getItem(MODEL_PREFERENCES_KEY), JSON.stringify(preferences));
  assert.deepEqual(readModelPreferences(storage), preferences);
});

test("falls back to empty preferences when stored JSON is invalid", () => {
  const storage = createStorage({ [MODEL_PREFERENCES_KEY]: "not-json" });

  assert.deepEqual(readModelPreferences(storage), {});
});

test("restores remembered Gemini models in the initial wizard form", () => {
  const form = getInitialPostForm({
    llm: { google: "gemini-3.5-flash" },
    image: { google: "gemini-3.1-flash-image" },
  });

  assert.equal(form.llmProvider, "google");
  assert.equal(form.llmModel, "gemini-3.5-flash");
  assert.equal(form.imageProvider, "google");
  assert.equal(form.imageModel, "gemini-3.1-flash-image");
});

test("uses configured defaults when a provider has no remembered model", () => {
  const form = getInitialPostForm();

  assert.equal(form.llmModel, "gemini-2.5-flash-lite");
  assert.equal(form.imageModel, "gemini-3.1-flash-lite-image");
});

test("restores a provider's remembered model when switching providers", () => {
  const preferences = {
    llm: {
      google: "gemini-3.5-flash",
      openai: "gpt-4o",
    },
  };

  assert.equal(getPreferredModel("llm", "openai", preferences), "gpt-4o");
  assert.equal(getPreferredModel("llm", "google", preferences), "gemini-3.5-flash");
});
