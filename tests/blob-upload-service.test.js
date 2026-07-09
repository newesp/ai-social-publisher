import assert from "node:assert/strict";
import { test } from "node:test";

import { uploadGeneratedImage } from "../src/lib/blob/blob-upload-service.js";

test("uploads generated data URLs to public Vercel Blob URLs", async () => {
  const calls = [];
  const result = await uploadGeneratedImage({
    imageUrl: "data:image/jpeg;base64,aGVsbG8=",
    putImpl: async (pathname, body, options) => {
      calls.push({ pathname, body, options });
      return { url: "https://blob.vercel-storage.com/generated.jpg" };
    },
    idFactory: () => "fixed-id",
  });

  assert.equal(result, "https://blob.vercel-storage.com/generated.jpg");
  assert.equal(calls[0].pathname, "generated-posts/fixed-id.jpg");
  assert.equal(calls[0].options.access, "public");
  assert.equal(calls[0].options.contentType, "image/jpeg");
  assert.equal(await calls[0].body.text(), "hello");
});

test("keeps existing HTTPS image URLs without uploading", async () => {
  const result = await uploadGeneratedImage({
    imageUrl: "https://example.com/image.png",
    putImpl: async () => {
      throw new Error("put should not be called");
    },
  });

  assert.equal(result, "https://example.com/image.png");
});
