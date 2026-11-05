import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Compiled to CommonJS; go through new Function so the ESM import survives.
const importEsm = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const SCRIPT_URL = pathToFileURL(join(process.cwd(), "scripts", "run-tests.mjs")).href;

test("batchFiles keeps every batch within budget and each file exactly once", async () => {
  const { batchFiles } = await importEsm(SCRIPT_URL);
  const files = Array.from({ length: 500 }, (_, i) => `C:/a/long/path/out/test/file${i}.test.js`);
  const budget = 2000;
  const batches: string[][] = batchFiles(files, budget);
  assert.ok(batches.length > 1);
  for (const b of batches) assert.ok(b.join(" ").length <= budget);
  assert.deepEqual(batches.flat(), files);
});

test("batchFiles gives an oversized file its own batch and handles empty input", async () => {
  const { batchFiles } = await importEsm(SCRIPT_URL);
  assert.deepEqual(batchFiles([], 100), []);
  const big = "x".repeat(200);
  assert.deepEqual(batchFiles(["a", big, "b"], 100), [["a"], [big], ["b"]]);
});
