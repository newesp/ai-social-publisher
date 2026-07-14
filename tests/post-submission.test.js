import assert from "node:assert/strict";
import test from "node:test";

import { SCHEDULE_TIME, buildPostSubmission } from "../src/lib/wizard/post-submission.js";

test("builds the post request from the edited preview targets", () => {
  const payload = buildPostSubmission({
    form: { productName: "Demo", productFeatures: "Fast", mode: "now" },
    imageUrl: "https://example.test/image.png",
    targets: [
      { platform: "meta", content: "Edited Facebook copy", hashtags: ["launch"] },
      { platform: "line", content: "Edited LINE copy", hashtags: [] },
    ],
  });

  assert.deepEqual(payload, {
    productName: "Demo",
    productFeatures: "Fast",
    imageUrl: "https://example.test/image.png",
    mode: "now",
    targets: [
      { platform: "meta", content: "Edited Facebook copy", hashtags: ["launch"] },
      { platform: "line", content: "Edited LINE copy", hashtags: [] },
    ],
  });
});

test("only permits 09:00 and rejects a past Taipei schedule date", () => {
  assert.equal(SCHEDULE_TIME, "09:00");
  assert.throws(
    () => buildPostSubmission({
      form: { productName: "Demo", productFeatures: "Fast", mode: "scheduled", scheduledDate: "2026-07-10", scheduledTime: "09:00" },
      targets: [{ platform: "meta", content: "Copy", hashtags: [] }],
      now: new Date("2026-07-11T00:00:00.000Z"),
    }),
    /不能早於今天/,
  );
  assert.equal(buildPostSubmission({
    form: { productName: "Demo", productFeatures: "Fast", mode: "scheduled", scheduledDate: "2026-07-11", scheduledTime: "09:00" },
    targets: [{ platform: "meta", content: "Copy", hashtags: [] }],
    now: new Date("2026-07-11T00:00:00.000Z"),
  }).scheduledTime, "09:00");
});

test("uses the displayed 09:00 default when the schedule time was not changed", () => {
  const payload = buildPostSubmission({
    form: { productName: "Demo", productFeatures: "Fast", mode: "scheduled", scheduledDate: "2026-07-11" },
    targets: [{ platform: "meta", content: "Copy", hashtags: [] }],
    now: new Date("2026-07-10T00:00:00.000Z"),
  });

  assert.equal(payload.scheduledTime, "09:00");
});
