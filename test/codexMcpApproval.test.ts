/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Ticket #41: `codex exec -c approval_policy=never` auto-rejects MCP tools that need approval, so the
// roblox specialist could not write to Studio. A non-read-only specialist linked to an MCP server the
// user installed gets default_tools_approval_mode="approve" for that one server. Fakes are Node scripts
// (win32: behind a .cmd shim), never executables; nothing touches the real home dir.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { parseCodexMcpServerNames, readCodexConfigMcpServerNames } from "../src/core/codexConfigServers";
import { MCP_BRIDGE_HOOK_FILES } from "../src/host/vscode/hookInstall";
import { buildDiagnosticReport, type DiagnosticReportInput } from "../src/host/vscode/diagnosticReport";

/* eslint-disable @typescript-eslint/no-var-requires */
const adapters = require("../../hooks/dispatcherAdapters.cjs") as {
  codexMcpApprovalArgs: (info: Record<string, unknown>, bin: string, cwd: string, env: Record<string, string | undefined>, shell: boolean, runner?: (...a: unknown[]) => Promise<Record<string, unknown>>) => Promise<string[]>;
  resetCodexMcpNamesCache: () => void;
  openaiAdapter: (task: string, info: Record<string, unknown>) => Promise<{ text?: string; error?: string }>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

beforeEach(() => adapters.resetCodexMcpNamesCache());

function project(agents: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-appr-"));
  fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  for (const [id, fm] of Object.entries(agents)) fs.writeFileSync(path.join(dir, ".claude", "agents", `${id}.md`), `---\nname: ${id}\n${fm}\n---\nBody\n`);
  return dir;
}

const BUILDER = "tools: Read, Edit, Write, Bash, mcp__roblox-studio__*";
const REVIEWER = "tools: Read, Grep, mcp__roblox-studio__*";

function lister(names: unknown, calls: { n: number }) {
  return async () => { calls.n++; return { code: 0, stdout: JSON.stringify(names), stderr: "" }; };
}

async function argsFor(id: string, dir: string, names: unknown, calls = { n: 0 }) {
  return adapters.codexMcpApprovalArgs({ workerId: id, projectDir: dir, harness: "codex" }, "codex", dir, {}, false, lister(names, calls));
}

test("linked + listed + non-reviewer agent gets the approve arg; Roblox_Studio matches roblox-studio", async () => {
  const dir = project({ roblox: BUILDER });
  try {
    const args = await argsFor("roblox", dir, [{ name: "Roblox_Studio", transport: { type: "stdio" } }, { name: "other" }]);
    assert.deepEqual(args, ["-c", 'mcp_servers.Roblox_Studio.default_tools_approval_mode="approve"']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a reviewer (read-only) agent gets none and never lists servers", async () => {
  const dir = project({ rev: REVIEWER });
  try {
    const calls = { n: 0 };
    assert.deepEqual(await argsFor("rev", dir, [{ name: "Roblox_Studio" }], calls), []);
    assert.equal(calls.n, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a linked server that is not listed gets none; the tycoon server is never approved", async () => {
  const dir = project({ roblox: BUILDER, t: "tools: Read, Edit, mcp__tycoon__delegate" });
  try {
    assert.deepEqual(await argsFor("roblox", dir, [{ name: "something-else" }]), []);
    assert.deepEqual(await argsFor("t", dir, [{ name: "tycoon" }]), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pack catalog link is the fallback when the agent file records no server", async () => {
  const dir = project({ roblox: "tools: Read, Edit, Write" });
  try {
    const args = await argsFor("roblox", dir, [{ name: "roblox-studio" }]);
    assert.deepEqual(args, ["-c", 'mcp_servers.roblox-studio.default_tools_approval_mode="approve"']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("listing failure fails open with one warning and no args", async () => {
  const dir = project({ roblox: BUILDER });
  const orig = process.stderr.write;
  let warned = 0;
  process.stderr.write = ((c: unknown) => { if (String(c).includes("could not list Codex MCP servers")) warned++; return true; }) as typeof process.stderr.write;
  try {
    const failing = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const a = await adapters.codexMcpApprovalArgs({ workerId: "roblox", projectDir: dir }, "codex", dir, {}, false, failing);
    const b = await adapters.codexMcpApprovalArgs({ workerId: "roblox", projectDir: dir }, "codex", dir, {}, false, failing);
    assert.deepEqual(a, []);
    assert.deepEqual(b, []);
    assert.equal(warned, 1);
  } finally { process.stderr.write = orig; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a non-bare server name uses a quoted TOML key", async () => {
  const dir = project({ roblox: BUILDER });
  try {
    const q = await argsFor("roblox", dir, [{ name: "roblox.studio" }]);
    assert.deepEqual(q, ["-c", 'mcp_servers."roblox.studio".default_tools_approval_mode="approve"']);
    adapters.resetCodexMcpNamesCache();
    const shell = await adapters.codexMcpApprovalArgs({ workerId: "roblox", projectDir: dir }, "codex", dir, {}, true, lister([{ name: "roblox.studio" }], { n: 0 }));
    assert.equal(shell[1], 'mcp_servers.\\"roblox.studio\\".default_tools_approval_mode=\\"approve\\"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeCodex(listJson: string): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-mcp-"));
  const script = [
    "const a = process.argv.slice(2);",
    "if (a[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }",
    "process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => {",
    `if (a[0] === 'mcp') { console.log(${JSON.stringify(listJson)}); process.exit(0); }`,
    "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:a.join(' ')}}));",
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

test("openaiAdapter end to end: builder argv has the approve arg, sandbox flag unchanged; reviewer has none", async () => {
  const proj = project({ roblox: BUILDER, rev: REVIEWER });
  const fake = fakeCodex(JSON.stringify([{ name: "Roblox_Studio" }]));
  const prev = process.env.CODEX_BINARY_PATH;
  process.env.CODEX_BINARY_PATH = fake.bin;
  try {
    const built = await adapters.openaiAdapter("go", { harness: "codex", vendor: "openai", workerId: "roblox", projectDir: proj });
    assert.match(built.text ?? "", /-s workspace-write/);
    assert.match(built.text ?? "", /mcp_servers\.Roblox_Studio\.default_tools_approval_mode="?approve"?/);
    const rev = await adapters.openaiAdapter("go", { harness: "codex", vendor: "openai", workerId: "rev", projectDir: proj });
    assert.match(rev.text ?? "", /-s read-only/);
    assert.doesNotMatch(rev.text ?? "", /default_tools_approval_mode/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BINARY_PATH; else process.env.CODEX_BINARY_PATH = prev;
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("config.toml discovery lists server names only (CODEX_HOME first, then ~/.codex)", () => {
  const toml = '[mcp_servers.Roblox_Studio]\ncommand = "x"\nargs = ["--token", "SECRET-VALUE"]\n[mcp_servers.Roblox_Studio.env]\nKEY = "SECRET-VALUE"\n[mcp_servers."my.server"]\nurl = "https://x"\n[model_providers.foo]\nname = "n"\n';
  assert.deepEqual(parseCodexMcpServerNames(toml), ["Roblox_Studio", "my.server"]);
  const override = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
  try {
    fs.writeFileSync(path.join(override, "config.toml"), toml);
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "[mcp_servers.fromhome]\n");
    assert.deepEqual(readCodexConfigMcpServerNames({ CODEX_HOME: override }, home), ["Roblox_Studio", "my.server"]);
    assert.deepEqual(readCodexConfigMcpServerNames({}, home), ["fromhome"]);
    assert.deepEqual(readCodexConfigMcpServerNames({}, path.join(home, "missing")), []);
  } finally {
    fs.rmSync(override, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("diagnostic report lists Codex server names marked as from Codex, never values", () => {
  const input: DiagnosticReportInput = {
    timestamp: "2026-11-03T00:00:00.000Z",
    roots: {},
    engines: { chips: [], uefn: null, mcpServerIds: ["uefn-bridge"], codexMcpServerNames: parseCodexMcpServerNames('[mcp_servers.Roblox_Studio]\nargs = ["SECRET-VALUE"]\n[mcp_servers.Roblox_Studio.env]\nTOKEN = "SECRET-VALUE"\n') },
  };
  const md = buildDiagnosticReport(input);
  assert.match(md, /`uefn-bridge`, `Roblox_Studio \(Codex\)`/);
  assert.doesNotMatch(md, /SECRET-VALUE/);
});

test("pack-mcp-links.json matches media/packs/catalog.json (regenerate with copy-hook-runtime)", () => {
  const root = path.resolve(__dirname, "..", "..");
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "media", "packs", "catalog.json"), "utf8").replace(/^\uFEFF/, "")) as Array<{ id: string; mcp?: string | null; agent?: { id?: string } }>;
  const expected: Record<string, string[]> = {};
  for (const pack of catalog) {
    if (typeof pack.mcp !== "string") continue;
    for (const key of new Set([pack.id, pack.agent?.id])) {
      if (!key) continue;
      (expected[key] = expected[key] ?? []);
      if (!expected[key].includes(pack.mcp)) expected[key].push(pack.mcp);
    }
  }
  const actual = JSON.parse(fs.readFileSync(path.join(root, "hooks", "pack-mcp-links.json"), "utf8")) as Record<string, string[]>;
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.roblox, ["roblox-studio"]);
});

test("stable bridge dir copy (no media/ beside it) still approves the roblox server via pack-mcp-links.json", async () => {
  const root = path.resolve(__dirname, "..", "..");
  const stable = fs.mkdtempSync(path.join(os.tmpdir(), "stable-bridge-"));
  for (const f of MCP_BRIDGE_HOOK_FILES) {
    const src = path.join(root, "hooks", f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stable, f));
  }
  fs.writeFileSync(path.join(stable, "package.json"), '{"type":"commonjs"}');
  assert.ok(fs.existsSync(path.join(stable, "pack-mcp-links.json")));
  assert.ok(!fs.existsSync(path.join(stable, "..", "media", "packs", "catalog.json")));
  const proj = project({ roblox: "tools: Read, Edit, Write" });
  const fake = fakeCodex(JSON.stringify([{ name: "Roblox_Studio" }]));
  const prev = process.env.CODEX_BINARY_PATH;
  process.env.CODEX_BINARY_PATH = fake.bin;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const copied = require(path.join(stable, "dispatcherAdapters.cjs")) as typeof adapters;
    const r = await copied.openaiAdapter("go", { harness: "codex", vendor: "openai", workerId: "roblox", projectDir: proj });
    assert.match(r.text ?? "", /-s workspace-write/);
    assert.match(r.text ?? "", /mcp_servers\.Roblox_Studio\.default_tools_approval_mode="?approve"?/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BINARY_PATH; else process.env.CODEX_BINARY_PATH = prev;
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(stable, { recursive: true, force: true });
  }
});

test("report built from a fixture CODEX_HOME config.toml shows Roblox_Studio (Codex) and no env/args values", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-report-"));
  try {
    fs.writeFileSync(path.join(codexHome, "config.toml"), '[mcp_servers.Roblox_Studio]\ncommand = "studio-mcp"\nargs = ["--key", "ARG-SECRET-1"]\n[mcp_servers.Roblox_Studio.env]\nROBLOX_TOKEN = "ENV-SECRET-2"\n');
    const md = buildDiagnosticReport({
      timestamp: "2026-11-03T00:00:00.000Z",
      roots: {},
      engines: { chips: [], uefn: null, mcpServerIds: [], codexMcpServerNames: readCodexConfigMcpServerNames({ CODEX_HOME: codexHome }, path.join(codexHome, "no-home")) },
    });
    assert.match(md, /`Roblox_Studio \(Codex\)`/);
    assert.doesNotMatch(md, /ARG-SECRET-1|ENV-SECRET-2|ROBLOX_TOKEN|studio-mcp/);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
