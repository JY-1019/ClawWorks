/**
 * The process-local registry of active enterprise runs, plus the MCP facts the
 * agent runtimes read from it.
 *
 * Split out of runtime.ts on purpose: that module reaches the plan helpers, which
 * import @openclaw/enterprise-planner — a workspace package resolved through build
 * aliases rather than node_modules. Agent-side callers (the CLI overlay, the Codex
 * projection) load through the plugin-sdk native resolver, which does real Node
 * resolution and cannot follow that edge. Keeping the registry plan-free is what
 * lets them read it at all.
 */
import { sanitizeServerName } from "../agents/agent-bundle-mcp-names.js";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { policyTargetsTree } from "./governance.js";
import {
  CODEX_NAMESPACE_TRUNCATION_LIMIT,
  codexHookNamespaces,
  codexNamespace,
  patternsCanShareACall,
} from "./mcp-callable-names.js";
import type { EnterprisePlanNode, EnterpriseRunPlan, GovernancePolicy } from "./types.js";

/** Trace sink installed by run mediation; must never throw. */
export type EnterpriseRunTraceSink = (event: {
  kind: "governance.decision" | "node.entered" | "node.completed" | "action.invoked";
  nodeId: string;
  payload: Record<string, unknown>;
}) => void;

export type EnterpriseActiveRun = {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
  /**
   * MCP servers registered under `mcp.servers`, snapshotted at mediation like
   * `policies`. Only these are attachable, so only these are gated; a plugin's own
   * MCP server is part of its tool surface. Re-reading config per tool call would
   * put a file read on the hot path.
   */
  mcpServers?: readonly string[];
  /**
   * The session this run executes for. Indexed into a sessionId→runId map so an
   * out-of-process caller (the loopback MCP server, spawned by this run) can find
   * the run it belongs to from its own trusted sessionId, instead of trusting a
   * client-supplied run-id header it could forge to another run's scope.
   */
  sessionId?: string;
  sink?: EnterpriseRunTraceSink;
  /**
   * Required property ids per object type, from the tree this run PLANNED
   * against. Snapshotted at mediation so a mid-run re-import cannot change the
   * shape an in-flight write is judged by.
   */
  treeRequiredProperties?: Map<string, Set<string>>;
  /**
   * Set once the run has finished its LAST step. Advancement is monotonic, so
   * this is the only state the cursor position cannot express on its own: the
   * cursor stays on the final step after completing it (dropping to the root
   * would widen the scope the run ends under), and without this flag a repeated
   * complete_step would re-emit `node.completed` for a step already closed.
   */
  routeCompleted?: boolean;
};

// Symbol-keyed global so duplicated dist chunks share one registry
// (same pattern as the memory embedding provider registry).
const ACTIVE_RUNS_KEY = Symbol.for("openclaw.enterpriseActiveRuns");

export function activeRuns(): Map<string, EnterpriseActiveRun> {
  const holder = globalThis as { [ACTIVE_RUNS_KEY]?: Map<string, EnterpriseActiveRun> };
  holder[ACTIVE_RUNS_KEY] ??= new Map();
  return holder[ACTIVE_RUNS_KEY];
}

// sessionId → the runId that session is CURRENTLY executing. Turns of one session
// are serialized (the session lane), so at most one run is active per session at
// a time and this map is unambiguous during a turn. Same symbol-keyed global as
// the run registry so duplicated dist chunks share one map.
const SESSION_ACTIVE_RUNS_KEY = Symbol.for("openclaw.enterpriseSessionActiveRuns");

export function sessionActiveRuns(): Map<string, string> {
  const holder = globalThis as { [SESSION_ACTIVE_RUNS_KEY]?: Map<string, string> };
  holder[SESSION_ACTIVE_RUNS_KEY] ??= new Map();
  return holder[SESSION_ACTIVE_RUNS_KEY];
}

export function registerEnterpriseActiveRun(run: EnterpriseActiveRun): void {
  activeRuns().set(run.plan.runId, run);
  if (run.sessionId) {
    // Begin runs inside the session lane, so a fresh turn's begin overwrites the
    // prior turn's link before this turn's tool calls resolve — always the
    // current run.
    sessionActiveRuns().set(run.sessionId, run.plan.runId);
  }
}

export function getEnterpriseActiveRun(runId: string): EnterpriseActiveRun | undefined {
  return activeRuns().get(runId);
}

/** The run a session is executing right now, or undefined between/outside runs. */
export function getSessionActiveRunId(sessionId: string): string | undefined {
  return sessionActiveRuns().get(sessionId);
}

export function unregisterEnterpriseActiveRun(runId: string): void {
  const run = activeRuns().get(runId);
  activeRuns().delete(runId);
  // Guarded clear: run end runs OUTSIDE the session lane, so the next run for the
  // same session can begin (and re-point the link) before this one ends. Drop the
  // link only if it still names the ending run, or we would orphan the successor.
  if (run?.sessionId && sessionActiveRuns().get(run.sessionId) === runId) {
    sessionActiveRuns().delete(run.sessionId);
  }
}

/** Test-only: clear registry state between cases (isolate:false lanes). */
export function clearEnterpriseActiveRunsForTest(): void {
  activeRuns().clear();
  sessionActiveRuns().clear();
}

/**
 * Every MCP server the bound work-map attaches, anywhere in the plan.
 *
 * Plan-level, and deliberately so: a CLI backend launches its MCP servers once,
 * at spawn, from a config file the subprocess owns — nothing can be withdrawn
 * mid-run when the step advances. Withholding the servers NO step attaches is
 * therefore the strongest boundary that runtime can carry, and it is the same
 * exposure-vs-permission split runAllowsOntologyWrites already uses. Returns null
 * when no governed run owns the id, which means "do not filter".
 */
/**
 * MCP servers an operator registered under `mcp.servers` AND left enabled; the
 * attachable set. A disabled entry is skipped by every projection, so it can
 * neither be called nor collide with the server that is — counting it would
 * withhold a working attachment for a clash that cannot happen.
 */
export function resolveEnterpriseMcpServers(config?: OpenClawConfig): string[] {
  return Object.entries(config?.mcp?.servers ?? {})
    .filter(([, server]) => (server as { enabled?: unknown } | undefined)?.enabled !== false)
    .map(([name]) => name);
}

export function enterpriseRunAttachedMcpServers(
  runId?: string,
  /**
   * Every server name the caller is about to hand over, including the ones a
   * PLUGIN supplies. A collision is a property of that merged set — the harness
   * hashes two servers whose namespaces collide, and the hashed name falls outside
   * any glob an operator could write — so the caller passes what it knows and this
   * refuses an ambiguous grant. Callers that cannot see the plugin set pass what
   * they have; the registered names are always included.
   */
  peerServerNames: readonly string[] = [],
  /**
   * The names this caller can actually emit for THIS thread — Codex's per-agent
   * scoping, for instance. When given, both the grant and the collision siblings
   * are limited to it: a server the thread will never receive can neither be
   * granted nor collide with one that is.
   */
  eligibleServerNames?: readonly string[],
): ReadonlySet<string> | null {
  const run = runId ? getEnterpriseActiveRun(runId) : undefined;
  // Observe mode watches and records; it never blocks. Withholding servers is
  // physical, not a recorded decision, so it belongs to enforce mode alone.
  if (!run || run.plan.mode !== "enforce") {
    return null;
  }
  // A work-map that never mentions MCP is not governed by attachments. Trees
  // written before this field existed — the built-in ones included, which promise
  // stock behavior — would otherwise lose every configured server on upgrade, with
  // no migration and no way to ask for the old behavior back.
  if (run.plan.mcpGoverned !== true) {
    return null;
  }
  // Definition-wide, not the pruned plan: a native runtime is handed its servers
  // once, at launch, for the whole run, so a branch the route left out still
  // decides what it may be given.
  // Registered AND enabled only: an attachment naming a disabled key must not keep
  // an inherited config entry of the same name alive, and an attachment naming a
  // server nobody registered is inert (the screen and docs say so).
  const registered = new Set(run.mcpServers ?? []);
  const eligible = eligibleServerNames ? new Set(eligibleServerNames) : null;
  const attached = new Set(
    (run.plan.mcpAttachments ?? []).filter(
      (name) => registered.has(name) && (!eligible || eligible.has(name)),
    ),
  );
  const ceiling = resolveMcpCeiling(run);
  // Snapshot BEFORE the loop mutates it: sibling ambiguity is a property of what
  // the work-map attached, not of what survives an earlier iteration.
  const attachedSnapshot = [...attached];
  for (const server of attachedSnapshot) {
    // Ambiguity fails closed on the GRANT side: when another attached server
    // materializes to the same base, an alias grant cannot say which one it meant.
    // Peers are what the backend will actually EMIT, plus the servers this
    // work-map attached. The full registry is deliberately excluded: a disabled or
    // agent-scoped entry never reaches the runtime, so treating it as a collision
    // would withhold a working server for a clash that cannot happen.
    const siblings = [...new Set([...attachedSnapshot, ...peerServerNames])].filter(
      (other) => other !== server,
    );
    if (!ceilingAdmitsMcpServer(ceiling, server, siblings)) {
      attached.delete(server);
    }
  }
  return attached;
}

/**
 * Which of these servers the run's tool ceiling still admits, for servers no
 * attachment can grant: the ones a PLUGIN bundle supplies.
 *
 * Attachment does not apply to them — they arrive with a plugin's tool surface and
 * the Enterprise MCP screen cannot register them — but the ceiling does. On a
 * backend with no PreToolUse relay nothing judges their calls afterwards, so a root
 * that allows only `message` has to be honored here or those tools run unjudged and
 * untraced. Returns null when no enforcing run owns the id, which means "do not
 * filter"; a run whose root narrows nothing admits everything.
 */
export function enterpriseRunBoundableMcpServers(
  runId: string | undefined,
  candidates: readonly string[],
  peerServerNames: readonly string[] = [],
): ReadonlySet<string> | null {
  const run = runId ? getEnterpriseActiveRun(runId) : undefined;
  if (!run || run.plan.mode !== "enforce") {
    return null;
  }
  const ceiling = resolveMcpCeiling(run);
  const admitted = new Set<string>();
  for (const server of candidates) {
    const siblings = [...new Set([...candidates, ...peerServerNames])].filter(
      (other) => other !== server,
    );
    // A plugin's server is the one MCP surface no attachment can grant, so under
    // explicit grants the root's allow-list is the ONLY thing that can name it —
    // and a root that names nothing must withhold it rather than fall through to
    // the "narrows nothing" reading, which would hand a governed native run every
    // plugin tool it never granted.
    if (
      ceilingAdmitsMcpServer(ceiling, server, siblings, run.plan.capabilityGrants === "explicit")
    ) {
      admitted.add(server);
    }
  }
  return admitted;
}

/**
 * Skills the bound work-map attaches, or null when the run does not narrow them.
 *
 * Plan-wide, like the MCP attachments: the catalog is part of the system prompt,
 * so a per-step set would rewrite prompt bytes every turn and cost the run its
 * cache. Null means "do not filter" — the run is unmediated, observing, or bound
 * to a work-map that does not grant explicitly.
 */
export function enterpriseRunGrantedSkills(runId?: string): readonly string[] | null {
  const run = runId ? getEnterpriseActiveRun(runId) : undefined;
  // Observe mode records decisions without blocking, and removing a skill from the
  // catalog is physical rather than recorded — same split as the MCP withholding.
  if (!run || run.plan.mode !== "enforce" || run.plan.capabilityGrants !== "explicit") {
    return null;
  }
  // An empty array is a real answer: a work-map that grants explicitly and attaches
  // no skill reaches none, so the catalog is emptied rather than left whole.
  return run.plan.grantedSkills ?? [];
}

/**
 * May this run use a tool its harness never dispatches?
 *
 * Codex's `web_search` is HOSTED: `create_web_search_tool` emits a
 * `ToolSpec::WebSearch` the model host executes
 * (../codex/codex-rs/core/src/tools/hosted_spec.rs:14-45), and the registry holds no
 * handler for it, so the call never reaches the dispatch that fires PreToolUse hooks
 * (run_pre_tool_use_hooks, ../codex/codex-rs/core/src/tools/registry.rs:580-582). The
 * per-call gate therefore cannot see it at all — not even on a backend that relays
 * hooks — so the launch-time decision is the only enforcement point there is, the
 * same reasoning enterpriseRunBoundableMcpServers applies to a plugin's servers.
 *
 * True means "do not withhold": the run is unmediated, observing, or bound to a
 * work-map that does not narrow the tool away.
 */
export function enterpriseRunAdmitsHostedTool(
  runId: string | undefined,
  toolName: string,
): boolean {
  const run = runId ? getEnterpriseActiveRun(runId) : undefined;
  // Observe mode watches and records; withholding a tool is physical rather than a
  // recorded decision, so it belongs to enforce mode alone (same split as MCP).
  if (!run || run.plan.mode !== "enforce") {
    return true;
  }
  // Any planned step's denial counts. The tool is granted once, before the thread
  // starts, and nothing can withdraw it when the run advances — so a rule from a
  // branch this run may still enter has to be honored up front.
  const denied = run.plan.nodes.flatMap((node) => node.ontology.deniedTools ?? []);
  if (denied.length > 0 && !isToolAllowedByPolicyName(toolName, { deny: [...denied] })) {
    return false;
  }
  // EVERY step the run can stand on has to admit it, not just the root.
  //
  // The root used to be the whole answer because native runs never left it. They
  // walk the route now (complete_step), while a hosted tool is still granted once
  // before the thread starts and can never be withdrawn — so a tool the root
  // allows but the first leaf narrows away would otherwise stay callable from
  // that leaf, with no per-call gate able to catch it.
  //
  // Conservative on purpose: one step forbidding it withholds it for the run,
  // even on steps that grant it. That is strictly the safe direction, and the
  // only honest one for a tool the harness executes itself.
  // A blocking POLICY reaching this tool counts too. Codex runs a hosted tool
  // outside registry dispatch, so no PreToolUse gate fires for it once the run
  // advances onto the step the policy targets — the launch decision is the only
  // place the policy can still be honored. require_approval blocks as well: a
  // hosted call has no channel to ask on, so an approval that never runs is a
  // call that was never approved (the same rule the MCP ceiling applies).
  const blocking = resolveMcpCeiling(run).blocking;
  if (blocking.some((policy) => policyReachesTool(policy, toolName, run.plan.nodes))) {
    return false;
  }
  const executablePaths = executableNodePaths(run.plan.nodes);
  const grantsExplicitly = run.plan.capabilityGrants === "explicit";
  return executablePaths.every((path) => pathAdmitsTool(path, toolName, grantsExplicitly));
}

/**
 * Does a blocking policy cover this plain (non-MCP) tool?
 *
 * Mirrors policyReachesMcpServer, because the reasoning is identical: selectors
 * are CONJUNCTIVE and must all hold on one real call. An action-scoped policy is
 * not "about actions instead of tools" — an action whose `tools` globs cover this
 * tool makes the policy govern exactly this call, and a hosted tool has no later
 * gate that could catch it.
 */
function policyReachesTool(
  policy: GovernancePolicy,
  toolName: string,
  nodes: readonly EnterprisePlanNode[],
): boolean {
  if (policy.knowledge?.length) {
    // A knowledge selector cannot match a tool call, and selectors are
    // conjunctive, so such a policy never gates one.
    return false;
  }
  const toolPatterns = policy.tools ?? [];
  const actionSelectors = policy.actions ?? [];
  if (toolPatterns.length === 0 && actionSelectors.length === 0) {
    // Selector-less policies target runs, not calls.
    return false;
  }
  if (actionSelectors.length === 0) {
    return selectorMatches(toolName, toolPatterns);
  }
  // Every selector has to hold on ONE reachable root→node path: the node selector,
  // the action, and (when present) the policy's own tool pattern. Scanning them
  // independently would withhold a tool for a combination no real call produces.
  return nodes.some((node) => {
    const path = rootPathTo(nodes, node);
    if (!path.some((step) => selectorMatches(step.nodeId, policy.nodes))) {
      return false;
    }
    return path.some((step) =>
      (step.ontology.actions ?? [])
        .filter((action) => selectorMatches(action.id, actionSelectors))
        // An action with no `tools` covers every tool, this one included.
        .some(
          (action) =>
            (action.tools ?? ["*"]).some((actionTool) => selectorMatches(toolName, [actionTool])) &&
            (toolPatterns.length === 0 || selectorMatches(toolName, toolPatterns)),
        ),
    );
  });
}

/**
 * The narrowing lists on each executable path, kept PER PATH.
 *
 * Grouping matters: "this path names nothing" is itself the answer under explicit
 * grants, and a flat list of every branch's grants cannot express it.
 */
function executablePathAllowLists(nodes: readonly EnterprisePlanNode[]): string[][][] {
  return executableNodePaths(nodes).map((path) =>
    path
      .map((node) => [...(node.ontology.allowedTools ?? [])])
      .filter((allowed) => allowed.length > 0),
  );
}

/** Root→leaf path for every step the run can actually stand on. */
function executableNodePaths(nodes: readonly EnterprisePlanNode[]): EnterprisePlanNode[][] {
  const parentIds = new Set(
    nodes.map((node) => node.parentId).filter((id): id is string => id !== null),
  );
  const leaves = nodes.filter((node) => !parentIds.has(node.nodeId));
  return leaves.map((leaf) => rootPathTo(nodes, leaf));
}

/**
 * Does one root→leaf path admit the tool? Mirrors the per-call scope gate: every
 * level that narrows must admit it, and under explicit grants some level must
 * also have named it.
 */
function pathAdmitsTool(
  path: readonly EnterprisePlanNode[],
  toolName: string,
  grantsExplicitly: boolean,
): boolean {
  for (const node of path) {
    const allowed = node.ontology.allowedTools ?? [];
    if (allowed.length > 0 && !isToolAllowedByPolicyName(toolName, { allow: [...allowed] })) {
      return false;
    }
  }
  if (!grantsExplicitly) {
    return true;
  }
  return path.some((node) => {
    const allowed = node.ontology.allowedTools ?? [];
    return allowed.length > 0 && isToolAllowedByPolicyName(toolName, { allow: [...allowed] });
  });
}

type McpCeiling = {
  denied: readonly string[];
  blocking: readonly GovernancePolicy[];
  /**
   * Every non-empty `allowedTools` list the run could ever be judged against —
   * one per narrowing level across every executable root→leaf path, not just the
   * root's. A hookless backend receives the server once and cannot withdraw it
   * when the cursor advances, so a list on ANY reachable step is a constraint the
   * launch decision has to honor up front.
   */
  pathAllowLists: readonly (readonly (readonly string[])[])[];
  nodes: readonly EnterprisePlanNode[];
};

function resolveMcpCeiling(run: EnterpriseActiveRun): McpCeiling {
  // Deny AND require_approval: a hookless CLI has no channel to ask on, so an
  // approval gate that never runs is a call that was never approved. Scoped to
  // policies that could match a PLANNED node: one pinned to a branch this run
  // never planned cannot block anything here, so withholding for it would take a
  // server away for no reason.
  const plannedNodeIds = run.plan.nodes.map((node) => node.nodeId);
  return {
    denied: run.plan.mcpDeniedTools ?? [],
    blocking: run.policies.filter(
      (policy) =>
        (policy.effect === "deny" || policy.effect === "require_approval") &&
        policyTargetsTree(policy, run.plan.treeId) &&
        plannedNodeIds.some((nodeId) => selectorMatches(nodeId, policy.nodes)),
    ),
    // Every reachable step's list, because native runs DO advance now
    // (complete_step) while the server is handed over once, before the subprocess
    // connects — on a CLI with no PreToolUse relay that hand-over is the only
    // enforcement there will ever be.
    pathAllowLists: executablePathAllowLists(run.plan.nodes),
    nodes: run.plan.nodes,
  };
}

/**
 * Can this run's rules bound the server's tools without a per-call gate?
 *
 * A native runtime renames tools by rules OpenClaw cannot invert (Codex sanitizes,
 * truncates at 64 characters, and hashes collisions), so a per-tool `deniedTools`
 * entry cannot be matched against what it reports — a partially denied server is
 * therefore not handed over at all rather than resting on a name we would have to
 * guess at. The same for a blocking policy that could reach it, and for a root
 * allow-list that cannot admit the server whole: otherwise `allowedTools: [message]`
 * would quietly ship every tool the server has.
 */
function ceilingAdmitsMcpServer(
  ceiling: McpCeiling,
  server: string,
  siblings: readonly string[],
  /**
   * Nothing else can grant this server, so an empty root allow-list means "not
   * granted" instead of "not narrowed". Only the plugin-server path passes true:
   * an attachment is itself a grant.
   */
  requireGrant = false,
): boolean {
  if (ceiling.denied.some((entry) => denialReachesMcpServer(entry, server))) {
    return false;
  }
  if (ceiling.blocking.some((policy) => policyReachesMcpServer(policy, server, ceiling.nodes))) {
    return false;
  }
  if (ceiling.pathAllowLists.length === 0) {
    return !requireGrant;
  }
  // EVERY executable path must admit the server, and each path is judged WHOLE.
  // Flattening the lists across paths loses the case that matters most under
  // explicit grants: a sibling path that names nothing grants nothing, so reading
  // one branch's grant as the run's would hand a hookless CLI a server the silent
  // branch must never reach.
  return ceiling.pathAllowLists.every((lists) => {
    if (lists.length === 0) {
      return !requireGrant;
    }
    return lists.every((allowed) => allowListGrantsWholeMcpServer(allowed, server, siblings));
  });
}

/**
 * The spellings a server key is rewritten into: the key itself, Codex's sanitizer
 * (`_`), OpenClaw's materializer (`-`), and each of those with the trailing
 * underscores Codex's hook name drops (join_tool_name). A key like `foo_` is
 * reported as `mcp__foo__<tool>`, so a denial written from that name has to be
 * recognized as this server's.
 */
function mcpServerNamespaces(server: string): string[] {
  // Original case into the hook builder — it decides Codex's legacy prefix
  // case-sensitively — and lower-cased for the plain spellings this side compares.
  const bases = [server, codexNamespace(server), sanitizeServerName(server, new Set())];
  // Plus every spelling Codex's hook can report, built by its own sequence: a key
  // of `_` prefixes to `mcp___`, which trims to `mcp`, so its tools arrive as
  // `mcp__<tool>` and a denial written that way names THIS server.
  return [
    ...new Set([...bases.map((base) => base.toLowerCase()), ...codexHookNamespaces(bases)]),
  ].filter(Boolean);
}

// The materializer disambiguates two servers that sanitize alike by truncating the
// base to fit and appending `-<n>` (sanitizeServerName in agent-bundle-mcp-names.ts).
// Which server takes which number depends on a set built from the MERGED plugin +
// configured catalog, which this side cannot reconstruct — so any `<prefix>-<n>`
// spelling is accepted as possibly this server's instead of being recomputed.
// Accepting too much only ever withholds a server: the safe direction for a denial.
// Two disambiguators, one per runtime: OpenClaw appends `-<n>` and Codex appends
// `_` + 12 hex characters of a sha1 (../codex/codex-rs/codex-mcp/src/tools.rs).
const COLLISION_SUFFIX = /^(.+?)(?:-\d+|_[0-9a-f]{12})$/;
// TOOL_NAME_MAX_PREFIX in agent-bundle-mcp-names.ts: the characters a server may
// claim in a materialized tool name, and the budget a colliding base is truncated
// to fit. Truncation only bites near it; below it the base is whole, so a shorter
// prefix would belong to a different server.
const TOOL_NAME_PREFIX_BUDGET = 30;

function mightBeCollisionAliasOf(segment: string, namespace: string): boolean {
  // Codex can truncate the NAMESPACE itself and move the hash into the tool part
  // (fit_callable_parts_with_hash, ../codex/codex-rs/codex-mcp/src/tools.rs), so a
  // bare prefix with no suffix is one of its real spellings too.
  if (
    namespace.startsWith(segment) &&
    segment.length >= Math.min(namespace.length, TOOL_NAME_PREFIX_BUDGET - 2)
  ) {
    return true;
  }
  const prefix = COLLISION_SUFFIX.exec(segment)?.[1];
  if (!prefix || !namespace.startsWith(prefix)) {
    return false;
  }
  // The base is truncated to fit ITS suffix, so the shortest prefix this server can
  // wear follows that suffix's width: the tenth collision (`-10`) leaves one
  // character less than the second (`-2`).
  const suffixLength = segment.length - prefix.length;
  return (
    prefix.length === namespace.length ||
    prefix.length >= Math.min(namespace.length, TOOL_NAME_PREFIX_BUDGET - suffixLength)
  );
}

/**
 * Does this denial open with a name that could BE this server, rewritten?
 *
 * Every delimiter position is tried, not just the first: a config key may contain
 * `__` itself (`foo__bar`), and Codex's collision hash sits between the key and the
 * delimiter (`mcp__foo__bar_<hash>__delete`), so cutting at the first `__` would
 * read that denial as naming a server called `foo`. Both the raw pattern and the
 * one with Codex's legacy prefix removed are scanned, since a key can itself start
 * with `mcp__`.
 */
function denialOpensWithMcpServer(pattern: string, namespaces: readonly string[]): boolean {
  const bodies = pattern.startsWith("mcp__") ? [pattern, pattern.slice("mcp__".length)] : [pattern];
  for (const body of bodies) {
    for (let index = body.indexOf("__"); index > 0; index = body.indexOf("__", index + 1)) {
      const segment = body.slice(0, index);
      if (namespaces.some((namespace) => mightBeCollisionAliasOf(segment, namespace))) {
        return true;
      }
    }
  }
  return false;
}
/**
 * The names a runtime can actually put in a tool name: Codex's sanitized form and
 * OpenClaw's. The raw config key only appears when it is already tool-name-safe.
 */
function callableMcpNamespaces(server: string): string[] {
  const sanitized = [codexNamespace(server), sanitizeServerName(server, new Set())];
  // The hook's own spellings count too, so a grant has to cover them — and two keys
  // that differ only by trailing underscores are a real collision in that space.
  const bases = [
    ...new Set([...sanitized.map((base) => base.toLowerCase()), ...codexHookNamespaces(sanitized)]),
  ].filter(Boolean);
  // Codex prefixes by default (`../codex/codex-rs/core/src/config/mod.rs:1753`),
  // so `foo` is emitted as `mcp__foo` — the same namespace a server literally
  // named `mcp__foo` gets. Both spellings belong to the server for collision and
  // length purposes, or two servers that collide only after prefixing would look
  // distinct here and be handed over with hash-suffixed names nothing bounds.
  return [
    ...new Set(
      bases.flatMap((base) => (base.startsWith("mcp__") ? [base] : [base, `mcp__${base}`])),
    ),
  ];
}

/**
 * Does this allow-list grant the server WHOLE, under every name it can appear
 * under?
 *
 * Existential is not enough on either axis. Nothing gates a call on a CLI with no
 * pre-tool hook, so a list that allows only some of the server's tools would let
 * the rest run anyway — and the HARNESS picks the spelling, so granting
 * `acme-tracker__*` while Codex exposes `mcp__acme_tracker__*` leaves those tools
 * outside the ceiling entirely. Every spelling must be covered, or the server is
 * withheld.
 */
function allowListGrantsWholeMcpServer(
  allowed: readonly string[],
  server: string,
  siblings: readonly string[] = [],
): boolean {
  // Only names a runtime can actually expose: a key like `my server` never appears
  // in a tool name (both runtimes sanitize it), so requiring a `my server__*`
  // entry would make the grant impossible to write.
  // `*` admits every name a runtime could emit, truncation and hashes included, so
  // the spelling-specific refusals below have nothing left to protect.
  if (allowed.some((entry) => entry.trim() === "*")) {
    return true;
  }
  const namespaces = callableMcpNamespaces(server);
  // Codex truncates the NAMESPACE itself once a tool would push the callable name
  // past 64 characters, emitting the hash as the tool part
  // (fit_callable_parts_with_hash, ../codex/codex-rs/codex-mcp/src/tools.rs:269-287).
  // No glob an operator writes can cover that spelling, so a name this long cannot
  // be bounded and the server is not handed over.
  if (namespaces.some((namespace) => namespace.length > CODEX_NAMESPACE_TRUNCATION_LIMIT)) {
    return false;
  }
  // Ambiguity fails closed: when a sibling answers to one of these names, no grant
  // written against it can say which server it meant.
  const siblingNamespaces = new Set(siblings.flatMap((other) => callableMcpNamespaces(other)));
  if (namespaces.some((namespace) => siblingNamespaces.has(namespace))) {
    return false;
  }
  // A key that already starts with `mcp__` keeps it (Codex skips the legacy prefix
  // when the namespace has it, and the materializer uses the key once), so
  // requiring `mcp__mcp__…` would make the grant unwritable.
  const prefixes = [
    ...new Set(
      namespaces.flatMap((namespace) =>
        namespace.startsWith("mcp__")
          ? [`${namespace}__`]
          : [`${namespace}__`, `mcp__${namespace}__`],
      ),
    ),
  ];
  return prefixes.every((prefix) =>
    allowed.some((entry) => {
      const pattern = entry.trim().toLowerCase();
      return pattern.length > 0 && globCoversEverythingUnder(pattern, prefix);
    }),
  );
}

/**
 * Does this glob match EVERY name beginning with `prefix`? True for `*`, and for a
 * single trailing star whose literal part stops at or before the prefix — the
 * shapes an operator writes to grant a server outright.
 */
function globCoversEverythingUnder(pattern: string, prefix: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (!pattern.endsWith("*")) {
    return false;
  }
  const literal = pattern.slice(0, -1);
  return !literal.includes("*") && prefix.startsWith(literal);
}

/** The root→node chain, the unit governance evaluates a policy against. */
function rootPathTo(
  nodes: readonly EnterprisePlanNode[],
  node: EnterprisePlanNode,
): EnterprisePlanNode[] {
  const byId = new Map(nodes.map((candidate) => [candidate.nodeId, candidate]));
  const path: EnterprisePlanNode[] = [node];
  let current = node.parentId;
  while (current) {
    const parent = byId.get(current);
    if (!parent) {
      break;
    }
    path.unshift(parent);
    current = parent.parentId;
  }
  return path;
}

/** A policy selector matches when it is unset or one of its globs matches. */
function selectorMatches(value: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }
  return isToolAllowedByPolicyName(value, { allow: [...globs] });
}
/**
 * Could this blocking policy reach a tool of the server?
 *
 * `tools` and `actions` are CONJUNCTIVE, exactly as policyAppliesToToolCall reads
 * them: a policy carrying both fires only when ONE call satisfies each. Each
 * selector merely reaching the server is not enough — `tools: ["github__read"]`
 * with an action covering `github__delete` can never fire, and withholding for it
 * would take the server away for nothing.
 */
function policyReachesMcpServer(
  policy: GovernancePolicy,
  server: string,
  nodes: readonly EnterprisePlanNode[],
): boolean {
  if (policy.knowledge?.length) {
    // Selectors are conjunctive and a knowledge selector cannot match a tool call,
    // so such a policy never gates one (policyAppliesToToolCall says the same).
    return false;
  }
  const toolPatterns = policy.tools ?? [];
  const actionSelectors = policy.actions ?? [];
  if (toolPatterns.length === 0 && actionSelectors.length === 0) {
    // Selector-less policies target runs, not calls.
    return false;
  }
  if (actionSelectors.length === 0) {
    return toolPatterns.some((entry) => denialReachesMcpServer(entry, server, false));
  }
  // Governance requires every selector to hold on ONE active root→node path, so an
  // action only counts when the policy's node selector matches somewhere on that
  // same path. Scanning branches independently would withhold a server for a
  // combination no real call can produce.
  return nodes.some((node) => {
    const path = rootPathTo(nodes, node);
    if (!path.some((step) => selectorMatches(step.nodeId, policy.nodes))) {
      return false;
    }
    return path.some((step) =>
      (step.ontology.actions ?? [])
        .filter((action) => selectorMatches(action.id, actionSelectors))
        // An action with no `tools` covers every tool, this server's included.
        .some((action) =>
          (action.tools ?? ["*"]).some(
            (actionTool) =>
              denialReachesMcpServer(actionTool, server, false) &&
              (toolPatterns.length === 0 ||
                toolPatterns.some(
                  (entry) =>
                    // Both selectors have to hold on ONE call, and that call is a
                    // tool of THIS server — so the policy's own tool pattern must
                    // reach the server too. Sharing a call with `*` is not enough:
                    // `tools: ["message"]` beside an action that covers everything
                    // can never fire on `github__read`, and withholding github for
                    // it would take the server away for a combination that cannot
                    // happen.
                    denialReachesMcpServer(entry, server, false) &&
                    patternsCanShareACall(entry, actionTool),
                )),
          ),
        ),
    );
  });
}

/**
 * Can this pattern reach something inside the server?
 *
 * `bareNameDenies` separates the two rule sets. An ontology `deniedTools` entry
 * naming the server denies the SERVER — that is the documented shorthand, and the
 * native withdrawal honors it. A governance policy's `tools` selector is matched
 * against real call names by the runtime gate, so `github` there can never block
 * `github__read`; treating it as a whole-server denial would withhold a server no
 * policy can actually stop.
 */
function denialReachesMcpServer(entry: string, server: string, bareNameDenies = true): boolean {
  const pattern = entry.trim().toLowerCase();
  if (!pattern) {
    return false;
  }
  const namespaces = mcpServerNamespaces(server);
  if (bareNameDenies) {
    // Literal first: a config key can BE a tool-group id (`group:web`), and the
    // glob matcher would expand that into core tool names and match nothing here.
    if (namespaces.includes(pattern) || namespaces.some((name) => pattern === `mcp__${name}`)) {
      return true;
    }
    // Naming the server itself denies the server, in either spelling.
    const wholeServer = namespaces.flatMap((namespace) => [namespace, `mcp__${namespace}`]);
    if (wholeServer.some((name) => !isToolAllowedByPolicyName(name, { deny: [pattern] }))) {
      return true;
    }
    // A materialized COLLISION alias is a whole-server name too: two servers that
    // sanitize alike are disambiguated as `<base>-2` (OpenClaw) or `<base>_<hash>`
    // (Codex), and an operator copying that name means this server. The embedded
    // gate recognizes it from the stamped registration; here only the shape is
    // available, so the same predicate the prefixed forms use is applied to the
    // bare pattern — otherwise a hookless CLI would be handed a server its own
    // denial names.
    const bare = pattern.startsWith("mcp__") ? pattern.slice("mcp__".length) : pattern;
    if (namespaces.some((namespace) => mightBeCollisionAliasOf(bare, namespace))) {
      return true;
    }
  }
  // Both spellings a call can arrive under, so a pattern is judged against the
  // names it would actually have to match.
  const prefixes = namespaces.flatMap((namespace) => [`${namespace}__`, `mcp__${namespace}__`]);
  if (prefixes.some((prefix) => globCanMatchPrefix(pattern, prefix))) {
    return true;
  }
  return denialOpensWithMcpServer(pattern, namespaces);
}

/**
 * Can this glob match SOME name beginning with `prefix`?
 *
 * The pattern language is `*` = any sequence, so the answer turns entirely on the
 * first literal segment: once it lines up with the prefix, the first wildcard can
 * absorb whatever is left of the prefix and every later segment falls in the
 * arbitrary tail. Splitting the pattern on `__` cannot answer this — `mcp__*x`
 * reaches into every server, and a server key may contain `__` itself.
 */
function globCanMatchPrefix(pattern: string, prefix: string): boolean {
  const segments = pattern.split("*");
  if (segments.length === 1) {
    // No wildcard: the pattern IS the whole name, so it has to start with the
    // prefix to name something inside the server.
    return pattern.startsWith(prefix);
  }
  const first = segments[0] ?? "";
  return prefix.startsWith(first) || first.startsWith(prefix);
}
