/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// "Add an agent from another provider" as a WORKING agent. Host-agnostic (no
// `vscode` import) so src/host/vscode/panel.ts and standalone/src/server.mjs
// share one implementation.
//
// A working agent is an ordinary agent file (name, role, keywords, discipline
// section, no "reviews only" wording) whose routing.json slot names the chosen
// provider. It is then saved through saveRoutingProfile, the same path the
// "Use another provider for this agent" card checkbox uses: on the Claude Code
// harness the generator turns the file into a managed relay (agentRelay.ts); on
// the Codex harness it writes the dispatcher backend block. No second relay
// generator lives here. Codex working agents get the write-access `codex-write`
// server (enforceReviewerReadOnly still downgrades a reviewer-class description).
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { isSafeAgentId } from "../host/vscode/agentConfig";
import { buildAgentMarkdown } from "../host/vscode/packCatalog";
import type { PackAgent } from "../host/vscode/packCatalog";
import { loadRoutingProfile } from "./routingProfile";
import type { RoutingProfile, RoutingSlot } from "./routingProfile";
import { saveRoutingProfile } from "./routingHostOps";
import { enforceReviewerReadOnly } from "./agentSettingsRoute";
import { CODEX_WRITE_SERVER, CUSTOM_VENDOR, OPENAI_COMPAT_SERVER, RESERVED_IDS, SLUG_RE, listAgentIds, normalizeKeywords, validateOtherSpec } from "./bridgeSetup";

export type WorkingProvider = "codex" | "gemini" | "grok" | "kimi" | "mistral" | "other";

/** Pack agent whose backend is the template for each fixed provider (media/packs/catalog.json, multi-llm). */
const PROVIDER_TEMPLATE: Record<Exclude<WorkingProvider, "other">, { packId: string; label: string; prefix: string }> = {
  codex: { packId: "codex-reviewer", label: "Codex", prefix: "openai/" },
  gemini: { packId: "gemini-reviewer", label: "Gemini", prefix: "google/" },
  grok: { packId: "grok-reviewer", label: "Grok", prefix: "xai/" },
  kimi: { packId: "kimi-reviewer", label: "Kimi", prefix: "moonshot/" },
  mistral: { packId: "mistral-reviewer", label: "Mistral", prefix: "mistral/" },
};

export interface WorkingAgentSpec {
  provider: WorkingProvider;
  /** Required. The agent id is derived from it (kebab-case). */
  name: string;
  /** Optional display label (H1 heading); defaults to the name. */
  label?: string;
  /** Optional one-line role / description. */
  role?: string;
  /** Optional routing keywords (pipe, comma or space separated); defaults to the agent id. */
  keywords?: string;
  /** Model id; blank = the provider's catalog default. For "other" it is the bare id sent to the endpoint. */
  model?: string;
  /** "other" only: env var NAME holding the base URL. */
  endpointEnv?: string;
  /** "other" only: optional env var NAME holding the API key. */
  apiKeyEnv?: string;
  /** "other" only: optional base URL VALUE, stored per user and never in a project file. */
  baseUrl?: string;
}

/** Kebab-case agent id from a free-text name. */
export function agentIdFromName(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function titleFromId(id: string): string {
  return id.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export interface WorkingAgentBuild {
  agent: PackAgent;
  /** The routing.json slot for the new agent. */
  slot: RoutingSlot;
  /** Cleaned spec (id and label resolved). */
  id: string;
  label: string;
}

/** Problems with a spec (empty when valid). `taken` = ids already in use. Pure apart from the pack-agent lookup. */
export function validateWorkingSpec(spec: Partial<WorkingAgentSpec> | null | undefined, packAgents: PackAgent[], taken: Iterable<string>): string[] {
  if (!spec || typeof spec !== "object") return ["Missing agent details."];
  const name = typeof spec.name === "string" ? spec.name.trim() : "";
  if (name === "") return ["Enter a name for the agent."];
  const id = agentIdFromName(name);
  const takenSet = new Set(Array.from(taken, (t) => t.toLowerCase()));
  if (!SLUG_RE.test(id) || !isSafeAgentId(id)) {
    return ["Name must give an agent id of 2-40 letters, digits and hyphens, starting with a letter."];
  }
  if (RESERVED_IDS.has(id) || takenSet.has(id)) return [`An agent named "${id}" already exists; choose another name.`];
  const label = typeof spec.label === "string" && spec.label.trim() !== "" ? spec.label.trim() : titleFromId(id);
  if (label.length > 60 || /[\r\n]/.test(label)) return ["Display label must be 1-60 characters on one line."];
  if (typeof spec.role === "string" && (spec.role.length > 240 || /[\r\n]/.test(spec.role))) return ["Role must be one line of 240 characters or fewer."];
  if (spec.provider === "other") {
    return validateOtherSpec(
      { agentId: id, label, model: spec.model ?? "", endpointEnv: spec.endpointEnv ?? "", apiKeyEnv: spec.apiKeyEnv, baseUrl: spec.baseUrl, role: spec.role },
      [],
    );
  }
  if (!spec.provider || !Object.prototype.hasOwnProperty.call(PROVIDER_TEMPLATE, spec.provider)) return ["Choose a provider."];
  const tpl = PROVIDER_TEMPLATE[spec.provider];
  if (!packAgents.some((a) => a.id === tpl.packId && a.backend)) return [`${tpl.label} is not available in this install.`];
  const model = typeof spec.model === "string" ? spec.model.trim() : "";
  if (model !== "" && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(model)) {
    return ["Model id must be 1-120 characters of letters, digits and . _ : / @ + -"];
  }
  return [];
}

/** Build the agent file content and routing slot for a VALID spec. */
export function buildWorkingAgent(spec: WorkingAgentSpec, packAgents: PackAgent[]): WorkingAgentBuild {
  const id = agentIdFromName(spec.name);
  const label = typeof spec.label === "string" && spec.label.trim() !== "" ? spec.label.trim() : titleFromId(id);
  let providerLabel: string;
  let slot: RoutingSlot;
  if (spec.provider === "other") {
    providerLabel = `${label}'s OpenAI-compatible endpoint`;
    const model = (spec.model ?? "").trim();
    slot = {
      vendor: CUSTOM_VENDOR,
      transport: "openai-compatible",
      mcpServer: OPENAI_COMPAT_SERVER,
      tools: ["chat"],
      model: `${CUSTOM_VENDOR}/${model}`,
      costModelClass: "local",
      endpointEnv: (spec.endpointEnv ?? "").trim(),
    };
    if (spec.apiKeyEnv && spec.apiKeyEnv.trim() !== "") slot.credentialEnv = spec.apiKeyEnv.trim();
  } else {
    const tpl = PROVIDER_TEMPLATE[spec.provider];
    const backend = packAgents.find((a) => a.id === tpl.packId)!.backend!;
    providerLabel = tpl.label;
    let model = (spec.model ?? "").trim();
    if (model === "") model = backend.model;
    else if (!model.includes("/")) model = `${tpl.prefix}${model}`;
    slot = {
      vendor: backend.vendor,
      transport: backend.transport,
      model,
      costModelClass: backend.costModelClass,
    };
    if (spec.provider === "codex") {
      // Working agents edit files: Codex gets the write-access server by default (reviewer-class stays read-only).
      slot.mcpServer = CODEX_WRITE_SERVER;
      slot.tools = ["codex", "codex-reply"];
    } else {
      if (backend.mcpServer) slot.mcpServer = backend.mcpServer;
      if (backend.tools) slot.tools = [...backend.tools];
    }
    if (backend.endpointEnv) slot.endpointEnv = backend.endpointEnv;
    if (backend.apiKeyEnv) slot.credentialEnv = backend.apiKeyEnv;
  }
  const role =
    (typeof spec.role === "string" && spec.role.trim() !== "" ? spec.role.trim().replace(/\s+/g, " ") : "") ||
    `${label}: takes on implementation work routed to it and does it through ${providerLabel}.`;
  const keywords = normalizeKeywords(spec.keywords, id, [id]);
  const agent: PackAgent = { id, name: label, model: "sonnet", role, keywords };
  return { agent, slot, id, label };
}

export interface WorkingInstallArgs {
  root: string;
  specs: WorkingAgentSpec[];
  /** The multi-llm pack's agents (backend templates). */
  packAgents: PackAgent[];
  harness: string;
  /** TycoonAgents install root that contains scripts/ (see saveRoutingProfile). */
  scriptsDir: string;
  /** Persist a validated base URL VALUE into the per-user store (never a project file). */
  storeLocalValue?: (name: string, value: string) => void;
  /** Read the per-user store's current value for a name; used to refuse a silent overwrite. */
  getLocalValue?: (name: string) => string | undefined;
}

export interface WorkingInstallResult {
  ok: boolean;
  /** Agents now on disk (their keywords should be registered by the host). */
  created: PackAgent[];
  errors: string[];
  relayNotices: string[];
  /** The profile that was saved and the one before it, for the host's bridge-server registration. */
  profile: unknown;
  previous: unknown;
}

/**
 * Create the working agents and route them. All-or-nothing: any invalid spec, an id that already
 * exists, or a failed save leaves the project as it was (files this call created are removed).
 * An existing `.claude/agents/<id>.md` is never overwritten.
 */
export function installProviderWorkers(args: WorkingInstallArgs): WorkingInstallResult {
  const result: WorkingInstallResult = { ok: false, created: [], errors: [], relayNotices: [], profile: null, previous: null };
  const agentsDir = path.join(args.root, ".claude", "agents");
  const taken = [...listAgentIds(args.root), ...args.packAgents.map((a) => a.id)];
  const builds: Array<{ spec: WorkingAgentSpec; build: WorkingAgentBuild }> = [];
  for (const spec of args.specs) {
    const problems = validateWorkingSpec(spec, args.packAgents, taken);
    const idGuess = spec && typeof spec.name === "string" ? agentIdFromName(spec.name) : "(agent)";
    if (problems.length > 0) {
      result.errors.push(`${idGuess}: ${problems.join(" ")}`);
      continue;
    }
    if (spec.provider === "other" && spec.baseUrl && spec.baseUrl.trim() !== "" && args.getLocalValue) {
      const current = args.getLocalValue(spec.endpointEnv ?? "");
      if (current !== undefined && current !== "" && current !== spec.baseUrl.trim()) {
        result.errors.push(`${idGuess}: ${spec.endpointEnv} already has a different value stored on this machine; choose a different base URL variable name (the stored value was not changed).`);
        continue;
      }
    }
    const build = buildWorkingAgent(spec, args.packAgents);
    taken.push(build.id);
    builds.push({ spec, build });
  }
  if (result.errors.length > 0) return result;
  if (builds.length === 0) {
    result.errors.push("Add at least one agent.");
    return result;
  }

  const loaded = loadRoutingProfile(args.root);
  if (loaded.errors.length > 0) {
    result.errors.push(`routing.json could not be read, so nothing was added: ${loaded.errors[0]}`);
    return result;
  }
  const previous = loaded.profile;
  result.previous = previous;

  const written: string[] = [];
  // saveRoutingProfile writes routing.json BEFORE the generators run, so a failed save must put it back too.
  const routingPath = path.join(args.root, ".claude", "tycoon", "routing.json");
  let routingBefore: Buffer | null = null;
  try { routingBefore = fs.readFileSync(routingPath); } catch { routingBefore = null; }
  const rollback = (): void => {
    for (const f of written) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
    try {
      if (routingBefore === null) fs.rmSync(routingPath, { force: true });
      else fs.writeFileSync(routingPath, routingBefore);
    } catch { /* best effort */ }
  };
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const { build } of builds) {
    const file = path.join(agentsDir, `${build.id}.md`);
    try {
      // "wx": fail rather than overwrite a file that appeared since the check above.
      fs.writeFileSync(file, buildAgentMarkdown(build.agent), { flag: "wx" });
      written.push(file);
    } catch (e) {
      rollback();
      const exists = (e as NodeJS.ErrnoException).code === "EEXIST";
      result.errors.push(exists ? `${build.id}: an agent named "${build.id}" already exists; choose another name.` : `${build.id}: could not write the agent file (${String(e)}).`);
      return result;
    }
  }

  const base: RoutingProfile = previous ?? { version: 1, agents: {} };
  const nextAgents: Record<string, RoutingSlot> = { ...base.agents };
  for (const { build } of builds) nextAgents[build.id] = build.slot;
  const draft: RoutingProfile = { ...base, version: 1, agents: nextAgents };
  const guarded = enforceReviewerReadOnly(args.root, draft, previous);
  const saved = saveRoutingProfile({ root: args.root, profile: guarded.profile, scriptsDir: args.scriptsDir, effectiveHarness: args.harness });
  result.relayNotices = [...guarded.notices, ...(saved.relayNotices ?? [])];
  if (!saved.ok) {
    rollback();
    const lastLine = (o: unknown): string | undefined => String(o ?? "").trim().split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean).slice(-1)[0];
    const detail = lastLine(saved.write.claude.output) ?? lastLine(saved.write.opencode.output);
    result.errors.push(...(saved.errors.length > 0 ? saved.errors : [`Setting up the provider failed, so nothing was added and your files were restored.${detail ? ` (${detail})` : ""}`]));
    return result;
  }
  result.ok = true;
  result.profile = guarded.profile;
  result.created = builds.map((b) => b.build.agent);
  for (const { spec } of builds) {
    if (spec.provider === "other" && spec.baseUrl && spec.baseUrl.trim() !== "" && args.storeLocalValue) {
      try {
        args.storeLocalValue(spec.endpointEnv ?? "", spec.baseUrl.trim());
      } catch (e) {
        result.errors.push(`${spec.endpointEnv}: could not store the base URL (${String(e)}).`);
      }
    }
  }
  return result;
}
