import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_IMAGE_PROVIDER,
  IMAGE_MODELS,
  getImageModelOptions,
  getLLMModel,
  getLLMModelOptions,
  getImageModel,
} from "../src/lib/ai/model-config.js";

test("uses gemini-3.1-flash-lite-image as the default Google text model", () => {
  assert.equal(getLLMModel("google"), "gemini-3.1-flash-lite-image");
});

test("uses gemini-2.5-flash-lite as the default Google image model", () => {
  assert.equal(DEFAULT_IMAGE_PROVIDER, "google");
  assert.equal(getImageModel("google"), "gemini-2.5-flash-lite");
});

test("uses gpt-image-2 as the default OpenAI image model", () => {
  assert.equal(getImageModel("openai"), "gpt-image-2");
});

test("keeps legacy image models out of the primary provider list", () => {
  assert.deepEqual(Object.keys(IMAGE_MODELS).sort(), ["google", "openai"]);
  assert.ok(!Object.values(IMAGE_MODELS).includes("dall-e-3"));
});

test("exposes the supported model options for each provider", () => {
  assert.deepEqual(getLLMModelOptions("google"), [
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-flash-image",
  ]);
  assert.deepEqual(getImageModelOptions("google"), [
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
  ]);
  assert.deepEqual(getLLMModelOptions("openai"), ["gpt-4o"]);
  assert.deepEqual(getImageModelOptions("openai"), ["gpt-image-2"]);
});
