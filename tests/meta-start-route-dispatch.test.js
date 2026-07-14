import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Meta start POST uses the production dispatcher for JSON and native form requests", async () => {
  const routeSource = await readFile(
    new URL("../src/app/api/platform-connections/meta/start/route.js", import.meta.url),
    "utf8",
  );
  assert.match(routeSource, /import \{ dispatchMetaStartRequest \} from "\.\/meta-start-dispatch\.js";/);
  assert.match(routeSource, /dispatchMetaStartRequest\(request, handlers\)/);

  const { dispatchMetaStartRequest } = await import(
    "../src/app/api/platform-connections/meta/start/meta-start-dispatch.js"
  );
  const calls = [];
  const handlers = {
    async startMeta(request) {
      calls.push(["json", request]);
      return new Response("json");
    },
    async startMetaRedirect(request) {
      calls.push(["form", request]);
      return new Response(null, { status: 303 });
    },
  };

  const jsonRequest = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const formRequest = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "returnPath=%2Fsettings",
  });
  const formWithCharsetRequest = new Request("https://publisher.example/api/platform-connections/meta/start", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "returnPath=%2Fsettings",
  });

  assert.equal((await dispatchMetaStartRequest(jsonRequest, handlers)).status, 200);
  assert.equal((await dispatchMetaStartRequest(formRequest, handlers)).status, 303);
  assert.equal((await dispatchMetaStartRequest(formWithCharsetRequest, handlers)).status, 303);
  assert.deepEqual(calls, [
    ["json", jsonRequest],
    ["form", formRequest],
    ["form", formWithCharsetRequest],
  ]);
});
