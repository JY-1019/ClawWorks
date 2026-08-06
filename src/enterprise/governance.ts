/**
 * Governance policy resolution and evaluation for enterprise-mode runs.
 * Two layers per decision: the active node's ontology scope, then
 * config-declared policies. Matching policies compose order-independently
 * with precedence deny > require_approval > allow > audit (deny-wins matches
 * repo tool-policy semantics; audit records without changing the outcome).
 */
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  codexHookNamespaces,
  codexHookToolName,
  codexNamespace,
  globMatchesHashSlot,
  isUnrecoverableToolPart,
  mcpDenialToolPart,
  trimCodexToolName,
  withLegacyPrefix,
} from "./mcp-callable-names.js";
import type {
  EnterprisePlanNode,
  EnterpriseRunPlan,
  GovernanceDecision,
  GovernancePolicy,
  OntologyAction,
} from "./types.js";
import { isWorkflowControlTool } from "./workflow-control.js";

/** Governance policies declared in config, in declaration order. */
export function resolveGovernancePolicies(config?: OpenClawConfig): GovernancePolicy[] {
  return config?.enterprise?.governance?.policies ?? [];
}

function matchesSelector(value: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }
  // Reuse the repo tool-policy matcher for glob semantics (allow-list only).
  return isToolAllowedByPolicyName(value, { allow: [...globs] });
}

function hasSubjectSelectors(policy: GovernancePolicy): boolean {
  return Boolean(policy.tools?.length || policy.actions?.length || policy.knowledge?.length);
}

/** Whether a policy's tree selector matches (or is unset for) the given tree. */
export function policyTargetsTree(policy: GovernancePolicy, treeId: string): boolean {
  return matchesSelector(treeId, policy.trees);
}

/**
 * Ontology actions across the active step's root→node path that cover the
 * called tool. An omitted `tools` list means the action covers every tool; an
 * empty list (which the schema rejects, but guard programmatic policies)
 * covers nothing rather than widening to match-all via the empty-globs matcher.
 */
/**
 * Every way this one call can be named, for judging a selector an operator wrote
 * against some other runtime's spelling of it.
 */
type McpCallIdentity = {
  /** Exact spellings: the name that arrived, plus each runtime's rewrite of it. */
  identities: readonly string[];
  /** Codex hook namespaces for the owning server; empty for a non-MCP call. */
  namespaces: readonly string[];
  /** Canonical spellings of the operation itself. */
  toolParts: readonly string[];
};

/** Does any selector in this list name the call, under any of its spellings? */
function selectorsCoverCall(selectors: readonly string[], call: McpCallIdentity): boolean {
  if (call.identities.some((identity) => matchesSelector(identity, selectors))) {
    return true;
  }
  // A selector copied from a native run can carry Codex's collision or truncation
  // hash, which no deterministic alias can reproduce — the same rewrite the ontology
  // denials already read, applied here so a policy means one thing on both runtimes.
  return (
    call.namespaces.length > 0 &&
    selectors.some((selector) =>
      rewrittenNameReachesCall(selector, call.namespaces, call.toolParts),
    )
  );
}

function actionsCoveringTool(
  path: readonly EnterprisePlanNode[],
  call: McpCallIdentity,
): OntologyAction[] {
  return path
    .flatMap((node) => node.ontology.actions ?? [])
    .filter((action) => {
      if (action.tools === undefined) {
        return true;
      }
      return action.tools.length > 0 && selectorsCoverCall(action.tools, call);
    });
}

/**
 * Does an `actions`-scoped policy cover this call?
 *
 * When the call NAMES an action (invoke_action), that action is the subject and
 * nothing else is: matching the covering set instead would make a policy scoped
 * to "refund" fire for invoke_action("read-note") too, purely because some action
 * happens to list invoke_action among its tools. The gate finally sees which
 * action the model chose, so it uses it.
 *
 * For every other tool there is no named action, and the covering set (actions
 * whose `tools` globs reach this tool) remains the only signal available.
 */
function actionSelectorMatches(
  policy: GovernancePolicy,
  params: {
    coveringActions: readonly OntologyAction[];
    actionId?: string;
    carriesAction?: boolean;
    /** Action ids the active root→node path declares. */
    declaredActions: ReadonlySet<string>;
  },
): boolean {
  if (params.carriesAction) {
    // The action is NAMED in the call, never inferred from tool globs. Until it is
    // named it cannot be judged: falling back to the covering set here would let a
    // policy denying "refund" block an `invoke_action` whose action a hook has not
    // filled in yet — and which may turn out to be something else entirely. The
    // authoritative decision is taken on the final params.
    //
    // The name must also be one the active step actually DECLARES. A model can put
    // any string there, and the tool will reject an undeclared one anyway — but a
    // require_approval or audit policy would otherwise fire on it first, letting a
    // made-up action id prompt a human or write an audit entry.
    if (params.actionId === undefined || !params.declaredActions.has(params.actionId)) {
      return false;
    }
    return matchesSelector(params.actionId, policy.actions);
  }
  return params.coveringActions.some((action) => matchesSelector(action.id, policy.actions));
}

/** Why a step's tool scope refused the call; shapes the denial an operator reads. */
type OntologyScopeViolation = {
  node: EnterprisePlanNode;
  /** `"scope"`: a step's own lists reject it. `"ungranted"`: no step ever named it. */
  kind: "scope" | "ungranted";
};

/**
 * The node whose ontology tool scope rejects the call, or null when the path
 * allows it. Each level is an independent gate: a tool must satisfy the
 * allow/deny lists of every ancestor, so a leaf cannot widen past the scope its
 * root declared. Levels without tool lists don't constrain — unless the work-map
 * grants explicitly, where nothing is allowed until some level names it.
 */
function ontologyScopeViolation(params: {
  path: readonly EnterprisePlanNode[];
  toolName: string;
  /**
   * A step on this path attached the MCP server that owns the tool. The
   * attachment IS the grant for that server's tools, so the allow-lists no
   * longer have to name them — an operator who attaches a server in the UI would
   * otherwise still be refused until they also guessed its tool names. Explicit
   * denials still apply: `deniedTools` is how a step takes one back.
   */
  mcpAttached: boolean;
  /** The resolved MCP owner, used to expand `deniedTools` across spellings. */
  ownership: McpOwnership | null;
  /** Every spelling of this call, including the ones a native harness rewrote. */
  call: McpCallIdentity;
  /**
   * The work-map grants capabilities explicitly, so an unscoped path denies
   * instead of allowing (WorkflowTreeDefinition.capabilityGrants).
   */
  grantsExplicitly: boolean;
}): OntologyScopeViolation | null {
  const { path, toolName, mcpAttached, ownership, call } = params;
  // One MCP tool reaches this gate under two spellings — `<server>__<tool>` from
  // the embedded materializer and `mcp__<server>__<tool>` from a Claude-style
  // harness — and an operator writes ONE of them in deniedTools. Checking only
  // the spelling that happened to arrive would let the other through the very
  // denial that names it. Confined to MCP calls: aliasing a core tool would make
  // a `mcp__*` denial swallow tools that have nothing to do with MCP.
  const denyIdentities = mcpAttached ? mcpToolAliases(toolName, ownership, true) : [toolName];
  // Rewritten names are read only for an attached MCP call: the identity carries
  // the namespaces and operation spellings, and an unattached call was refused
  // before this.
  const rewritten = mcpAttached ? call : null;
  // A native harness rewrites TOOL ids too, not only server names: Codex turns
  // `API-post-page` into `API_post_page` (codex-rs/codex-mcp/src/mcp/mod.rs:448).
  // An operator writes the configured id in `deniedTools`, so both sides are
  // compared with punctuation folded to `_`. Globs survive (`*` is preserved), and
  // folding can only ever deny MORE — the safe direction for an explicit denial.
  for (const node of path) {
    const { ontology } = node;
    const denyList = ontology.deniedTools?.length ? { deny: [...ontology.deniedTools] } : null;
    const foldedDeny =
      mcpAttached && denyList ? { deny: denyList.deny.map((entry) => foldNative(entry)) } : null;
    const allowed = (identity: string): boolean =>
      (!denyList || isToolAllowedByPolicyName(identity, denyList)) &&
      (!foldedDeny || isToolAllowedByPolicyName(foldNative(identity), foldedDeny));
    if (mcpAttached) {
      const denied = denyList !== null && denyIdentities.some((identity) => !allowed(identity));
      const reachedByRewrite =
        denyList !== null &&
        rewritten !== null &&
        denyList.deny.some((entry) =>
          rewrittenNameReachesCall(entry, rewritten.namespaces, rewritten.toolParts),
        );
      if (denied || reachedByRewrite) {
        return { node, kind: "scope" };
      }
      continue;
    }
    const scoped = Boolean(ontology.allowedTools?.length || ontology.deniedTools?.length);
    if (
      scoped &&
      !isToolAllowedByPolicyName(toolName, {
        ...(ontology.allowedTools ? { allow: [...ontology.allowedTools] } : {}),
        ...denyList,
      })
    ) {
      return { node, kind: "scope" };
    }
  }
  // Explicit grants only change what SILENCE means, so the loop above still owns
  // every denial: a level that names the tool has already narrowed it, and this
  // asks the one question the per-level gates cannot — did ANY level name it?
  // Skipped for an attached MCP call: the attachment is that grant, and requiring
  // the tool names too would make attaching in the UI insufficient.
  if (params.grantsExplicitly && !mcpAttached) {
    const granted = path.some((node) => {
      const allow = node.ontology.allowedTools;
      return (
        allow !== undefined &&
        allow.length > 0 &&
        isToolAllowedByPolicyName(toolName, { allow: [...allow] })
      );
    });
    // The ACTIVE step is reported, not the root: it is where an operator attaches
    // the tool (or on any step above it), and the root may be the one level that
    // deliberately grants nothing.
    const active = path[path.length - 1];
    if (!granted && active) {
      return { node: active, kind: "ungranted" };
    }
  }
  return null;
}

/**
 * A native harness rewrites TOOL ids too, not only server names: Codex turns
 * `API-post-page` into `API_post_page` (../codex/codex-rs/codex-mcp/src/mcp/mod.rs:448).
 * An operator writes the configured id in `deniedTools`, so both sides are compared
 * with punctuation folded to `_`. Globs survive (`*` is preserved), and folding can
 * only ever deny MORE — the safe direction for an explicit denial.
 */
function foldNative(value: string): string {
  return Array.from(value, (char) => (/[A-Za-z0-9_*]/.test(char) ? char : "_")).join("");
}

/**
 * Does this denial name an operation on this server under a name Codex rewrote?
 *
 * Two rewrites, one hash. On the NAMESPACE it says which of two servers that
 * sanitize alike was meant — unknowable here, so the denial is read as naming ours
 * and compared tool to tool. On the TOOL it replaces the operation itself, either
 * because two collided or because the callable name had to be cut to 64 characters,
 * and in the tightest case the tool part is the hash alone (append_hash_suffix and
 * fit_callable_parts_with_hash, ../codex/codex-rs/codex-mcp/src/tools.rs:190-194,269-287).
 * Nothing can map that back, so the server is the smallest scope that is certainly
 * right.
 *
 * The hash is a sha1 over Codex-internal identity and its hook reports only the
 * flattened name (McpHandler::hook_tool_name,
 * ../codex/codex-rs/core/src/tools/handlers/mcp.rs:47-68), so the match is made
 * against namespaces derived from the stamped server rather than by splitting the
 * entry at its first `__`: a server key may contain `__` itself, and a
 * punctuation-only key leaves no base in front of the hash at all.
 */
function rewrittenNameReachesCall(
  entry: string,
  namespaces: readonly string[],
  toolParts: readonly string[],
): boolean {
  const selector = entry.trim().toLowerCase();
  const match = mcpDenialToolPart(selector, namespaces);
  if (match) {
    if (isUnrecoverableToolPart(match.tool)) {
      return true;
    }
    // An empty tool part is a real name — the one an operation called `_`
    // canonicalizes to — and the glob compiler discards empty patterns, so it is
    // compared directly. A plain namespace needs nothing here: the alias comparison
    // already judged the entry against every spelling of this call.
    if (match.hashed) {
      const named =
        match.tool === ""
          ? toolParts.includes("")
          : toolParts.some((tool) => !isToolAllowedByPolicyName(tool, { deny: [match.tool] }));
      if (named) {
        return true;
      }
    }
  }
  if (!selector.includes("*")) {
    return false;
  }
  // Selectors are globs, so the hash need not be written out: `my_server_*__delete`
  // is how an operator writes "whatever hash Codex picked", and `my_server_a1b2*`
  // is how they write half of it. The slot is matched by SHAPE — twelve hex
  // positions — so a partially constrained pattern counts while one aimed at another
  // operation still does not.
  return namespaces.some((namespace) =>
    hashSlotShapes(namespace, toolParts).some(([prefix, suffix]) =>
      globMatchesHashSlot(selector, prefix, suffix),
    ),
  );
}

/**
 * Where Codex's hash can sit in a name for this server: on the namespace, with the
 * operation still readable after it; or on the operation, which it may also have
 * truncated first, so every prefix of the tool is a place the hash can follow
 * (fit_callable_parts_with_hash, ../codex/codex-rs/codex-mcp/src/tools.rs:269-287).
 */
function hashSlotShapes(namespace: string, toolParts: readonly string[]): [string, string][] {
  return toolParts.flatMap((tool): [string, string][] => [
    // One underscore, or the two an all-underscore namespace leaves behind.
    [`${namespace}_`, `__${tool}`],
    [`${namespace}__`, `__${tool}`],
    // Nothing of the operation left: once the prefixed namespace fills the budget,
    // Codex keeps only the hash as the tool part and the hook name drops its leading
    // underscore (tools.rs:276-286 with join_tool_name).
    [`${namespace}__`, ""],
    ...Array.from({ length: tool.length }, (_, index): [string, string] => [
      `${namespace}__${tool.slice(0, index + 1)}_`,
      "",
    ]),
  ]);
}

/** Which MCP server a call belongs to, and how its tool is spelled. */
type McpOwnership = {
  name: string;
  namespaces: readonly string[];
  toolPart: string;
};

/**
 * Every spelling a `deniedTools` entry might use for this call: the name that
 * actually arrived, plus `<namespace>__<tool>` and `mcp__<namespace>__<tool>` for
 * each namespace this server answers to. An operator writes one of them; the same
 * operation on the same server must be denied whichever runtime dispatched it.
 */
function mcpToolAliases(
  toolName: string,
  ownership: McpOwnership | null,
  /**
   * Include the bare server name. That is the documented shorthand for
   * `deniedTools` — naming a server denies it — but a governance policy's `tools`
   * selector is matched against real call names by this gate, so `github` there
   * must not swallow `github__read`.
   */
  includeBareServer: boolean,
): string[] {
  const aliases = new Set<string>([toolName.trim()]);
  if (ownership) {
    for (const namespace of ownership.namespaces) {
      aliases.add(`${namespace}__${ownership.toolPart}`);
      aliases.add(`mcp__${namespace}__${ownership.toolPart}`);
      // The name a NATIVE run reports for the same operation. MCP keys are
      // free-form, so the trimming Codex applies is not cosmetic: `foo_` with tool
      // `_delete` is reported as `mcp__foo__delete`, a server named `_` reports its
      // `delete` as `mcp__delete`, and a tool named `_` reports as `mcp__foo__`.
      // Those are the spellings an operator copies into `deniedTools`, and each is
      // built by the same sequence Codex uses rather than by trimming in place.
      aliases.add(codexHookToolName(namespace, ownership.toolPart));
      aliases.add(codexHookToolName(withLegacyPrefix(namespace), ownership.toolPart));
      if (includeBareServer) {
        // Naming a server in `deniedTools` denies the server, which is how the
        // native withholding reads it — without these an embedded run would allow
        // the very call a whole-server denial names.
        aliases.add(namespace);
        aliases.add(`mcp__${namespace}`);
      }
    }
  }
  return [...aliases];
}

/**
 * The MCP server that owns this call, from the tool's own registration.
 *
 * Stamped provenance ONLY. The materializer records the server on every MCP tool
 * it builds (setPluginToolMeta ... mcp in agent-bundle-mcp-materialize.ts) and the
 * embedded dispatcher forwards it here.
 *
 * A name can never stand in for it, not even against the servers this run
 * projected: a native harness emits ordinary tool names verbatim and its hook
 * payload carries no origin (../codex/codex-rs/core/src/tools/registry.rs:815-825,
 * core/src/hook_runtime.rs:170-182), so an ordinary tool called `foo__danger` is
 * indistinguishable from server `foo`'s `danger`. Inferring would hand that
 * ordinary tool the attachment's grant, skipping the step's `allowedTools`. Native
 * runtimes are bounded where the mapping IS exact instead — the servers no step
 * attaches are never handed to the subprocess.
 */
function mcpServerOwningTool(params: {
  toolName: string;
  mcpTool?: { serverName: string; safeServerName: string; toolName: string };
  registered: readonly string[];
}): McpOwnership | null {
  const stamped = params.mcpTool;
  if (!stamped || !params.registered.includes(stamped.serverName)) {
    return null;
  }
  return {
    name: stamped.serverName,
    // Both spellings come from the registration, never from parsing the tool
    // name: the materializer rewrites a server whose raw key the tool-name
    // grammar rejects, and deriving the tool part by stripping the RAW key would
    // then leave the whole name in place.
    namespaces: [...new Set([stamped.serverName, stamped.safeServerName])],
    toolPart: stamped.toolName,
  };
}

/**
 * Exact identity, neither case-folded nor trimmed: an attachment names a
 * `mcp.servers` key, those keys are free-form and case-sensitive, and the CLI
 * filter matches them exactly too. Forgiving anything here would make one
 * attachment grant a different configured server — and the two enforcement points
 * disagree about which.
 */
function attachesMcpServer(nodes: readonly EnterprisePlanNode[], server: string): boolean {
  return nodes.some((node) => (node.ontology.mcpServers ?? []).includes(server));
}

function policyAppliesToToolCall(
  policy: GovernancePolicy,
  params: {
    treeId: string;
    path: readonly EnterprisePlanNode[];
    toolName: string;
    /**
     * Every name this one call can arrive under. An MCP tool is `github__read` on
     * the embedded runtime and `mcp__github__read` on Codex, and an operator writes
     * ONE of them: matching only the spelling that happened to arrive would let a
     * runtime switch skip a deny or an approval the native launch ceiling honors.
     */
    call: McpCallIdentity;
    coveringActions: readonly OntologyAction[];
    /** The ontology action the model actually invoked, when the call names one. */
    actionId?: string;
    /** This tool's subject is an action carried in its params (invoke_action). */
    carriesAction?: boolean;
    /** Action ids the active root→node path declares. */
    declaredActions: ReadonlySet<string>;
  },
): boolean {
  const toolScoped = Boolean(policy.tools?.length);
  const actionScoped = Boolean(policy.actions?.length);
  if (!toolScoped && !actionScoped) {
    // Selector-less policies target runs, not calls.
    return false;
  }
  if (policy.knowledge?.length) {
    // A knowledge selector cannot match a tool call, and "all present selectors
    // must match", so a knowledge-scoped policy never applies to tool calls.
    return false;
  }
  if (toolScoped && !selectorsCoverCall(policy.tools ?? [], params.call)) {
    return false;
  }
  if (actionScoped && !actionSelectorMatches(policy, params)) {
    return false;
  }
  // Node-scoped policies match any node on the active step's root→active path,
  // so a policy pinned to the workflow root keeps applying after the run
  // advances into a leaf (it would otherwise silently stop covering deeper
  // steps).
  const nodeMatches = params.path.some((node) => matchesSelector(node.nodeId, policy.nodes));
  return matchesSelector(params.treeId, policy.trees) && nodeMatches;
}

function policyAppliesToRun(
  policy: GovernancePolicy,
  params: { treeId: string; rootNodeId: string },
): boolean {
  if (hasSubjectSelectors(policy)) {
    return false;
  }
  return (
    matchesSelector(params.treeId, policy.trees) && matchesSelector(params.rootNodeId, policy.nodes)
  );
}

/**
 * Evaluate governance for one tool call under the active plan node. `path` is
 * the root→active chain (defaults to the node alone) so ontology tool scope and
 * covering actions compose down the branch; policy tree/node selectors still
 * match the active node itself.
 */
export function evaluateToolCallGovernance(params: {
  plan: EnterpriseRunPlan;
  node: EnterprisePlanNode;
  toolName: string;
  policies: readonly GovernancePolicy[];
  path?: readonly EnterprisePlanNode[];
  /**
   * The ontology action the call names (invoke_action). Present only for calls
   * that carry one; every other tool leaves it undefined.
   */
  actionId?: string;
  /**
   * This tool takes its action from its PARAMS rather than its name. Such a call
   * cannot be judged by an action-scoped policy until the action is known.
   */
  carriesAction?: boolean;
  /**
   * This tool's MCP registration, from the tool object itself. Absent for every
   * non-MCP tool, and for hook paths that dispatch by name with no tool to read.
   */
  mcpTool?: { serverName: string; safeServerName: string; toolName: string };
  /**
   * MCP servers an operator registered under `mcp.servers`. Attachment is
   * enforced for these only: a server a PLUGIN contributes arrives with that
   * plugin's tool surface, is scoped by `allowedTools` like the rest of it, and is
   * not something this screen can register or attach — denying it here would take
   * a working plugin away from every governed run. Same boundary the CLI filter
   * applies to what it hands a subprocess.
   */
  mcpServers?: readonly string[];
  /**
   * Which nodes an MCP attachment is read from. `"path"` is the root→active chain,
   * the same gate every other scope uses. `"plan"` is for runtimes that never
   * advance (CLI, Codex, ACP): they stay pinned at the root for the whole run, so
   * a path check would deny every leaf attachment an operator wrote — and it would
   * contradict what those runtimes were already handed, which is plan-wide.
   */
  attachmentScope?: "path" | "plan";
  /**
   * This run walks steps, so the core step-advance tool was built for it. Also the
   * proof that a call by that name is OURS rather than a plugin's: the tool only
   * exists on a step-tracking run.
   */
  tracksSteps?: boolean;
}): GovernanceDecision {
  // Advancing the run is not a capability a work-map grants — it is how the
  // work-map gets executed at all, so it is decided BEFORE both lanes below.
  // Scoping it would force an operator to name complete_step on every step just
  // to let the run walk its own route; a policy reaching it (`tools: ["*"]` with
  // effect deny, say) would strand the run on step 1 with every later step's
  // scope and every later policy permanently unreachable — including the very
  // policy that made the run step-tracking. There is no legitimate "refuse to
  // advance": a work-map that wants no steps declares a single leaf.
  // Gated on the run actually walking steps, because that is what proves the CORE
  // tool exists: `createOpenClawTools` only builds complete_step for a
  // step-tracking run, so on any other run a PLUGIN tool may legitimately own that
  // name — and exempting it would hand a plugin call a free pass through the
  // work-map's allow-lists and even a catch-all deny.
  if (
    params.tracksSteps === true &&
    isWorkflowControlTool({
      toolName: params.toolName,
      ...(params.mcpTool ? { mcpTool: params.mcpTool } : {}),
    })
  ) {
    return {
      effect: "allow",
      policyId: null,
      source: "default",
      reason: "workflow step advancement is not a governed capability",
    };
  }
  const path = params.path ?? [params.node];
  // MCP first, and it decides how the tool scope below reads this call: an
  // attachment grants the server's tools, so asking "is it attached" before "is
  // it in the allow-list" is what makes attaching in the UI sufficient.
  // Only operator-registered servers are attachable, so only they are gated.
  const ownership = mcpServerOwningTool({
    toolName: params.toolName,
    ...(params.mcpTool ? { mcpTool: params.mcpTool } : {}),
    registered: params.mcpServers ?? [],
  });
  const attachmentNodes = params.attachmentScope === "plan" ? params.plan.nodes : path;
  // Deny-by-default applies only to a work-map that uses the field. A tree written
  // before it existed (the built-ins promise stock behavior) would otherwise lose
  // every configured MCP server on upgrade, with no migration and nothing to opt
  // out to. Read from the plan's own flag, which was taken from the DEFINITION: a
  // route that pruned away the step holding the only attachment must not turn the
  // rule off for the rest of the run.
  const mcpGoverned = params.plan.mcpGoverned === true;
  const mcpAttached =
    ownership && mcpGoverned ? attachesMcpServer(attachmentNodes, ownership.name) : false;
  if (ownership && mcpGoverned && !mcpAttached) {
    return {
      effect: "deny",
      policyId: null,
      source: "ontology",
      reason: `MCP server "${ownership.name}" is not attached to workflow step "${params.node.nodeId}"; a step (or one of its ancestors) must name it in ontology.mcpServers`,
    };
  }
  // Every spelling of THIS call, built once. `identities` leaves out the bare
  // server name: unlike `deniedTools`, a policy or action selector is judged
  // against real call names, so `github` there must not swallow `github__read`.
  const call: McpCallIdentity = {
    identities: ownership ? mcpToolAliases(params.toolName, ownership, false) : [params.toolName],
    namespaces: ownership ? codexHookNamespaces(ownership.namespaces) : [],
    toolParts: ownership
      ? [
          ...new Set([
            ownership.toolPart.toLowerCase(),
            codexNamespace(ownership.toolPart).toLowerCase(),
            trimCodexToolName(codexNamespace(ownership.toolPart)).toLowerCase(),
          ]),
        ]
      : [],
  };
  const violation = ontologyScopeViolation({
    path,
    toolName: params.toolName,
    mcpAttached,
    ownership,
    call,
    grantsExplicitly: params.plan.capabilityGrants === "explicit",
  });
  if (violation) {
    return {
      effect: "deny",
      policyId: null,
      source: "ontology",
      // Two different fixes, so two different sentences: a scope violation means
      // some step narrowed the tool away, while an ungranted call means nobody
      // ever attached it — and an operator reading the first would look at the
      // wrong step.
      reason:
        violation.kind === "ungranted"
          ? `tool "${params.toolName}" is not granted to workflow step "${violation.node.nodeId}"; this work-map grants capabilities explicitly, so a step (or one of its ancestors) must name it in ontology.allowedTools`
          : `tool "${params.toolName}" is outside the ontology tool scope of workflow step "${violation.node.nodeId}"`,
    };
  }

  const coveringActions = actionsCoveringTool(path, call);
  const declaredActions = new Set(
    path.flatMap((node) => (node.ontology.actions ?? []).map((action) => action.id)),
  );
  const matching = params.policies.filter((policy) =>
    policyAppliesToToolCall(policy, {
      treeId: params.plan.treeId,
      path,
      toolName: params.toolName,
      call,
      coveringActions,
      declaredActions,
      ...(params.actionId !== undefined ? { actionId: params.actionId } : {}),
      ...(params.carriesAction ? { carriesAction: true } : {}),
    }),
  );
  // Name the ACTION in the reason when the call carried one: an operator reading
  // "action \"refund\" is denied" can act on it; "tool invoke_action is denied"
  // tells them nothing about which of a node's actions tripped the policy.
  const subject =
    params.actionId !== undefined ? `action "${params.actionId}"` : `tool "${params.toolName}"`;
  const decision = resolvePolicyDecision(matching, () => subject);
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this tool call",
  };
}

function policyAppliesToKnowledge(
  policy: GovernancePolicy,
  params: { treeId: string; path: readonly EnterprisePlanNode[]; foundationId: string },
): boolean {
  if (!policy.knowledge?.length || !matchesSelector(params.foundationId, policy.knowledge)) {
    return false;
  }
  if (policy.tools?.length || policy.actions?.length) {
    // A tool/action selector cannot match a knowledge retrieval, and "all
    // present selectors must match", so such a policy never gates retrieval.
    return false;
  }
  // Node selector matches any node on the active step's root→active path, so a
  // policy pinned to the workflow root keeps covering knowledge from leaves.
  const nodeMatches = params.path.some((node) => matchesSelector(node.nodeId, policy.nodes));
  return matchesSelector(params.treeId, policy.trees) && nodeMatches;
}

/**
 * Evaluate governance for retrieving from one knowledge foundation under the
 * active plan node. `path` is the root→active chain (defaults to the node
 * alone). Which foundations a step may query at all is an ontology allow-list
 * enforced before this call; here config policies gate the foundations in scope.
 */
export function evaluateKnowledgeRetrievalGovernance(params: {
  plan: EnterpriseRunPlan;
  node: EnterprisePlanNode;
  foundationId: string;
  policies: readonly GovernancePolicy[];
  path?: readonly EnterprisePlanNode[];
}): GovernanceDecision {
  const path = params.path ?? [params.node];
  const matching = params.policies.filter((policy) =>
    policyAppliesToKnowledge(policy, {
      treeId: params.plan.treeId,
      path,
      foundationId: params.foundationId,
    }),
  );
  const decision = resolvePolicyDecision(
    matching,
    () => `knowledge foundation "${params.foundationId}"`,
  );
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this knowledge foundation",
  };
}

/**
 * Compose matching policies deny > require_approval > allow > audit,
 * order-independent.
 */
function resolvePolicyDecision(
  matching: readonly GovernancePolicy[],
  describeSubject: (policy: GovernancePolicy) => string,
): GovernanceDecision | null {
  const winner =
    matching.find((policy) => policy.effect === "deny") ??
    matching.find((policy) => policy.effect === "require_approval") ??
    matching.find((policy) => policy.effect === "allow") ??
    matching.find((policy) => policy.effect === "audit");
  if (!winner) {
    return null;
  }
  // Blank descriptions fall back to a generated reason so denial messages
  // and decision traces never surface empty text.
  const description = winner.description?.trim();
  const generated =
    winner.effect === "deny"
      ? `${describeSubject(winner)} is denied by governance policy "${winner.id}"`
      : winner.effect === "require_approval"
        ? `${describeSubject(winner)} requires approval by governance policy "${winner.id}"`
        : `${winner.effect === "allow" ? "allowed" : "audited"} by governance policy "${winner.id}"`;
  return {
    effect: winner.effect,
    policyId: winner.id,
    source: "policy",
    reason: description || generated,
    ...(winner.effect === "require_approval" && winner.approval
      ? { approval: winner.approval }
      : {}),
  };
}

/** Evaluate run-level governance for the selected tree before execution starts. */
export function evaluateRunStartGovernance(params: {
  plan: EnterpriseRunPlan;
  policies: readonly GovernancePolicy[];
}): GovernanceDecision {
  // Run-level policies target the tree as a whole, so match their node selector
  // against the workflow root (nodes[0]) — not the first leaf the run starts
  // execution on, which would drop root-scoped run-start policies.
  const rootNodeId = params.plan.nodes[0]?.nodeId ?? params.plan.activeNodeId;
  const runScope = { treeId: params.plan.treeId, rootNodeId };
  const matching = params.policies.filter((policy) => policyAppliesToRun(policy, runScope));
  const decision = resolvePolicyDecision(matching, () => `workflow tree "${params.plan.treeId}"`);
  if (decision) {
    return decision;
  }
  return {
    effect: "allow",
    policyId: null,
    source: "default",
    reason: "no governance policy restricts this workflow tree",
  };
}
