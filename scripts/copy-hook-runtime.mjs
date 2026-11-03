#!/usr/bin/env node
// Copies the compiled agentBackend/modelAliases modules from out/src/core
// into hooks/ so they ship inside the packaged VSIX next to
// tycoon-claude-hook.cjs (which requires them for generic backend-aware
// routing). Run after `tsc -p .` (both in vscode:prepublish and in normal
// dev builds) so the hook installer in panel.ts always has a same-directory
// copy available, and only falls back to out/src/core for a dev checkout
// that hasn't built yet.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "out", "src", "core");
const destDir = join(root, "hooks");

const files = ["agentBackend.js", "modelAliases.js", "delegationEnforcement.js", "fallbackChain.js", "localEnvStore.js"];

mkdirSync(destDir, { recursive: true });

for (const file of files) {
  const src = join(srcDir, file);
  if (!existsSync(src)) {
    console.error(`[copy-hook-runtime] missing compiled file: ${src} (run tsc -p . first)`);
    process.exitCode = 1;
    continue;
  }
  copyFileSync(src, join(destDir, file));
  console.log(`[copy-hook-runtime] copied ${file} -> hooks/${file}`);
}

// hooks/pack-mcp-links.json: pack agent id -> linked MCP server id(s), generated from
// media/packs/catalog.json so the dispatcher (run from ~/.tycoonagents/bin, with no media/ beside it)
// can find an agent's server. A parity test fails if the committed file drifts.
export function buildPackMcpLinks(catalog) {
  const packs = Array.isArray(catalog) ? catalog : catalog && Array.isArray(catalog.packs) ? catalog.packs : [];
  const out = {};
  for (const pack of packs) {
    if (!pack || typeof pack.mcp !== "string") continue;
    for (const key of new Set([pack.id, pack.agent && pack.agent.id])) {
      if (typeof key !== "string" || !key) continue;
      out[key] = out[key] || [];
      if (!out[key].includes(pack.mcp)) out[key].push(pack.mcp);
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
try {
  const catalog = JSON.parse(readFileSync(join(root, "media", "packs", "catalog.json"), "utf8").replace(/^\uFEFF/, ""));
  writeFileSync(join(destDir, "pack-mcp-links.json"), JSON.stringify(buildPackMcpLinks(catalog), null, 2) + "\n");
  console.log("[copy-hook-runtime] wrote hooks/pack-mcp-links.json");
} catch (err) {
  console.error(`[copy-hook-runtime] could not generate pack-mcp-links.json: ${err && err.message}`);
  process.exitCode = 1;
}
