import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPlatformPreviews } from "../src/lib/platform-preview/build-platform-previews.js";

test("builds platform-specific previews from the exact publish payload", () => {
  const previews = buildPlatformPreviews({
    imageUrl: "https://i.imgur.com/example.png",
    targets: [
      {
        platform: "meta",
        content: "Meta body",
        hashtags: [],
      },
      {
        platform: "instagram",
        content: "IG caption",
        hashtags: ["launch", "sale"],
      },
      {
        platform: "line",
        content: "LINE message",
        hashtags: [],
      },
    ],
  });

  assert.equal(previews.meta.publishPayload.message, "Meta body");
  assert.equal(previews.meta.preview.message, previews.meta.publishPayload.message);
  assert.equal(previews.instagram.publishPayload.caption, "IG caption\n\n#launch #sale");
  assert.equal(previews.instagram.preview.caption, previews.instagram.publishPayload.caption);
  assert.equal(previews.line.publishPayload.text, "LINE message");
  assert.equal(previews.line.preview.text, previews.line.publishPayload.text);
});
