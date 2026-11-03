/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tickets #39/#40: Codex-run agents showed tasks but 0 tokens.
// (a) native subagent tokens come from the rollout's cumulative token_count
// events, emitted as deltas so a re-read never double counts; (b) the
// dispatcher's `codex exec` adapter returns usage parsed from --json output.
// All filesystem work is in temp dirs; fakes are Node scripts (win32: behind a
// .cmd shim), never executables.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/* eslint-disable @typescript-eslint/no-var-requires */
const codexHook = require("../../hooks/tycoon-codex-hook.cjs") as {
  mapNotifyPayload: (p: Record<string, unknown>, activityFile: string, at: number, env?: Record<string, string | undefined>) => Array<Record<string, unknown>>;
};
const codexRollout = require("../../hooks/codexRollout.cjs") as {
  readRolloutTokenTotals: (f: string) => { input_tokens: number; output_tokens: number } | null;
};
const dispatcherAdapters = require("../../hooks/dispatcherAdapters.cjs") as {
  openaiAdapter: (task: string, info: Record<string, unknown>) => Promise<{ text?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: string }>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const THREAD = "0aaaaaaa-1111-7222-8333-444444444444";
const PARENT = "0bbbbbbb-1111-7222-8333-444444444444";

function tokenEvent(total: [number, number], last: [number, number]): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total[0], output_tokens: total[1], total_tokens: total[0] + total[1] },
        last_token_usage: { input_tokens: last[0], output_tokens: last[1], total_tokens: last[0] + last[1] },
      },
    },
  });
}

function makeHome(lines: string[]): { home: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tokens-"));
  const dir = path.join(home, "sessions", "2026", "11", "02");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-02T10-00-00-${THREAD}.jsonl`);
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { id: THREAD, thread_source: "subagent", agent_path: "/root/search_retrieval_1", parent_thread_id: PARENT, originator: "codex_cli" },
  });
  fs.writeFileSync(file, [meta, ...lines].join("\n") + "\n");
  return { home, file };
}

test("readRolloutTokenTotals: takes the last cumulative total_token_usage, not a sum of per-turn values", () => {
  const { home, file } = makeHome([
    tokenEvent([100, 10], [100, 10]),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
    tokenEvent([250, 40], [150, 30]),
    tokenEvent([250, 40], [150, 30]), // duplicate event must not add anything
  ]);
  try {
    assert.deepEqual(codexRollout.readRolloutTokenTotals(file), { input_tokens: 250, output_tokens: 40 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("readRolloutTokenTotals: missing file or no token_count events fails open to null", () => {
  assert.equal(codexRollout.readRolloutTokenTotals(path.join(os.tmpdir(), "no-such-rollout.jsonl")), null);
  const { home, file } = makeHome([]);
  try {
    assert.equal(codexRollout.readRolloutTokenTotals(file), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("mapNotifyPayload: subagent SubagentStop carries rollout tokens once; re-read adds only the new delta", () => {
  const { home, file } = makeHome([tokenEvent([100, 10], [100, 10])]);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tokens-proj-"));
  const activityFile = path.join(projectDir, "activity.jsonl");
  const env = { CODEX_HOME: home, CLAUDE_PROJECT_DIR: projectDir };
  const prevProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  try {
    const payload = { type: "agent-turn-complete", "thread-id": THREAD };
    const append = (recs: Array<Record<string, unknown>>) => fs.appendFileSync(activityFile, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const t1 = codexHook.mapNotifyPayload(payload, activityFile, 1000, env);
    append(t1);
    assert.equal(t1.find((r) => r.event === "SubagentStop")!.tokens, 110);

    // Same rollout re-read: nothing new, no tokens field.
    const t2 = codexHook.mapNotifyPayload(payload, activityFile, 2000, env);
    append(t2);
    assert.equal(t2.find((r) => r.event === "SubagentStop")!.tokens, undefined);

    // Another turn lands in the rollout: only the delta is attributed.
    fs.appendFileSync(file, tokenEvent([300, 50], [200, 40]) + "\n");
    const t3 = codexHook.mapNotifyPayload(payload, activityFile, 3000, env);
    append(t3);
    assert.equal(t3.find((r) => r.event === "SubagentStop")!.tokens, 240);

    const sum = fs.readFileSync(activityFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.event === "SubagentStop").reduce((n, r) => n + (r.tokens || 0), 0);
    assert.equal(sum, 350); // 300 + 50 exactly
  } finally {
    if (prevProject === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevProject;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("mapNotifyPayload: rollout without token_count still records the stop, no tokens (fail-open)", () => {
  const { home } = makeHome([]);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tokens-proj-"));
  const prevProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  try {
    const recs = codexHook.mapNotifyPayload({ type: "agent-turn-complete", "thread-id": THREAD }, path.join(projectDir, "a.jsonl"), 1000, { CODEX_HOME: home });
    const stop = recs.find((r) => r.event === "SubagentStop")!;
    assert.ok(stop);
    assert.equal(stop.tokens, undefined);
    assert.equal(stop.usageReported, undefined);
  } finally {
    if (prevProject === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevProject;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

function withFakeCodex(body: string): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const script = [
    "const a = process.argv.slice(2);",
    "if (a[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }",
    "process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => {",
    body,
    "});",
  ].join("\n");
  if (process.platform === "win32") {
    const js = path.join(dir, "fake-codex.js");
    fs.writeFileSync(js, script);
    const cmd = path.join(dir, "fake-codex.cmd");
    fs.writeFileSync(cmd, `@echo off\r\nnode "${js.replace(/\\/g, "\\\\")}" %*\r\n`);
    return { bin: cmd, dir };
  }
  const bin = path.join(dir, "fake-codex");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, dir };
}

async function runAdapter(body: string) {
  const { bin, dir } = withFakeCodex(body);
  const prev = process.env.CODEX_BINARY_PATH;
  process.env.CODEX_BINARY_PATH = bin;
  try {
    return await dispatcherAdapters.openaiAdapter("do it", { harness: "codex", vendor: "openai", model: "gpt-6.1-terra", agentId: "x", projectDir: dir });
  } finally {
    if (prev === undefined) delete process.env.CODEX_BINARY_PATH; else process.env.CODEX_BINARY_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("openaiAdapter (codex exec): --json turn.completed usage is returned alongside the answer text", async () => {
  const r = await runAdapter(
    [
      "console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));",
      "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done ok'}}));",
      "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1200,cached_input_tokens:1000,output_tokens:34}}));",
    ].join("\n"),
  );
  assert.equal(r.error, undefined);
  assert.equal(r.text, "done ok");
  assert.deepEqual(r.usage, { input_tokens: 1200, output_tokens: 34 });
});

test("openaiAdapter (codex exec): no usage in the output fails open (text kept, usage undefined)", async () => {
  const r = await runAdapter("console.log('plain answer without json');");
  assert.equal(r.error, undefined);
  assert.equal(r.text, "plain answer without json");
  assert.equal(r.usage, undefined);
});
