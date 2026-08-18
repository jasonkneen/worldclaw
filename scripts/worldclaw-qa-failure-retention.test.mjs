import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const sourceUrl = new URL("./worldclaw-qa.mjs", import.meta.url);

test("failure screenshot is captured before slow evidence and cannot be overwritten", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const start = source.indexOf("async function retainGenerationFailure");
  const end = source.indexOf("async function waitForFinalValidation", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /if \(!failureScreenshotRetained\)/);
  assert.match(body, /page\.screenshot\(\{ path: failureScreenshotPath \}\)/);
  assert.match(body, /failureScreenshotRetained = true/);
  assert.ok(
    body.indexOf("page.screenshot") < body.indexOf("persistPrebuildReferenceEvidence"),
    "failure screenshot must precede slower evidence persistence",
  );
  assert.ok(
    body.indexOf("page.screenshot") < body.indexOf("persistCommitteeEvidence"),
    "failure screenshot must precede committee persistence",
  );
  assert.doesNotMatch(body, /capture\(page, "worldclaw-process-failure\.png"\)/);
});
