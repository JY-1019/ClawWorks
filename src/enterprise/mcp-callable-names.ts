import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";

/**
 * The names a runtime can put in front of the model — and in front of its hooks —
 * for an MCP tool, and the rewrites it applies to make them unique and short
 * enough.
 *
 * Shared by both enforcement surfaces — the per-call gate in `governance.ts` and
 * the launch-time withholding in `active-runs.ts` — so a denial an operator writes
 * is read against one grammar rather than two drifting copies.
 */

/**
 * Codex's callable namespace for a server name: every character outside
 * `[A-Za-z0-9_]` becomes `_` (sanitize_responses_api_tool_name,
 * ../codex/codex-rs/codex-mcp/src/mcp/mod.rs:448).
 */
export function codexNamespace(server: string): string {
  // Per CHARACTER, not per UTF-16 unit: Codex iterates chars, so one astral
  // character becomes one `_` rather than two.
  const sanitized = Array.from(server, (char) => (/[A-Za-z0-9_]/.test(char) ? char : "_")).join("");
  return sanitized || "_";
}

/**
 * Codex's disambiguator: `_` plus 12 hex characters of a sha1 over an identity
 * built from the server name, connector id, and raw tool name
 * (callable_name_hash_suffix, ../codex/codex-rs/codex-mcp/src/tools.rs:241-250).
 * It lands on the NAMESPACE when two servers sanitize alike (tools.rs:164-170), on
 * the TOOL when two operations do (tools.rs:190-194), and on a truncated tool when
 * the callable name would pass 64 characters (fit_callable_parts_with_hash,
 * tools.rs:269-287).
 *
 * The identity includes Codex-internal state, so this side can recognize the SHAPE
 * but never reproduce the value.
 */
const COLLISION_HASH_LENGTH = 12;
const COLLISION_HASH = `[0-9a-f]{${COLLISION_HASH_LENGTH}}`;

/**
 * 64-character budget minus the 13-character hash and the 2-character delimiter:
 * the length Codex truncates a namespace to when even a hash-only tool part will
 * not fit (fit_callable_parts_with_hash, ../codex/codex-rs/codex-mcp/src/tools.rs:283).
 * The namespace already carries the `mcp__` prefix at that point (tools.rs:139-146),
 * so a long server keeps only 44 of its own characters.
 */
export const CODEX_NAMESPACE_TRUNCATION_LIMIT = 49;

/**
 * Every namespace spelling Codex can report for this server, lower-cased.
 *
 * Its hook name is built by `join_tool_name` + `ensure_mcp_prefix`
 * (../codex/codex-rs/core/src/tools/handlers/mcp.rs:52-68), which trims trailing
 * `_` off the namespace — so the trimmed form is the one a delimiter follows, and
 * any underscore an operator copied lands in the tool part instead.
 */
/** Codex's legacy prefix, added by default (../codex/codex-rs/core/src/config/mod.rs:1753). */
const LEGACY_PREFIX = "mcp__";

/**
 * `join_tool_name` trims trailing `_` off the namespace and leading `_` off the
 * tool before the hook name is built
 * (../codex/codex-rs/core/src/tools/handlers/mcp.rs:52-62), so those characters
 * never survive into anything an operator can copy.
 */
export function trimCodexNamespace(namespace: string): string {
  return namespace.replace(/_+$/, "");
}

export function trimCodexToolName(tool: string): string {
  return tool.replace(/^_+/, "");
}

/**
 * The name Codex's hook reports, from a namespace it has already prefixed (or not)
 * and a raw tool name: trim, join with `__`, then ensure the legacy prefix
 * (join_tool_name + ensure_mcp_prefix,
 * ../codex/codex-rs/core/src/tools/handlers/mcp.rs:47-68).
 *
 * Both parts are sanitized first, because Codex sanitizes them before it flattens
 * (tools.rs:139-147). The order matters and the empty results are real: a server key
 * of `.` sanitizes to `_` and prefixes to `mcp___`, whose trailing underscores trim
 * away to `mcp`, so its `delete` is reported as `mcp__delete`; a tool named `.`
 * sanitizes to `_` and trims to nothing, reported as `mcp__<server>__`. Dropping
 * either empty component would lose the exact spelling an operator copies out of a
 * denial.
 */
export function codexHookToolName(namespace: string, tool: string): string {
  const joined = `${trimCodexNamespace(codexNamespace(namespace))}__${trimCodexToolName(
    codexNamespace(tool),
  )}`;
  return joined.startsWith(LEGACY_PREFIX) ? joined : `${LEGACY_PREFIX}${joined}`;
}

/** A namespace with Codex's legacy prefix, which it adds by default. */
export function withLegacyPrefix(namespace: string): string {
  return namespace.startsWith(LEGACY_PREFIX) ? namespace : `${LEGACY_PREFIX}${namespace}`;
}

export function codexHookNamespaces(names: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const name of names) {
    // Case is preserved until the very end: Codex decides whether to add its legacy
    // prefix with a case-SENSITIVE check (callable_namespace_with_prefix,
    // ../codex/codex-rs/codex-mcp/src/tools.rs:139-146), so a key spelled `MCP__x`
    // still gets one and becomes `mcp__MCP__x`. Lowercasing first would model the
    // wrong namespace entirely.
    for (const base of new Set([name, codexNamespace(name)])) {
      const prefixed = withLegacyPrefix(base);
      for (const form of [
        base,
        prefixed,
        // Truncation applies to the PREFIXED namespace, so the two forms cut at
        // different points in the server's own characters.
        base.slice(0, CODEX_NAMESPACE_TRUNCATION_LIMIT),
        prefixed.slice(0, CODEX_NAMESPACE_TRUNCATION_LIMIT),
      ]) {
        // Lower-cased only now: the gate lower-cases every tool name before it
        // compares, while Codex preserves ASCII case in what it emits.
        const trimmed = trimCodexNamespace(form).toLowerCase();
        if (trimmed) {
          forms.add(trimmed);
        }
      }
    }
  }
  return [...forms];
}

/**
 * The tool part `entry` names under one of `namespaces`, and whether the namespace
 * carried Codex's collision hash. Null when the entry names nothing there.
 *
 * The hash identifies WHICH of two servers that sanitize alike was meant, and that
 * is unknowable here, so it is accepted for either. Its separator is one or more
 * underscores: the hash is appended where the namespace's own trailing underscores
 * were (append_namespace_hash_suffix, ../codex/codex-rs/codex-mcp/src/tools.rs:252-263),
 * and the hook name then trims what is left — so a punctuation-only server, whose
 * namespace is all underscores, is reported as `mcp__<hash>__<tool>` with no base
 * left at all.
 */
export function mcpDenialToolPart(
  entry: string,
  namespaces: readonly string[],
): { tool: string; hashed: boolean } | null {
  // Hashed forms first, across every namespace. A punctuation-only server keeps no
  // base in front of the hash, so its `mcp__<hash>__delete` also satisfies the plain
  // `mcp__` prefix — and reading it that way would hand back `<hash>__delete` as if
  // it were an ordinary tool name and lose the denial.
  for (const namespace of namespaces) {
    // The tool part may be EMPTY: an operation named `_` trims to nothing, so a
    // hashed namespace leaves the entry ending at the delimiter
    // (`mcp__foo_<hash>__`). Requiring a tool there would drop the match and let the
    // plain pass read the hash itself as an ordinary tool name.
    const hashed = new RegExp(`^${escapeRegExp(namespace)}_+${COLLISION_HASH}__(.*)$`).exec(entry);
    if (hashed) {
      return { tool: hashed[1] ?? "", hashed: true };
    }
  }
  for (const namespace of namespaces) {
    const plain = `${namespace}__`;
    if (entry.startsWith(plain) && entry.length > plain.length) {
      return { tool: entry.slice(plain.length), hashed: false };
    }
  }
  return null;
}

/**
 * Is this tool part a rewrite nothing here can map back to a stamped identity?
 *
 * Two shapes, one hash: `<tool>_<hash>` when the operation collided or its name
 * had to be truncated, and a bare hash when even that would not fit — the model
 * sees `_<hash>` and the hook sees it with the leading underscore trimmed
 * (join_tool_name, ../codex/codex-rs/core/src/tools/handlers/mcp.rs:52-62).
 */
export function isUnrecoverableToolPart(toolPart: string): boolean {
  return new RegExp(`(^|_)${COLLISION_HASH}$`).test(toolPart);
}

/**
 * Can this glob match `prefix` + Codex's 12-hex hash + `suffix`?
 *
 * A selector is an unrestricted glob, so an operator can constrain the hash slot
 * partially (`my_server_a1b2*__delete`) instead of copying the whole value. Rather
 * than testing one made-up hash, the pattern is matched against the SHAPE: fixed
 * characters where the name is fixed, and twelve positions that accept any hex
 * digit. Classic wildcard matching with a per-position predicate, so the answer is
 * exact for every glob rather than for the values a stand-in happens to cover.
 */
export function globMatchesHashSlot(pattern: string, prefix: string, suffix: string): boolean {
  const accepts: ((char: string) => boolean)[] = [
    ...Array.from(prefix, (expected) => (char: string) => char === expected),
    ...Array.from({ length: COLLISION_HASH_LENGTH }, () => (char: string) => /[0-9a-f]/.test(char)),
    ...Array.from(suffix, (expected) => (char: string) => char === expected),
  ];
  // reachable[j] = the pattern consumed so far can end at slot j.
  let reachable = accepts.map(() => false);
  let atStart = true;
  for (const token of pattern) {
    if (token === "*") {
      // A wildcard extends every reachable point to the end of the name.
      let seen = atStart;
      reachable = reachable.map((value) => {
        seen = seen || value;
        return seen;
      });
      continue;
    }
    reachable = accepts.map((accept, index) => {
      const previous = index === 0 ? atStart : (reachable[index - 1] ?? false);
      return previous && accept(token);
    });
    atStart = false;
  }
  return accepts.length === 0 ? atStart : (reachable[accepts.length - 1] ?? false);
}

/**
 * Could one tool name satisfy both globs? Exact when either side is concrete; for
 * two globs it compares their leading literals, which is enough to separate
 * patterns aimed at different tools of the same server.
 */
export function patternsCanShareACall(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!left || !right || left === "*" || right === "*") {
    return true;
  }
  if (!right.includes("*")) {
    return !isToolAllowedByPolicyName(right, { deny: [left] });
  }
  if (!left.includes("*")) {
    return !isToolAllowedByPolicyName(left, { deny: [right] });
  }
  const leftHead = left.split("*")[0] ?? "";
  const rightHead = right.split("*")[0] ?? "";
  if (!leftHead.startsWith(rightHead) && !rightHead.startsWith(leftHead)) {
    return false;
  }
  // And what follows the wildcard: `github__*read` and `github__*delete` share a
  // head but no name can end both ways.
  const leftTail = left.slice(left.lastIndexOf("*") + 1);
  const rightTail = right.slice(right.lastIndexOf("*") + 1);
  return leftTail.endsWith(rightTail) || rightTail.endsWith(leftTail);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
