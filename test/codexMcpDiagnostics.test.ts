/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Codex config.toml server-name parsing and its rendering in the diagnostic report: names only,
// tolerant of BOM / CRLF / comments / single quotes, nothing leaks from inline tables or dotted
// keys, and a hostile name cannot inject markdown or HTML into the report.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCodexMcpServerNames } from "../src/core/codexConfigServers";
import { buildDiagnosticReport } from "../src/host/vscode/diagnosticReport";

function report(codexMcpServerNames: string[], mcpServerIds: string[] = []): string {
  return buildDiagnosticReport({
    timestamp: "2026-11-03T00:00:00.000Z",
    roots: {},
    engines: { chips: [], uefn: null, mcpServerIds, codexMcpServerNames },
  });
}

test("parser: BOM and CRLF line endings", () => {
  const toml = "﻿[mcp_servers.alpha]\r\ncommand = \"x\"\r\n[mcp_servers.beta]\r\n";
  assert.deepEqual(parseCodexMcpServerNames(toml), ["alpha", "beta"]);
});

test("parser: trailing comment on a header and single-quoted names", () => {
  const toml = "[mcp_servers.alpha] # my server\n[mcp_servers.'Roblox Studio']\ncommand = 'x'\n";
  assert.deepEqual(parseCodexMcpServerNames(toml), ["alpha", "Roblox Studio"]);
});

test("parser: inline tables and dotted keys under [mcp_servers] yield no names and leak no values", () => {
  const inline = "mcp_servers = { x = { command = \"INLINE-SECRET\" } }\n";
  const dotted = "[mcp_servers]\nx.command = \"DOTTED-SECRET\"\nx.env.TOKEN = \"DOTTED-SECRET\"\n";
  assert.deepEqual(parseCodexMcpServerNames(inline), []);
  assert.deepEqual(parseCodexMcpServerNames(dotted), []);
  assert.doesNotMatch(report(parseCodexMcpServerNames(inline + dotted)), /SECRET/);
});

test("report: a hostile server name renders inertly", () => {
  const toml = "[mcp_servers.\"a`<img src=x onerror=1>|b\"]\ncommand = \"x\"\n";
  const names = parseCodexMcpServerNames(toml);
  assert.equal(names.length, 1);
  const row = report(names).split("\n").find((l) => l.includes("Configured MCP servers"))!;
  assert.ok(row);
  assert.doesNotMatch(row, /<|>/);
  assert.equal((row.match(/`/g) ?? []).length, 2);
  assert.match(row, /`a_+img src=x onerror=1_+b \(Codex\)`/);
});

test("report: a Codex name embedding a token is redacted by the final sanitize pass", () => {
  const md = report(["tok-sk-abcdefghijklmnopqrstuvwxyz123456"]);
  assert.doesNotMatch(md, /sk-abcdefghijklmnopqrstuvwxyz123456/);
});

test("report: Codex names dedupe against project MCP ids case-insensitively", () => {
  const md = report(["Roblox-Studio", "Other"], ["roblox-studio"]);
  assert.doesNotMatch(md, /Roblox-Studio \(Codex\)/);
  assert.match(md, /`Other \(Codex\)`/);
});
