import { describe, expect, it } from "vitest";
import {
  evaluateKnowledgeRetrievalGovernance,
  evaluateRunStartGovernance,
  evaluateToolCallGovernance,
} from "./governance.js";
import type { EnterprisePlanNode, EnterpriseRunPlan, GovernancePolicy } from "./types.js";

function planWith(node: Partial<EnterprisePlanNode>): {
  plan: EnterpriseRunPlan;
  node: EnterprisePlanNode;
} {
  const fullNode: EnterprisePlanNode = {
    nodeId: "support",
    parentId: null,
    seq: 0,
    title: "Support",
    ontology: {},
    ...node,
  };
  const plan: EnterpriseRunPlan = {
    runId: "run-1",
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "planner",
    requestSummary: "help",
    nodes: [fullNode],
    activeNodeId: fullNode.nodeId,
    mode: "enforce",
    createdAt: 0,
  };
  return { plan, node: fullNode };
}

describe("evaluateToolCallGovernance", () => {
  it("allows by default when nothing restricts the tool", () => {
    const { plan, node } = planWith({});
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: [] });
    expect(decision.effect).toBe("allow");
    expect(decision.source).toBe("default");
  });

  it("denies tools outside the ontology allowlist", () => {
    const { plan, node } = planWith({ ontology: { allowedTools: ["memory_search"] } });
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: [] });
    // An allow-list that does not mention the tool is an OMISSION, not a decision,
    // so it asks a human rather than failing the call outright.
    expect(decision.effect).toBe("require_approval");
    expect(decision.source).toBe("ontology");
    expect(decision.reason).toContain('"exec"');
    expect(decision.reason).toContain('"support"');
  });

  it("denies a registered MCP server no step attached", () => {
    // The point of the field: registering a server does not make it callable, so a
    // step that never attached it is refused even with tools wide open. The
    // work-map opts in by attaching somewhere — here, on another step.
    const root: EnterprisePlanNode = {
      nodeId: "support",
      parentId: null,
      seq: 0,
      title: "Support",
      ontology: { allowedTools: ["*"] },
    };
    const sibling: EnterprisePlanNode = {
      nodeId: "support.other",
      parentId: "support",
      seq: 1,
      title: "Other",
      ontology: { mcpServers: ["atlassian"] },
    };
    const { plan } = planWith(root);
    plan.nodes = [root, sibling];
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node: root,
      toolName: "github__create_issue",
      policies: [],
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("deny");
    expect(decision.source).toBe("ontology");
    expect(decision.reason).toContain('"github"');
  });

  it("leaves a work-map that never mentions MCP ungoverned", () => {
    // Upgrade safety: a tree written before this field existed — the built-ins
    // included, which promise stock behavior — must not lose its servers.
    const { plan, node } = planWith({ ontology: { allowedTools: ["*"] } });
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "github__create_issue",
      policies: [],
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("allow");
  });

  it("allows an MCP server the step attached", () => {
    const { plan, node } = planWith({ ontology: { mcpServers: ["github"] } });
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "github__create_issue",
      policies: [],
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("allow");
  });

  it("inherits an ancestor's MCP attachment", () => {
    // Attaching on the root is how an operator covers a subtree; requiring every
    // leaf to repeat it would make the root grant meaningless.
    const root: EnterprisePlanNode = {
      nodeId: "support",
      parentId: null,
      seq: 0,
      title: "Support",
      ontology: { mcpServers: ["github"] },
    };
    const leaf: EnterprisePlanNode = {
      nodeId: "support.triage",
      parentId: "support",
      seq: 1,
      title: "Triage",
      ontology: {},
    };
    const { plan } = planWith(root);
    plan.nodes = [root, leaf];
    // Without this the work-map is ungoverned and the assertion would hold even if
    // inheritance were removed entirely.
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node: leaf,
      toolName: "github__create_issue",
      policies: [],
      path: [root, leaf],
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("allow");
  });

  it("lets a deny list take back an attached server's tool", () => {
    // The attachment grants the server; an explicit denial is how a step narrows
    // within it, and deny-wins is the rule everywhere else here.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["github"], deniedTools: ["github__delete_repo"] },
    });
    plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        toolName: "github__delete_repo",
        policies: [],
        mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
        mcpServers: ["github"],
      }).effect,
    ).toBe("deny");
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        toolName: "github__create_issue",
        policies: [],
        mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
        mcpServers: ["github"],
      }).effect,
    ).toBe("allow");
  });

  it("honors a denial written with Codex's collision hash", () => {
    // Codex disambiguates colliding namespaces with `_` + 12 hex characters
    // (../codex/codex-rs/codex-mcp/src/tools.rs:164-169), so an operator copying a
    // denial from the model-visible name writes the hash into it. The embedded call
    // arrives under the unhashed OpenClaw spelling; the denial still has to reach.
    const { plan, node } = planWith({
      ontology: {
        mcpServers: ["my-server"],
        deniedTools: ["mcp__my_server_a1b2c3d4e5f6__delete"],
      },
    });
    plan.mcpGoverned = true;
    const call = {
      plan,
      node,
      policies: [],
      mcpServers: ["my-server"],
    } as const;
    expect(
      evaluateToolCallGovernance({
        ...call,
        toolName: "my-server__delete",
        mcpTool: { serverName: "my-server", safeServerName: "my-server", toolName: "delete" },
      }).effect,
    ).toBe("deny");
    // The rest of the server is still granted: stripping the hash must not widen
    // the denial past the operation it names.
    expect(
      evaluateToolCallGovernance({
        ...call,
        toolName: "my-server__search",
        mcpTool: { serverName: "my-server", safeServerName: "my-server", toolName: "search" },
      }).effect,
    ).toBe("allow");
  });

  it("honors a collision denial for a server with no base left to name it", () => {
    // A punctuation-only key sanitizes to `_`, prefixes to `mcp___`, and on collision
    // the hash lands where those underscores were
    // (append_namespace_hash_suffix, ../codex/codex-rs/codex-mcp/src/tools.rs:252-263):
    // the hook reports `mcp__<hash>__delete`, with nothing of the server in it. The
    // denial still names an operation this server has, so it applies to ours too.
    for (const [server, safeServer] of [
      [".", "-"],
      ["_", "_"],
    ]) {
      const { plan, node } = planWith({
        ontology: { mcpServers: [server], deniedTools: ["mcp__a1b2c3d4e5f6__delete"] },
      });
      plan.mcpGoverned = true;
      const call = { plan, node, policies: [], mcpServers: [server] } as const;
      expect(
        evaluateToolCallGovernance({
          ...call,
          toolName: `${safeServer}__delete`,
          mcpTool: { serverName: server, safeServerName: safeServer, toolName: "delete" },
        }).effect,
        server,
      ).toBe("deny");
      // The hash says which of two colliding servers was meant, not which tool, so
      // the rest of this server stays callable.
      expect(
        evaluateToolCallGovernance({
          ...call,
          toolName: `${safeServer}__search`,
          mcpTool: { serverName: server, safeServerName: safeServer, toolName: "search" },
        }).effect,
        server,
      ).toBe("allow");
    }
  });

  it("matches a hash-only selector for a server that fills the name budget", () => {
    // A 44-character key prefixes to exactly 49, leaving no room for the operation:
    // Codex keeps only the hash as the tool part (tools.rs:276-286) and the hook name
    // reads `mcp__<44 chars>__<hash>`. A selector constrained at both ends of that
    // hash is still a rule about this call.
    const server = "s".repeat(44);
    const denied = planWith({
      ontology: { mcpServers: [server], deniedTools: [`mcp__${server}__a1b2*e5f6`] },
    });
    denied.plan.mcpGoverned = true;
    const mcpTool = { serverName: server, safeServerName: server, toolName: "delete_repo" };
    expect(
      evaluateToolCallGovernance({
        plan: denied.plan,
        node: denied.node,
        policies: [],
        toolName: `${server}__delete_repo`,
        mcpTool,
        mcpServers: [server],
      }).effect,
    ).toBe("deny");

    const policed = planWith({ ontology: { mcpServers: [server] } });
    policed.plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan: policed.plan,
        node: policed.node,
        policies: [
          { id: "p-hash-only", effect: "require_approval", tools: [`mcp__${server}__*f6`] },
        ],
        toolName: `${server}__delete_repo`,
        mcpTool,
        mcpServers: [server],
      }).effect,
    ).toBe("require_approval");
  });

  it("matches a policy or action selector that globs over Codex's hash", () => {
    // Selectors are globs, so an operator writes the hash slot as `*` rather than
    // copying whatever Codex picked. The native launch filter already reads such a
    // glob as reaching the server; the embedded gate has to reach the same call.
    const { plan, node } = planWith({
      ontology: {
        mcpServers: ["my-server"],
        actions: [{ id: "purge", description: "purge", tools: ["mcp__my_server_*__delete_repo"] }],
      },
    });
    plan.mcpGoverned = true;
    const call = (tool: string) =>
      ({
        plan,
        node,
        toolName: `my-server__${tool}`,
        mcpTool: { serverName: "my-server", safeServerName: "my-server", toolName: tool },
        mcpServers: ["my-server"],
      }) as const;

    // Fully open and partially constrained hash slots both count; a slot whose
    // literals cannot be hex, or a selector aimed at another operation, do not.
    for (const slot of ["*", "a1b2*", "*e5f6", "a1b2*f6"]) {
      const globbed: GovernancePolicy[] = [
        { id: "p-glob", effect: "deny", tools: [`mcp__my_server_${slot}__delete_repo`] },
      ];
      expect(
        evaluateToolCallGovernance({ ...call("delete_repo"), policies: globbed }).effect,
        slot,
      ).toBe("deny");
      expect(
        evaluateToolCallGovernance({ ...call("search"), policies: globbed }).effect,
        slot,
      ).toBe("allow");
    }
    expect(
      evaluateToolCallGovernance({
        ...call("delete_repo"),
        policies: [
          { id: "p-not-hex", effect: "deny", tools: ["mcp__my_server_zzz*__delete_repo"] },
        ],
      }).effect,
    ).toBe("allow");

    // A hashed TOOL glob names the same operation, so it stays operation-scoped.
    const toolGlob: GovernancePolicy[] = [
      { id: "p-tool-glob", effect: "deny", tools: ["mcp__my_server__delete_repo_a1b2*"] },
    ];
    expect(evaluateToolCallGovernance({ ...call("delete_repo"), policies: toolGlob }).effect).toBe(
      "deny",
    );
    expect(evaluateToolCallGovernance({ ...call("search"), policies: toolGlob }).effect).toBe(
      "allow",
    );

    // The action's own tool list reads the same way, so an actions-scoped policy
    // covers the call it names.
    const actionScoped: GovernancePolicy[] = [
      { id: "p-action", effect: "require_approval", actions: ["purge"] },
    ];
    expect(
      evaluateToolCallGovernance({ ...call("delete_repo"), policies: actionScoped }).effect,
    ).toBe("require_approval");
    expect(evaluateToolCallGovernance({ ...call("search"), policies: actionScoped }).effect).toBe(
      "allow",
    );
  });

  it("matches a governance policy written with Codex's rewritten name", () => {
    // Codex hashes a colliding namespace and a colliding or truncated tool
    // (../codex/codex-rs/codex-mcp/src/tools.rs:153,269), and that is the name an
    // operator copies. The launch ceiling already withholds the server for such a
    // selector; the embedded gate has to reach the same call.
    const { plan, node } = planWith({ ontology: { mcpServers: ["my-server"] } });
    plan.mcpGoverned = true;
    const call = (tool: string) =>
      ({
        plan,
        node,
        toolName: `my-server__${tool}`,
        mcpTool: { serverName: "my-server", safeServerName: "my-server", toolName: tool },
        mcpServers: ["my-server"],
      }) as const;

    // Hashed NAMESPACE: names one operation, on whichever of the colliding servers.
    const namespaceHashed: GovernancePolicy[] = [
      { id: "p-ns", effect: "deny", tools: ["mcp__my_server_a1b2c3d4e5f6__delete_repo"] },
    ];
    expect(
      evaluateToolCallGovernance({ ...call("delete_repo"), policies: namespaceHashed }).effect,
    ).toBe("deny");
    expect(
      evaluateToolCallGovernance({ ...call("search"), policies: namespaceHashed }).effect,
    ).toBe("allow");

    // Hashed TOOL: nothing can say which operation, so the server is the scope.
    const toolHashed: GovernancePolicy[] = [
      {
        id: "p-tool",
        effect: "require_approval",
        tools: ["mcp__my_server__delete_repo_a1b2c3d4e5f6"],
      },
    ];
    for (const tool of ["delete_repo", "search"]) {
      const decision = evaluateToolCallGovernance({ ...call(tool), policies: toolHashed });
      expect(decision.effect, tool).toBe("require_approval");
      expect(decision.policyId, tool).toBe("p-tool");
    }
  });

  it("matches a governance policy written in either runtime's spelling", () => {
    // The launch ceiling already treats such a selector as reaching the server, so
    // an embedded run that ignored it would enforce less than the native one — the
    // same rule, a different answer per runtime.
    const { plan, node } = planWith({ ontology: { mcpServers: ["github"] } });
    plan.mcpGoverned = true;
    const call = {
      plan,
      node,
      toolName: "github__delete_repo",
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "delete_repo" },
      mcpServers: ["github"],
    } as const;
    for (const [effect, expected] of [
      ["deny", "deny"],
      ["require_approval", "require_approval"],
    ] as const) {
      for (const selector of ["mcp__github__delete_repo", "github__delete_repo"]) {
        const decision = evaluateToolCallGovernance({
          ...call,
          policies: [
            {
              id: `p-${effect}`,
              effect,
              tools: [selector],
            },
          ],
        });
        expect(decision.effect, `${effect}/${selector}`).toBe(expected);
        expect(decision.policyId, `${effect}/${selector}`).toBe(`p-${effect}`);
      }
    }
    // A selector for another server still does not touch this call.
    expect(
      evaluateToolCallGovernance({
        ...call,
        policies: [{ id: "p-other", effect: "deny", tools: ["mcp__atlassian__delete_repo"] }],
      }).effect,
    ).toBe("allow");
  });

  it("honors a collision denial whose operation canonicalizes to nothing", () => {
    // Tool `_` trims to nothing, so a colliding namespace leaves the hook name
    // ending at the delimiter: `mcp__foo_<hash>__`. The tool part is empty AND real,
    // and the glob compiler drops empty patterns, so it is compared directly.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["foo"], deniedTools: ["mcp__foo_a1b2c3d4e5f6__"] },
    });
    plan.mcpGoverned = true;
    const call = { plan, node, policies: [], mcpServers: ["foo"] } as const;
    for (const tool of ["_", "."]) {
      expect(
        evaluateToolCallGovernance({
          ...call,
          toolName: `foo__${tool}`,
          mcpTool: { serverName: "foo", safeServerName: "foo", toolName: tool },
        }).effect,
        tool,
      ).toBe("deny");
    }
    // A named operation on the same server is untouched by that denial.
    expect(
      evaluateToolCallGovernance({
        ...call,
        toolName: "foo__search",
        mcpTool: { serverName: "foo", safeServerName: "foo", toolName: "search" },
      }).effect,
    ).toBe("allow");
  });

  it("honors the non-prefixed spelling of that collision", () => {
    // With Codex's legacy prefix off, the same server's namespace is `_` and the
    // hash follows it directly, so the hook reports `mcp____<hash>__delete`.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["."], deniedTools: ["mcp____a1b2c3d4e5f6__delete"] },
    });
    plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        policies: [],
        mcpServers: ["."],
        toolName: "-__delete",
        mcpTool: { serverName: ".", safeServerName: "-", toolName: "delete" },
      }).effect,
    ).toBe("deny");
  });

  it("honors denials for names Codex sanitizes to nothing", () => {
    // Sanitization runs before flattening (../codex/codex-rs/codex-mcp/src/tools.rs:139-147),
    // so punctuation reaches the same empty components underscores do: tool `.`
    // becomes `_` and then nothing, and server `.` becomes `_` whose prefix trims to
    // `mcp`. Reading the raw names would leave both denials unmatched.
    const punctuationTool = planWith({
      ontology: { mcpServers: ["foo"], deniedTools: ["mcp__foo__"] },
    });
    punctuationTool.plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan: punctuationTool.plan,
        node: punctuationTool.node,
        policies: [],
        mcpServers: ["foo"],
        toolName: "foo__.",
        mcpTool: { serverName: "foo", safeServerName: "foo", toolName: "." },
      }).effect,
    ).toBe("deny");

    const punctuationServer = planWith({
      ontology: { mcpServers: ["."], deniedTools: ["mcp__delete"] },
    });
    punctuationServer.plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan: punctuationServer.plan,
        node: punctuationServer.node,
        policies: [],
        mcpServers: ["."],
        toolName: "-__delete",
        mcpTool: { serverName: ".", safeServerName: "-", toolName: "delete" },
      }).effect,
    ).toBe("deny");
  });

  it("honors denials for names whose canonical parts trim to nothing", () => {
    // MCP keys and tool names are free-form. A tool named `_` is reported as
    // `mcp__foo__` and a server named `_` reports its `delete` as `mcp__delete`
    // — the prefix's own underscores trim away with the key's
    // (join_tool_name + ensure_mcp_prefix, ../codex/codex-rs/core/src/tools/handlers/mcp.rs:47-68).
    // Dropping those empty parts would silently skip an explicit denial.
    const emptyTool = planWith({
      ontology: { mcpServers: ["foo"], deniedTools: ["mcp__foo__"] },
    });
    emptyTool.plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan: emptyTool.plan,
        node: emptyTool.node,
        policies: [],
        mcpServers: ["foo"],
        toolName: "foo___",
        mcpTool: { serverName: "foo", safeServerName: "foo", toolName: "_" },
      }).effect,
    ).toBe("deny");

    const emptyServer = planWith({
      ontology: { mcpServers: ["_"], deniedTools: ["mcp__delete"] },
    });
    emptyServer.plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan: emptyServer.plan,
        node: emptyServer.node,
        policies: [],
        mcpServers: ["_"],
        toolName: "___delete",
        mcpTool: { serverName: "_", safeServerName: "_", toolName: "delete" },
      }).effect,
    ).toBe("deny");
  });

  it("honors a denial written with Codex's trimmed hook spelling", () => {
    // MCP keys are free-form, so `foo_` with tool `_delete` is valid. Codex reports
    // it as `mcp__foo__delete` — trailing `_` off the namespace, leading `_` off the
    // tool (join_tool_name, ../codex/codex-rs/core/src/tools/handlers/mcp.rs:52-62).
    // That is the name an operator copies, and the embedded call arrives untrimmed.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["foo_"], deniedTools: ["mcp__foo__delete"] },
    });
    plan.mcpGoverned = true;
    const call = { plan, node, policies: [], mcpServers: ["foo_"] } as const;
    expect(
      evaluateToolCallGovernance({
        ...call,
        toolName: "foo___delete",
        mcpTool: { serverName: "foo_", safeServerName: "foo_", toolName: "delete" },
      }).effect,
    ).toBe("deny");
    expect(
      evaluateToolCallGovernance({
        ...call,
        toolName: "foo____delete",
        mcpTool: { serverName: "foo_", safeServerName: "foo_", toolName: "_delete" },
      }).effect,
    ).toBe("deny");
    // A different operation on the same server is still callable.
    expect(
      evaluateToolCallGovernance({
        ...call,
        toolName: "foo___search",
        mcpTool: { serverName: "foo_", safeServerName: "foo_", toolName: "search" },
      }).effect,
    ).toBe("allow");
  });

  it("falls back to the whole server for a denial Codex hashed at the tool", () => {
    // Codex hashes the TOOL part for colliding operations and again when the
    // callable name passes 64 characters (append_hash_suffix and
    // fit_callable_parts_with_hash, ../codex/codex-rs/codex-mcp/src/tools.rs).
    // Nothing can map that back to a stamped identity, so the denial is read as
    // the whole server rather than quietly running the call it names.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["github"], deniedTools: ["mcp__github__read_a1b2c3d4e5f6"] },
    });
    plan.mcpGoverned = true;
    const call = { plan, node, policies: [], mcpServers: ["github"] } as const;
    for (const tool of ["read", "search"]) {
      expect(
        evaluateToolCallGovernance({
          ...call,
          toolName: `github__${tool}`,
          mcpTool: { serverName: "github", safeServerName: "github", toolName: tool },
        }).effect,
      ).toBe("deny");
    }
  });

  it("falls back to the whole server when the tool part is only Codex's hash", () => {
    // The tightest fit leaves the hash AS the tool part and truncates the
    // namespace to 49 characters (fit_callable_parts_with_hash, tools.rs:283-287),
    // so the denial names a server prefix and nothing else.
    const server = "s".repeat(60);
    const { plan, node } = planWith({
      ontology: {
        mcpServers: [server],
        deniedTools: [`${"s".repeat(49)}___a1b2c3d4e5f6`],
      },
    });
    plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        policies: [],
        mcpServers: [server],
        toolName: `${server}__read`,
        mcpTool: { serverName: server, safeServerName: server, toolName: "read" },
      }).effect,
    ).toBe("deny");
  });

  it("reads the hook spelling Codex actually reports for a truncated name", () => {
    // The 49-character cut includes the `mcp__` prefix (tools.rs:139-146,283), so a
    // long server keeps 44 of its own characters — and join_tool_name trims the
    // leading underscore off a hash-only tool part
    // (../codex/codex-rs/core/src/tools/handlers/mcp.rs:52-62). That leaves
    // `mcp__<44>__<hash>`, which no first-`__` split would read as this server.
    const server = "s".repeat(60);
    const { plan, node } = planWith({
      ontology: {
        mcpServers: [server],
        deniedTools: [`mcp__${"s".repeat(44)}__a1b2c3d4e5f6`],
      },
    });
    plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        policies: [],
        mcpServers: [server],
        toolName: `${server}__read`,
        mcpTool: { serverName: server, safeServerName: server, toolName: "read" },
      }).effect,
    ).toBe("deny");
  });

  it("keeps a hashed denial inside the server it names", () => {
    // The fallback is per-server, not global: an unreadable denial for one server
    // must not take another attached server's tools with it.
    const { plan, node } = planWith({
      ontology: {
        mcpServers: ["github", "atlassian"],
        deniedTools: ["mcp__atlassian__read_a1b2c3d4e5f6"],
      },
    });
    plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        policies: [],
        mcpServers: ["github", "atlassian"],
        toolName: "github__read",
        mcpTool: { serverName: "github", safeServerName: "github", toolName: "read" },
      }).effect,
    ).toBe("allow");
  });

  it("does not require an attached server's tools in allowedTools", () => {
    // Attaching in the UI has to be sufficient: an operator cannot be expected to
    // also guess the tool names a server will expose.
    const { plan, node } = planWith({
      ontology: { allowedTools: ["message"], mcpServers: ["github"] },
    });
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "github__create_issue",
      policies: [],
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("allow");
  });

  it("reads attachments plan-wide for a runtime that never advances", () => {
    // CLI/Codex/ACP runs stay pinned at the root, so a path check would deny the
    // leaf attachment the operator wrote — while those runtimes were already
    // handed the server plan-wide.
    const root: EnterprisePlanNode = {
      nodeId: "desk",
      parentId: null,
      seq: 0,
      title: "Desk",
      ontology: {},
    };
    const leaf: EnterprisePlanNode = {
      nodeId: "desk.escalate",
      parentId: "desk",
      seq: 1,
      title: "Escalate",
      ontology: { mcpServers: ["acme-tracker"] },
    };
    const { plan } = planWith(root);
    plan.nodes = [root, leaf];
    plan.mcpGoverned = true;
    const call = {
      plan,
      node: root,
      toolName: "acme-tracker__create_issue",
      policies: [],
      mcpTool: {
        serverName: "acme-tracker",
        safeServerName: "acme-tracker",
        toolName: "create_issue",
      },
      mcpServers: ["acme-tracker"],
    } as const;

    expect(evaluateToolCallGovernance({ ...call }).effect).toBe("deny");
    expect(evaluateToolCallGovernance({ ...call, attachmentScope: "plan" }).effect).toBe("allow");
  });

  it("leaves a plugin-contributed MCP server to the tool scope", () => {
    // Only servers an operator registered are attachable, so gating a plugin's own
    // server would take a working plugin away from every governed run with no way
    // to grant it back.
    const { plan, node } = planWith({});
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "vendor-kb__search",
      policies: [],
      mcpTool: { serverName: "vendor-kb", safeServerName: "vendor-kb", toolName: "search" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("allow");
  });

  it("does not let one server's attachment cover a case variant of it", () => {
    // `mcp.servers` keys are case-sensitive, so "github" and "GitHub" are two
    // different servers and may be two different endpoints.
    const { plan, node } = planWith({ ontology: { mcpServers: ["github"] } });
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "GitHub__create_issue",
      policies: [],
      mcpTool: { serverName: "GitHub", safeServerName: "GitHub", toolName: "create_issue" },
      mcpServers: ["github", "GitHub"],
    });
    expect(decision.effect).toBe("deny");
  });

  it("treats a bare server name in deniedTools as denying the server", () => {
    // The native side withholds the whole server for this entry, and the docs say
    // so; an embedded run must not read the same entry as denying nothing.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["github"], deniedTools: ["github"] },
    });
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "github__create_issue",
      policies: [],
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("deny");
  });

  it("honors a denial written in the other MCP spelling", () => {
    // The call arrives under the embedded name; an operator may have written the
    // Claude-style one. Same operation on the same server, so it must still deny.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["github"], deniedTools: ["mcp__github__delete_repo"] },
    });
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "github__delete_repo",
      policies: [],
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "delete_repo" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("deny");
  });

  it("does not let an mcp__ denial reach a core tool", () => {
    // Aliasing is for MCP calls only: a blanket `mcp__*` denial must not swallow
    // tools that have nothing to do with MCP.
    const { plan, node } = planWith({ ontology: { deniedTools: ["mcp__*"] } });
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: [] });
    expect(decision.effect).toBe("allow");
  });

  it("leaves a core tool alone that merely reads like an MCP one", () => {
    // Names cannot classify: `memory__status` is a core tool here, and the
    // materializer would have renamed a colliding MCP tool instead. Without
    // provenance the gate must not claim it.
    const { plan, node } = planWith({});
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "memory__status",
      policies: [],
    });
    expect(decision.effect).toBe("allow");
  });

  it("gates a server whose registered name the runtime had to rewrite", () => {
    // The registration carries BOTH names, so an attachment written with the
    // config key matches even though the tool is exposed under a rewritten one.
    const { plan, node } = planWith({ ontology: { mcpServers: ["my server"] } });
    plan.mcpGoverned = true;
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        toolName: "my-server__search",
        policies: [],
        mcpTool: { serverName: "my server", safeServerName: "my-server", toolName: "search" },
        mcpServers: ["my server", "my:server"],
      }).effect,
    ).toBe("allow");
    expect(
      evaluateToolCallGovernance({
        plan,
        node,
        toolName: "my-server-2__search",
        policies: [],
        mcpTool: { serverName: "my:server", safeServerName: "my-server-2", toolName: "search" },
        mcpServers: ["my server", "my:server"],
      }).effect,
    ).toBe("deny");
  });

  it("builds deny aliases from the registration, not from the exposed name", () => {
    // Deriving the tool part by stripping the raw config key would leave the whole
    // name in place for a rewritten server, and the alias would match nothing.
    const { plan, node } = planWith({
      ontology: { mcpServers: ["my server"], deniedTools: ["mcp__my-server__search"] },
    });
    plan.mcpGoverned = true;
    const decision = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "my-server__search",
      policies: [],
      mcpTool: { serverName: "my server", safeServerName: "my-server", toolName: "search" },
      mcpServers: ["my server"],
    });
    expect(decision.effect).toBe("deny");
  });

  it("denies ontology-denied tools even when also allowed", () => {
    const { plan, node } = planWith({
      ontology: { allowedTools: ["*"], deniedTools: ["exec"] },
    });
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: [] });
    expect(decision.effect).toBe("deny");
  });

  it("applies deny policies scoped by tree/node/tool selectors", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "other.tree", effect: "deny", tools: ["exec"], trees: ["finance.*"] },
      { id: "this.tree", effect: "deny", tools: ["exec"], trees: ["acme.*"] },
    ];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("this.tree");
    expect(decision.source).toBe("policy");
  });

  it("lets deny win over allow regardless of declaration order", () => {
    const { plan, node } = planWith({});
    const allowFirst: GovernancePolicy[] = [
      { id: "allow.first", effect: "allow", tools: ["exec"] },
      { id: "deny.later", effect: "deny", tools: ["exec"] },
    ];
    const denyFirst = allowFirst.toReversed();
    for (const policies of [allowFirst, denyFirst]) {
      const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
      expect(decision.effect).toBe("deny");
      expect(decision.policyId).toBe("deny.later");
    }
  });

  it("lets allow beat audit when no deny matches", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "audit.exec", effect: "audit", tools: ["exec"] },
      { id: "allow.exec", effect: "allow", tools: ["exec"] },
    ];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("allow");
    expect(decision.policyId).toBe("allow.exec");
  });

  it("records audit policies without changing the outcome", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "audit.exec", effect: "audit", tools: ["exec"] }];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("audit");
    expect(decision.policyId).toBe("audit.exec");
  });

  it("falls back to a generated reason when a policy description is blank", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "deny.blank", effect: "deny", tools: ["exec"], description: "  " },
    ];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toBe('tool "exec" is denied by governance policy "deny.blank"');
  });

  it("ignores run-level policies (no tools selector) for tool calls", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "run.deny", effect: "deny", trees: ["acme.*"] }];
    const decision = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(decision.effect).toBe("allow");
  });

  it("ranks require_approval between deny and allow", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "allow.exec", effect: "allow", tools: ["exec"] },
      {
        id: "approve.exec",
        effect: "require_approval",
        tools: ["exec"],
        approval: { timeoutBehavior: "deny", severity: "critical" },
      },
    ];
    const approval = evaluateToolCallGovernance({ plan, node, toolName: "exec", policies });
    expect(approval.effect).toBe("require_approval");
    expect(approval.policyId).toBe("approve.exec");
    expect(approval.approval).toEqual({ timeoutBehavior: "deny", severity: "critical" });

    const withDeny = evaluateToolCallGovernance({
      plan,
      node,
      toolName: "exec",
      policies: [...policies, { id: "deny.exec", effect: "deny", tools: ["exec"] }],
    });
    expect(withDeny.effect).toBe("deny");
  });

  it("matches action selectors through the active node's ontology actions", () => {
    const { plan, node } = planWith({
      ontology: {
        actions: [{ id: "refund.issue", tools: ["message"] }, { id: "notes.write" }],
      },
    });
    const policies: GovernancePolicy[] = [
      { id: "approve.refunds", effect: "require_approval", actions: ["refund.*"] },
    ];
    // message is covered by refund.issue AND by the tool-less notes.write.
    expect(evaluateToolCallGovernance({ plan, node, toolName: "message", policies }).effect).toBe(
      "require_approval",
    );
    // exec is only covered by the tool-less action, which the selector misses.
    expect(evaluateToolCallGovernance({ plan, node, toolName: "exec", policies }).effect).toBe(
      "allow",
    );
    // Nodes without a matching action are unaffected.
    const bare = planWith({});
    expect(
      evaluateToolCallGovernance({
        plan: bare.plan,
        node: bare.node,
        toolName: "message",
        policies,
      }).effect,
    ).toBe("allow");
  });

  it("treats an empty action tool list as covering nothing (no match-all widening)", () => {
    // The schema rejects empty tool lists, but a programmatic policy with one
    // must not widen an action-scoped policy across the node.
    const { plan, node } = planWith({
      ontology: { actions: [{ id: "act.empty", tools: [] }] },
    });
    const policies: GovernancePolicy[] = [{ id: "deny.act", effect: "deny", actions: ["act.*"] }];
    expect(evaluateToolCallGovernance({ plan, node, toolName: "exec", policies }).effect).toBe(
      "allow",
    );
  });
});

describe("evaluateRunStartGovernance", () => {
  it("denies runs whose tree matches a run-level deny policy", () => {
    const { plan } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "run.deny", effect: "deny", trees: ["acme.*"] }];
    const decision = evaluateRunStartGovernance({ plan, policies });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("run.deny");
  });

  it("ignores tool-scoped policies at run start and allows by default", () => {
    const { plan } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "tool.deny", effect: "deny", tools: ["exec"] }];
    const decision = evaluateRunStartGovernance({ plan, policies });
    expect(decision.effect).toBe("allow");
    expect(decision.source).toBe("default");
  });

  it("honors node selectors on run-level policies", () => {
    const { plan } = planWith({});
    const missPolicies: GovernancePolicy[] = [
      { id: "run.deny.other", effect: "deny", trees: ["acme.*"], nodes: ["other.*"] },
    ];
    expect(evaluateRunStartGovernance({ plan, policies: missPolicies }).effect).toBe("allow");

    const hitPolicies: GovernancePolicy[] = [
      { id: "run.deny.support", effect: "deny", trees: ["acme.*"], nodes: ["support"] },
    ];
    const decision = evaluateRunStartGovernance({ plan, policies: hitPolicies });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("run.deny.support");
  });

  it("returns audit decisions for run-level audit policies", () => {
    const { plan } = planWith({});
    const policies: GovernancePolicy[] = [{ id: "run.audit", effect: "audit", trees: ["acme.*"] }];
    const decision = evaluateRunStartGovernance({ plan, policies });
    expect(decision.effect).toBe("audit");
    expect(decision.policyId).toBe("run.audit");
    expect(decision.source).toBe("policy");
  });

  it("matches root-scoped run-level policies even when the run starts on a leaf", () => {
    // Multi-step plans start execution on the first leaf, but run-level policies
    // scoped to the root must still fire at run start.
    const root: EnterprisePlanNode = {
      nodeId: "refunds",
      parentId: null,
      seq: 0,
      title: "Refunds",
      ontology: {},
    };
    const leaf: EnterprisePlanNode = {
      nodeId: "refunds.verify",
      parentId: "refunds",
      seq: 1,
      title: "Verify",
      ontology: {},
    };
    const plan: EnterpriseRunPlan = {
      runId: "run-1",
      treeId: "acme.refunds",
      treeVersion: "1.0.0",
      treeName: "Refunds",
      matchedBy: "planner",
      requestSummary: "refund",
      nodes: [root, leaf],
      activeNodeId: leaf.nodeId,
      mode: "enforce",
      createdAt: 0,
    };
    const policies: GovernancePolicy[] = [
      { id: "run.deny.root", effect: "deny", trees: ["acme.*"], nodes: ["refunds"] },
    ];
    const decision = evaluateRunStartGovernance({ plan, policies });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("run.deny.root");
  });
});

describe("evaluateToolCallGovernance path scope", () => {
  function nestedPlan(): { plan: EnterpriseRunPlan; path: EnterprisePlanNode[] } {
    const root: EnterprisePlanNode = {
      nodeId: "ops",
      parentId: null,
      seq: 0,
      title: "Operate",
      ontology: {
        allowedTools: ["memory_search", "message"],
        actions: [{ id: "lookup", tools: ["memory_search"] }],
      },
    };
    const leaf: EnterprisePlanNode = {
      nodeId: "ops.step",
      parentId: "ops",
      seq: 1,
      title: "Step",
      ontology: { deniedTools: ["message"] },
    };
    const plan: EnterpriseRunPlan = {
      runId: "run-1",
      treeId: "acme.ops",
      treeVersion: "1.0.0",
      treeName: "Ops",
      matchedBy: "planner",
      requestSummary: "op",
      nodes: [root, leaf],
      activeNodeId: leaf.nodeId,
      mode: "enforce",
      createdAt: 0,
    };
    return { plan, path: [root, leaf] };
  }

  it("denies at the ancestor level when the root scope excludes the tool", () => {
    const { plan, path } = nestedPlan();
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("require_approval");
    expect(decision.source).toBe("ontology");
    expect(decision.reason).toContain('"ops"');
  });

  it("denies at the leaf level when a deeper step narrows the scope", () => {
    const { plan, path } = nestedPlan();
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "message",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain('"ops.step"');
  });

  it("allows a tool permitted by every level on the path", () => {
    const { plan, path } = nestedPlan();
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "memory_search",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("allow");
  });

  it("matches action-scoped policies against ancestor actions on the path", () => {
    const { plan, path } = nestedPlan();
    const policies: GovernancePolicy[] = [
      { id: "audit.lookup", effect: "require_approval", actions: ["lookup"] },
    ];
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "memory_search",
      policies,
      path,
    });
    expect(decision.effect).toBe("require_approval");
    expect(decision.policyId).toBe("audit.lookup");
  });

  it("keeps root-scoped node policies applying after advancing into a leaf", () => {
    const { plan, path } = nestedPlan();
    // Policy pinned to the workflow root ("ops"), evaluated while the active
    // node is the leaf: it must still deny (would silently fall back to allow
    // if node matching only saw the active leaf).
    const policies: GovernancePolicy[] = [
      { id: "root.deny", effect: "deny", tools: ["memory_search"], nodes: ["ops"] },
    ];
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "memory_search",
      policies,
      path,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("root.deny");
  });

  it("still honors leaf-scoped node policies", () => {
    const { plan, path } = nestedPlan();
    const policies: GovernancePolicy[] = [
      { id: "leaf.deny", effect: "deny", tools: ["memory_search"], nodes: ["ops.step"] },
    ];
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "memory_search",
      policies,
      path,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.policyId).toBe("leaf.deny");
  });
});

describe("evaluateToolCallGovernance explicit capability grants", () => {
  /** Root grants two tools; the leaf adds none of its own. */
  function grantingPlan(rootTools?: string[]): {
    plan: EnterpriseRunPlan;
    path: EnterprisePlanNode[];
  } {
    const root: EnterprisePlanNode = {
      nodeId: "ops",
      parentId: null,
      seq: 0,
      title: "Operate",
      ontology: rootTools ? { allowedTools: rootTools } : {},
    };
    const leaf: EnterprisePlanNode = {
      nodeId: "ops.step",
      parentId: "ops",
      seq: 1,
      title: "Step",
      ontology: {},
    };
    const { plan } = planWith(root);
    plan.nodes = [root, leaf];
    plan.activeNodeId = leaf.nodeId;
    plan.capabilityGrants = "explicit";
    plan.mcpGoverned = true;
    return { plan, path: [root, leaf] };
  }

  it("allows a tool an ancestor grants", () => {
    const { plan, path } = grantingPlan(["memory_search", "message"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "memory_search",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("allow");
  });

  it("never withholds the run's own step-advance tool", () => {
    // complete_step is how the run walks its route, not a capability the work-map
    // hands out. If explicit grants could withhold it, an operator who granted
    // anything else would strand the run on step 1 — with every later step's
    // grants unreachable for the rest of the run. Denials are exempt too: a
    // work-map that wants no steps declares a single leaf instead.
    const { plan, path } = grantingPlan(["memory_search"]);
    path[0].ontology = { allowedTools: ["memory_search"], deniedTools: ["complete_step"] };
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "complete_step",
      policies: [],
      path,
      tracksSteps: true,
    });
    expect(decision.effect).toBe("allow");
  });

  it("governs the reopen tool even though it shares the workflow control surface", () => {
    // Going BACK is not the same claim as advancing. A work-map that narrows tools
    // step by step is relying on that order, so walking back re-grants a scope the
    // route already left — an operator has to be able to gate it, and the ordinary
    // tool gate is what does that. Exempting it beside complete_step would make a
    // scoped work-map unable to hold its own sequence.
    const { plan, path } = grantingPlan(["memory_search"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "reopen_step",
      policies: [],
      path,
      tracksSteps: true,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("does not exempt the name on a run that walks no steps", () => {
    // The core tool is only built for a step-tracking run, so on any other run a
    // PLUGIN may legitimately own that name — and exempting it would hand a plugin
    // call a free pass through the work-map.
    const { plan, path } = grantingPlan(["memory_search"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "complete_step",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("refuses every namespaced spelling of the control tool", () => {
    // Both legitimate paths deliver the BARE name: the loopback handler gates by
    // registered name, and the Codex app-server registers this tool directly. A
    // namespaced spelling can therefore only be another server's tool that happens
    // to share the name — and a Codex-owned `openclaw` server arrives under
    // exactly this form with nothing to tell it apart, so exempting it would be a
    // free pass through every allow-list, denial and policy.
    const { plan, path } = grantingPlan(["memory_search"]);
    for (const toolName of [
      "mcp__openclaw__complete_step",
      "openclaw__complete_step",
      "mcp__vendor__complete_step",
    ]) {
      const decision = evaluateToolCallGovernance({
        plan,
        node: path[1],
        toolName,
        policies: [],
        path,
        tracksSteps: true,
      });
      expect(decision.effect, toolName).toBe("require_approval");
    }
  });

  it("does not exempt a bare name that arrives with an MCP registration", () => {
    // Our in-process tool carries no MCP registration; anything that does is a
    // server's tool that merely shares the name.
    const { plan, path } = grantingPlan(["memory_search"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "complete_step",
      policies: [],
      path,
      mcpTool: { serverName: "vendor", safeServerName: "vendor", toolName: "complete_step" },
      tracksSteps: true,
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("keeps advancing possible when a policy would otherwise deny every tool", () => {
    // A catch-all deny policy reaching the control call would strand the run on
    // step 1 — including the very policy that made the run step-tracking.
    const { plan, path } = grantingPlan(["memory_search"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "complete_step",
      policies: [{ id: "deny.all", effect: "deny", tools: ["*"] }],
      path,
      tracksSteps: true,
    });
    expect(decision.effect).toBe("allow");
  });

  it("denies a tool no step on the path names, pointing at the active step", () => {
    // A path that only DENIES has narrowed nothing in, so this is the ungranted
    // case rather than a scope violation — and the denial names the step an
    // operator would attach the tool to.
    const { plan, path } = grantingPlan();
    path[0].ontology = { deniedTools: ["write"] };
    // Deliberately NOT a core-floor tool: the floor answers first, so proving the
    // ungranted path needs a capability the floor does not cover.
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("require_approval");
    expect(decision.source).toBe("ontology");
    expect(decision.reason).toContain('"ops.step"');
    expect(decision.reason).toContain("ontology.allowedTools");
  });

  it("still reports a scope violation when a step's own list excludes the tool", () => {
    const { plan, path } = grantingPlan(["memory_search"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("require_approval");
    // The step that narrowed it away, not the active one: that is where the list
    // an operator has to widen lives.
    expect(decision.reason).toContain('"ops"');
    expect(decision.reason).toContain("outside the ontology tool scope");
  });

  it("asks about every non-floor tool when no step on the path grants anything", () => {
    const { plan, path } = grantingPlan();
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("require_approval");
    expect(decision.reason).toContain("grants capabilities explicitly");
  });

  it("lets a descendant's denial beat an ancestor's omission", () => {
    // The root's allow-list omits `exec` (an omission, normally approvable) while
    // the ACTIVE leaf denies it outright. Returning on the first allow-list miss
    // would never reach the leaf, and the caller would offer Allow-once for a call
    // the active step explicitly refused.
    const { plan, path } = grantingPlan(["message"]);
    path[1].ontology = { deniedTools: ["exec"] };
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("ontology.deniedTools");
  });

  it("lets a deny policy beat an approvable omission", () => {
    // Precedence is deny > require_approval. A hard deny an operator configured
    // must not become a prompt a human can wave through just because the step's
    // scope happened to omit the tool too.
    const { plan, path } = grantingPlan(["message"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [{ id: "deny.exec", effect: "deny", tools: ["exec"] }],
      path,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.source).toBe("policy");
  });

  it("prefers a policy's own approval settings over the ontology's", () => {
    // Both ask for approval; the operator's carries their severity and timeout.
    const { plan, path } = grantingPlan(["message"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [{ id: "ask.exec", effect: "require_approval", tools: ["exec"] }],
      path,
    });
    expect(decision.effect).toBe("require_approval");
    expect(decision.source).toBe("policy");
  });

  it("never lets a policy relax an omission to allow-on-timeout", () => {
    // A call the step's scope never covered is fail-closed by contract. A policy
    // that would let an UNANSWERED prompt through would execute it with no human
    // having seen it, which is exactly the guarantee the approval path exists to
    // make. Strictest wins: keep the operator's prompt, drop their allow.
    const { plan, path } = grantingPlan(["message"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [
        {
          id: "ask.exec",
          effect: "require_approval",
          tools: ["exec"],
          approval: { timeoutBehavior: "allow", severity: "info" },
        },
      ],
      path,
    });
    expect(decision.effect).toBe("require_approval");
    expect(decision.approval?.timeoutBehavior).toBe("deny");
    // The operator's own severity survives; only the unsafe half is overridden.
    expect(decision.approval?.severity).toBe("info");
    // And the OMISSION fact survives the policy decision. Without it a caller that
    // must fail closed (a synchronous native hook) would read `source: "policy"`
    // and wait on a prompt nobody can answer in time.
    expect(decision.ontologyOmission).toBe(true);
  });

  it("keeps a policy's allow-on-timeout when the step's scope covers the tool", () => {
    // Nothing to fail closed about here: the step grants the tool, and the policy
    // is the only reason a human is asked at all.
    const { plan, path } = grantingPlan(["exec"]);
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "exec",
      policies: [
        {
          id: "ask.exec",
          effect: "require_approval",
          tools: ["exec"],
          approval: { timeoutBehavior: "allow" },
        },
      ],
      path,
    });
    expect(decision.effect).toBe("require_approval");
    expect(decision.approval?.timeoutBehavior).toBe("allow");
    // Nothing was omitted here, so this is purely the operator's own prompt.
    expect(decision.ontologyOmission).toBeUndefined();
  });

  it("keeps the reply-and-read floor available under explicit grants", () => {
    // Deny-by-default is about the ENTERPRISE capabilities an operator assigns,
    // not about whether the agent can answer or look at anything. Without this a
    // step granted one knowledge source could read the handbook and then be unable
    // to reply — a restriction nobody chose, just what silence happened to mean.
    const { plan, path } = grantingPlan(["knowledge_search"]);
    for (const toolName of ["message", "read", "memory_search"]) {
      const decision = evaluateToolCallGovernance({
        plan,
        node: path[1],
        toolName,
        policies: [],
        path,
      });
      expect(decision.effect, toolName).toBe("allow");
    }
    // Execution and writes are NOT on the floor: those are exactly what an
    // explicit work-map exists to control. `session_status` is off it too — it
    // reads state but also UPDATES model overrides and visibility, so it is a
    // capability rather than a courtesy.
    for (const toolName of ["exec", "write", "edit", "session_status"]) {
      expect(
        evaluateToolCallGovernance({ plan, node: path[1], toolName, policies: [], path }).effect,
        toolName,
      ).not.toBe("allow");
    }
  });

  it("lets an operator take a floor tool back with deniedTools", () => {
    // The floor stops silence from removing the basics; it does not overrule a
    // decision an operator wrote by hand.
    const { plan, path } = grantingPlan(["knowledge_search"]);
    path[1].ontology = { deniedTools: ["message"] };
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "message",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("ontology.deniedTools");
  });

  it("leaves a work-map without the switch allowing an unscoped path", () => {
    const { plan, path } = grantingPlan();
    delete plan.capabilityGrants;
    delete plan.mcpGoverned;
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "message",
      policies: [],
      path,
    });
    expect(decision.effect).toBe("allow");
  });

  it("keeps a step's own denial winning over an ancestor's grant", () => {
    const { plan, path } = grantingPlan(["memory_search", "message"]);
    path[1].ontology = { deniedTools: ["message"] };
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "message",
      policies: [],
      path,
    });
    // An operator's deniedTools entry is a DECISION: still a hard block, and it
    // says so rather than reporting a scope omission.
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("ontology.deniedTools");
  });

  it("lets an MCP attachment grant its tools without allowedTools naming them", () => {
    // The attachment IS the grant, so explicit grants must not make attaching in
    // the UI insufficient — otherwise an operator would have to guess tool names.
    const { plan, path } = grantingPlan(["memory_search"]);
    path[1].ontology = { mcpServers: ["github"] };
    const decision = evaluateToolCallGovernance({
      plan,
      node: path[1],
      toolName: "github__create_issue",
      policies: [],
      path,
      mcpTool: { serverName: "github", safeServerName: "github", toolName: "create_issue" },
      mcpServers: ["github"],
    });
    expect(decision.effect).toBe("allow");
  });
});

describe("evaluateKnowledgeRetrievalGovernance", () => {
  it("denies a foundation matched by a knowledge-scoped policy", () => {
    const { plan, node } = planWith({});
    const policies: GovernancePolicy[] = [
      { id: "kb.deny", effect: "deny", knowledge: ["acme.secret-*"] },
    ];
    const denied = evaluateKnowledgeRetrievalGovernance({
      plan,
      node,
      foundationId: "acme.secret-kb",
      policies,
    });
    expect(denied.effect).toBe("deny");
    expect(denied.policyId).toBe("kb.deny");

    const allowed = evaluateKnowledgeRetrievalGovernance({
      plan,
      node,
      foundationId: "acme.public-kb",
      policies,
    });
    expect(allowed.effect).toBe("allow");
    expect(allowed.source).toBe("default");
  });

  it("ignores mixed knowledge/tool policies for both subjects", () => {
    const { plan, node } = planWith({});
    // A tool selector cannot match a retrieval and a knowledge selector cannot
    // match a tool call, so a policy carrying both gates neither.
    const mixed: GovernancePolicy[] = [
      { id: "mixed", effect: "deny", tools: ["exec"], knowledge: ["acme.kb"] },
    ];
    expect(
      evaluateKnowledgeRetrievalGovernance({ plan, node, foundationId: "acme.kb", policies: mixed })
        .effect,
    ).toBe("allow");
    expect(
      evaluateToolCallGovernance({ plan, node, toolName: "exec", policies: mixed }).effect,
    ).toBe("allow");
  });
});
