// generate-opencode-config.mjs: the "Single-pass review gate" enforcement rule
// is only emitted while the Review pass is on in execution.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function generate(reviewEnabled: boolean | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "tycoon-oc-review-"));
  try {
    mkdirSync(join(root, ".claude", "tycoon"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# Project", "utf8");
    if (reviewEnabled !== undefined) {
      writeFileSync(join(root, ".claude", "tycoon", "execution.json"), JSON.stringify({ reviewEnabled }), "utf8");
    }
    execFileSync(process.execPath, [join(process.cwd(), "scripts", "generate-opencode-config.mjs"), "--root", root], { stdio: "pipe" });
    return readFileSync(join(root, "AGENTS.md"), "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("OpenCode AGENTS.md: review-off (default or explicit) drops the review gate rule; review-on keeps it", () => {
  for (const off of [generate(undefined), generate(false)]) {
    assert.doesNotMatch(off, /Single-pass review gate/);
    assert.match(off, /enforces three rules/);
    assert.match(off, /3\. \*\*Leaf workers never spawn/);
  }
  const on = generate(true);
  assert.match(on, /Single-pass review gate/);
  assert.match(on, /enforces four rules/);
  assert.match(on, /4\. \*\*Leaf workers never spawn/);
});
