import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never let a test reach the real Claude config (~/.claude.json) or the real `claude` binary.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-claude-cfg-"));
process.env.TYCOON_CLAUDE_BIN = "none";

import { BRIDGE_PACK_ID, buildOtherAgent, installBridgeSelection } from "../src/core/bridgeSetup";
import { agentIdFromName, installProviderWorkers, validateWorkingSpec } from "../src/core/providerWorkingAgent";
import type { WorkingAgentSpec } from "../src/core/providerWorkingAgent";
import { agentMarkdownIsRelayManaged } from "../src/core/agentRelay";
import { isReviewerClassAgent } from "../src/core/agentSettingsRoute";
import { readAgentFrontmatter } from "../src/core/agentBackend";
import type { PackAgent } from "../src/host/vscode/packCatalog";

/*
 * "Add an agent from another provider" as a Working agent (the default role): a new managed
 * relay agent through the routing Save path, Codex gets codex-write, never an overwrite.
 */

const REPO = process.cwd();
const PACK = (JSON.parse(fs.readFileSync(path.join(REPO, "media", "packs", "catalog.json"), "utf8")) as any[]).find((p) => p.id === BRIDGE_PACK_ID);
const PACK_AGENTS: PackAgent[] = PACK.agents;
const REVIEW_SENTENCE = "This agent reviews; it does not author, edit, or fix";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "provider-worker-"));
}

function install(root: string, specs: WorkingAgentSpec[], harness = "claude-code") {
  return installProviderWorkers({ root, specs, packAgents: PACK_AGENTS, harness, scriptsDir: REPO });
}

const agentFile = (root: string, id: string): string => path.join(root, ".claude", "agents", `${id}.md`);
const readRouting = (root: string): any => JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "routing.json"), "utf8"));

test("agent id is derived from the name as kebab-case", () => {
  assert.equal(agentIdFromName("Artist"), "artist");
  assert.equal(agentIdFromName("  Sprite Painter 2! "), "sprite-painter-2");
});

test("a Codex working agent named artist is a non-reviewer relay with codex-write", () => {
  const root = tmpProject();
  const res = install(root, [{ provider: "codex", name: "artist", role: "Draws sprites and textures.", keywords: "art, sprite" }]);
  assert.equal(res.ok, true, JSON.stringify(res));
  const text = fs.readFileSync(agentFile(root, "artist"), "utf8");
  assert.ok(agentMarkdownIsRelayManaged(text), "file is a managed relay");
  const fm = readAgentFrontmatter(text);
  assert.equal(fm["tycoon_relay"], "codex-write");
  assert.equal(isReviewerClassAgent("artist", fm), false);
  assert.ok(!text.includes(REVIEW_SENTENCE));
  assert.match(text, /mcp__codex-write__codex/);
  const slot = readRouting(root).agents["artist"];
  assert.equal(slot.mcpServer, "codex-write");
  assert.equal(slot.vendor, "openai");
  assert.equal(res.created[0].keywords, "art|sprite");
});

test("a Gemini working agent follows the existing relay rules for its bridge", () => {
  const root = tmpProject();
  const res = install(root, [{ provider: "gemini", name: "Scribe" }]);
  assert.equal(res.ok, true, JSON.stringify(res));
  const fm = readAgentFrontmatter(fs.readFileSync(agentFile(root, "scribe"), "utf8"));
  assert.equal(fm["tycoon_relay"], "gemini");
  assert.equal(readRouting(root).agents["scribe"].mcpServer, "gemini");
});

test("the Codex harness writes the backend block and no relay", () => {
  const root = tmpProject();
  const res = install(root, [{ provider: "codex", name: "artist" }], "codex");
  assert.equal(res.ok, true, JSON.stringify(res));
  const text = fs.readFileSync(agentFile(root, "artist"), "utf8");
  assert.ok(!agentMarkdownIsRelayManaged(text));
  assert.ok(fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")));
});

test("the Reviewer choice is unchanged: fixed entries stay reviewer-class and keep read-only wording", async () => {
  const root = tmpProject();
  const res = await installBridgeSelection({
    root,
    packAgents: PACK_AGENTS,
    selectedAgentIds: ["codex-reviewer"],
    others: [],
    harness: "codex",
    claudeSubscriptionOptIn: false,
    installMcp: () => "exists",
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const text = fs.readFileSync(agentFile(root, "codex-reviewer"), "utf8");
  assert.equal(isReviewerClassAgent("codex-reviewer", readAgentFrontmatter(text)), true);
  const other = buildOtherAgent({ agentId: "local-judge", label: "Local judge", model: "llama3", endpointEnv: "OLLAMA_BASE_URL" });
  assert.ok(String(other.body).includes(REVIEW_SENTENCE));
});

test("an Other working agent has no review sentence and relays through the OpenAI-compatible server", () => {
  const root = tmpProject();
  const res = install(root, [{ provider: "other", name: "local-coder", label: "Local coder", model: "llama3", endpointEnv: "OLLAMA_BASE_URL", role: "Writes small utilities." }]);
  assert.equal(res.ok, true, JSON.stringify(res));
  const text = fs.readFileSync(agentFile(root, "local-coder"), "utf8");
  assert.ok(!text.includes(REVIEW_SENTENCE));
  assert.equal(readAgentFrontmatter(text)["tycoon_relay"], "openai-compatible");
  assert.equal(isReviewerClassAgent("local-coder", readAgentFrontmatter(text)), false);
  const slot = readRouting(root).agents["local-coder"];
  assert.equal(slot.vendor, "custom");
  assert.equal(slot.endpointEnv, "OLLAMA_BASE_URL");
});

test("an id collision is refused and nothing is overwritten", () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  const original = "---\nname: artist\nmodel: sonnet\n---\n\n# Mine\n";
  fs.writeFileSync(agentFile(root, "artist"), original);
  const res = install(root, [{ provider: "codex", name: "Artist" }]);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /already exists/);
  assert.equal(fs.readFileSync(agentFile(root, "artist"), "utf8"), original);
  assert.ok(!fs.existsSync(path.join(root, ".claude", "tycoon", "routing.json")));
  // A pack id and a reserved id collide too.
  assert.equal(install(tmpProject(), [{ provider: "codex", name: "codex-reviewer" }]).ok, false);
  assert.ok(validateWorkingSpec({ provider: "codex", name: "orchestrator" }, PACK_AGENTS, []).length > 0);
});

test("a batch with one collision installs none of it", () => {
  const root = tmpProject();
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(agentFile(root, "taken"), "---\nname: taken\n---\n");
  const res = install(root, [{ provider: "codex", name: "fresh" }, { provider: "gemini", name: "taken" }]);
  assert.equal(res.ok, false);
  assert.ok(!fs.existsSync(agentFile(root, "fresh")));
});

test("a name is required", () => {
  assert.deepEqual(validateWorkingSpec({ provider: "codex", name: "  " }, PACK_AGENTS, []), ["Enter a name for the agent."]);
});

test("a failed save restores routing.json and the agents folder byte for byte", () => {
  const root = tmpProject();
  const dir = path.join(root, ".claude");
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "keep.md"), "---\nname: keep\nmodel: sonnet\n---\n\n# Keep\n");
  const routing = JSON.stringify({ version: 1, agents: {} }, null, 2) + "\r\n";
  fs.writeFileSync(path.join(dir, "tycoon", "routing.json"), routing);
  const snap = (): string => fs.readdirSync(path.join(dir, "agents")).sort().join(",") + "|" + fs.readFileSync(path.join(dir, "tycoon", "routing.json"), "utf8");
  const before = snap();
  // An empty scripts dir makes the generators fail after routing.json was already written.
  const emptyScripts = fs.mkdtempSync(path.join(os.tmpdir(), "no-scripts-"));
  const res = installProviderWorkers({ root, specs: [{ provider: "codex", name: "artist" }], packAgents: PACK_AGENTS, harness: "claude-code", scriptsDir: emptyScripts });
  assert.equal(res.ok, false);
  assert.ok(res.errors.join(" ").length > 0);
  assert.equal(snap(), before);
  // No routing.json before: none after.
  const root2 = tmpProject();
  const res2 = installProviderWorkers({ root: root2, specs: [{ provider: "codex", name: "artist" }], packAgents: PACK_AGENTS, harness: "claude-code", scriptsDir: emptyScripts });
  assert.equal(res2.ok, false);
  assert.ok(!fs.existsSync(path.join(root2, ".claude", "tycoon", "routing.json")));
  assert.ok(!fs.existsSync(agentFile(root2, "artist")));
});

test("a Codex working agent whose role says review stays read-only and the host gets a notice", () => {
  const root = tmpProject();
  const res = install(root, [{ provider: "codex", name: "checker", role: "Reviews art assets for style." }]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(readRouting(root).agents["checker"].mcpServer, "codex");
  assert.ok(res.relayNotices.some((n) => /read-only/.test(n)), JSON.stringify(res.relayNotices));
});

test("both hosts hand relay notices to the webview and the standalone bounds worker input", () => {
  const server = fs.readFileSync(path.join(REPO, "standalone", "src", "server.mjs"), "utf8");
  const panel = fs.readFileSync(path.join(REPO, "src", "host", "vscode", "panel.ts"), "utf8");
  assert.match(server, /notices: workerNotices/);
  assert.match(panel, /notices: wres\.relayNotices/);
  assert.match(server, /WORKER_LIMITS = \{ provider: 20, name: 80, label: 200, role: 500, keywords: 500/);
});
