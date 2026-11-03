/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TABLE_RE = /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;

/**
 * Extracts the server names from `[mcp_servers.<name>]` table headers of a Codex
 * config.toml. Names only: args, env and every other value are never read.
 */
export function parseCodexMcpServerNames(toml: string): string[] {
  const names: string[] = [];
  for (const line of toml.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(TABLE_RE);
    if (!m) continue;
    const name = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * MCP server names defined in the user's Codex config. Discovery ladder: the
 * CODEX_HOME override, else `<home>/.codex`. Fail-open: any read problem
 * returns []. The home and env are injectable so tests never touch the real one.
 */
export function readCodexConfigMcpServerNames(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string[] {
  const override = env.CODEX_HOME && env.CODEX_HOME.trim();
  const codexHome = override ? override : path.join(homeDir, ".codex");
  try {
    return parseCodexMcpServerNames(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"));
  } catch {
    return [];
  }
}
