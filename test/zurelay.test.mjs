import { test } from "node:test";
import assert from "node:assert/strict";
import { videoFailureMessage } from "../src/zurelay.mjs";

const includes = (actual, expected, msg) =>
  assert.ok(String(actual).includes(expected), msg ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);

test("a declined video: replace mode is pointed at a new version, a new version at images=off", () => {
  const error = { code: "content_policy" };
  const replace = videoFailureMessage(error, { mode: "replace", project: "arctic-air" });
  includes(replace, "Make a new version");
  assert.ok(!replace.includes("images=off"), replace);
  const fresh = videoFailureMessage(error, { mode: "new", project: "arctic-air" });
  includes(fresh, "zuverse set arctic-air images=off");
  includes(fresh, "zuverse render arctic-air --yes");
  assert.ok(!fresh.includes("Make a new version"), fresh);
  // No mode known: the old advice.
  includes(videoFailureMessage(error), "Make a new version");
  includes(videoFailureMessage({ code: "generation_timeout" }, { mode: "new" }), "took too long");
});
