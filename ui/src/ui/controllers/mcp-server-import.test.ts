import { describe, expect, it } from "vitest";
import { parseMcpServerImport } from "./mcp-server-import.ts";

describe("parseMcpServerImport", () => {
  it("reads the mcpServers envelope vendors publish, keeping env and args", () => {
    const parsed = parseMcpServerImport(
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
          },
        },
      }),
    );

    expect(parsed).toEqual({
      kind: "ok",
      entries: [
        {
          name: "github",
          server: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
          },
          launch: "npx",
          assumedTransport: null,
        },
      ],
    });
  });

  it("reads the VS Code servers envelope and the OpenClaw mcp.servers block", () => {
    const vscode = parseMcpServerImport(
      JSON.stringify({ servers: { local: { command: "./serve" } } }),
    );
    const openclaw = parseMcpServerImport(
      JSON.stringify({ mcp: { servers: { local: { command: "./serve" } } } }),
    );

    expect(vscode.kind).toBe("ok");
    expect(openclaw.kind).toBe("ok");
  });

  it("rewrites the type alias vendors use into OpenClaw's transport field", () => {
    // `openclaw mcp add` canonicalizes the same way; leaving `type` in place
    // would store an entry only some readers resolve.
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://mcp.acme.dev" } } }),
    );

    expect(parsed).toEqual({
      kind: "ok",
      entries: [
        {
          name: "remote",
          server: { url: "https://mcp.acme.dev", transport: "streamable-http" },
          launch: "https://mcp.acme.dev",
          assumedTransport: null,
        },
      ],
    });
  });

  it("decides the transport of a URL-only entry and reports that it decided", () => {
    // An unset transport is read as SSE by the embedded runtime and as
    // streamable HTTP by Codex, so one entry would dial two different servers.
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { remote: { url: "https://mcp.acme.dev" } } }),
    );

    expect(parsed).toEqual({
      kind: "ok",
      entries: [
        {
          name: "remote",
          server: { url: "https://mcp.acme.dev", transport: "streamable-http" },
          launch: "https://mcp.acme.dev",
          assumedTransport: "streamable-http",
        },
      ],
    });
  });

  it("keeps a declared transport rather than overriding it", () => {
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { remote: { url: "https://mcp.acme.dev", transport: "sse" } } }),
    );

    expect(parsed).toEqual({
      kind: "ok",
      entries: [
        {
          name: "remote",
          server: { url: "https://mcp.acme.dev", transport: "sse" },
          launch: "https://mcp.acme.dev",
          assumedTransport: null,
        },
      ],
    });
  });

  it("treats a command-bearing entry as stdio and drops the redundant transport", () => {
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { local: { type: "stdio", command: "./serve" } } }),
    );

    expect(parsed).toEqual({
      kind: "ok",
      entries: [
        {
          name: "local",
          server: { command: "./serve" },
          launch: "./serve",
          assumedTransport: null,
        },
      ],
    });
  });

  it("registers every server in one snippet", () => {
    const parsed = parseMcpServerImport(
      JSON.stringify({
        mcpServers: { a: { command: "a" }, b: { url: "https://b.dev", transport: "sse" } },
      }),
    );

    expect(parsed.kind === "ok" && parsed.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("accepts a bare name-to-server map", () => {
    const parsed = parseMcpServerImport(JSON.stringify({ github: { command: "npx" } }));

    expect(parsed.kind === "ok" && parsed.entries[0]?.name).toBe("github");
  });

  it("reports a snippet that is not JSON, with the parser's own message", () => {
    const parsed = parseMcpServerImport("{ nope");

    expect(parsed.kind).toBe("json-invalid");
    expect(parsed.kind === "json-invalid" && parsed.detail).toBeTruthy();
  });

  it("names the entry that could never launch instead of registering the rest", () => {
    // All-or-nothing: registering the half that parsed would leave the operator
    // believing the rest is there too.
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { ok: { command: "a" }, broken: { note: "todo" } } }),
    );

    expect(parsed).toEqual({ kind: "json-entry-launchless", detail: "broken" });
  });

  it("refuses a name the config editor cannot store", () => {
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { constructor: { command: "a" } } }),
    );

    expect(parsed).toEqual({ kind: "json-name-unsupported", detail: "constructor" });
  });

  it("reports an empty paste and a snippet with no servers apart", () => {
    expect(parseMcpServerImport("   ")).toEqual({ kind: "json-empty" });
    expect(parseMcpServerImport(JSON.stringify({ mcpServers: {} }))).toEqual({
      kind: "json-no-servers",
    });
    expect(parseMcpServerImport(JSON.stringify([1, 2]))).toEqual({ kind: "json-not-servers" });
  });
});

describe("parseMcpServerImport command normalization", () => {
  it("stores the trimmed command, not the snippet's raw string", () => {
    // Validation, the preview, and `launch` all use the trimmed form, while
    // resolveStdioMcpServerLaunchConfig spawns whatever is STORED — so keeping
    // the raw string registers a server that previews as `npx` and then cannot
    // spawn.
    const result = parseMcpServerImport(
      JSON.stringify({ mcpServers: { acme: { command: "  npx  ", args: ["-y", "acme-mcp"] } } }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.entries[0]?.server.command).toBe("npx");
    expect(result.entries[0]?.launch).toBe("npx");
  });
});

describe("parseMcpServerImport stdio canonicalization for Codex", () => {
  it("stores workingDirectory as cwd, the only key Codex reads", () => {
    // The embedded resolver accepts the alias; the Codex projection copies
    // `cwd` alone and Codex's RawMcpServerConfig declares nothing else, so the
    // alias would start the process in the wrong directory there only.
    const result = parseMcpServerImport(
      JSON.stringify({
        mcpServers: { acme: { command: "npx", workingDirectory: "/srv/acme" } },
      }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.entries[0]?.server.cwd).toBe("/srv/acme");
    expect(result.entries[0]?.server.workingDirectory).toBeUndefined();
  });

  it("keeps an explicit cwd when both are present", () => {
    const result = parseMcpServerImport(
      JSON.stringify({
        mcpServers: { acme: { command: "npx", cwd: "/srv/real", workingDirectory: "/srv/alias" } },
      }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.entries[0]?.server.cwd).toBe("/srv/real");
  });

  it("stringifies scalar env values the Codex projection would drop", () => {
    const result = parseMcpServerImport(
      JSON.stringify({
        mcpServers: { acme: { command: "npx", env: { PORT: 3000, DEBUG: true, NAME: "acme" } } },
      }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.entries[0]?.server.env).toEqual({
      PORT: "3000",
      DEBUG: "true",
      NAME: "acme",
    });
  });
});

describe("parseMcpServerImport stdio fields on a URL entry", () => {
  it("drops a blank stdio-only field Codex would reject", () => {
    // `carries` reads a blank field as absent, so the conflict check passes and
    // the entry would be saved with `cwd` intact — which Codex refuses on an
    // HTTP transport (../codex/codex-rs/config/src/mcp_types.rs).
    const result = parseMcpServerImport(
      JSON.stringify({
        mcpServers: { acme: { url: "https://mcp.acme.dev", cwd: "   " } },
      }),
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.entries[0]?.server.cwd).toBeUndefined();
    expect(result.entries[0]?.server.url).toBe("https://mcp.acme.dev");
  });
});

describe("parseMcpServerImport launch validation", () => {
  it("refuses a URL the runtime could never dial", () => {
    // The config schema rejects it only at save time, long after the form closed.
    expect(
      parseMcpServerImport(JSON.stringify({ mcpServers: { bad: { url: "ftp://example.com" } } })),
    ).toEqual({ kind: "json-entry-url-invalid", detail: "bad" });
  });

  it("refuses a URL entry labelled with a transport that cannot serve one", () => {
    expect(
      parseMcpServerImport(
        JSON.stringify({ mcpServers: { bad: { url: "https://a.dev", transport: "stdio" } } }),
      ),
    ).toEqual({ kind: "json-entry-transport-invalid", detail: "bad" });
  });
});

describe("parseMcpServerImport transport conflicts", () => {
  it("refuses an entry mixing a command with URL-only fields", () => {
    // OpenClaw quietly picks one, but Codex rejects the entry outright, so it
    // would register here and fail to load on a Codex-backed run.
    expect(
      parseMcpServerImport(
        JSON.stringify({ mcpServers: { bad: { command: "./serve", url: "https://a.dev" } } }),
      ),
    ).toEqual({ kind: "json-entry-transport-conflict", detail: "bad" });
    expect(
      parseMcpServerImport(
        JSON.stringify({
          mcpServers: { bad: { command: "./serve", headers: { Authorization: "x" } } },
        }),
      ),
    ).toEqual({ kind: "json-entry-transport-conflict", detail: "bad" });
  });

  it("refuses a URL entry carrying stdio-only fields", () => {
    expect(
      parseMcpServerImport(
        JSON.stringify({ mcpServers: { bad: { url: "https://a.dev", env: { A: "1" } } } }),
      ),
    ).toEqual({ kind: "json-entry-transport-conflict", detail: "bad" });
    expect(
      parseMcpServerImport(
        JSON.stringify({ mcpServers: { bad: { url: "https://a.dev", cwd: "/tmp" } } }),
      ),
    ).toEqual({ kind: "json-entry-transport-conflict", detail: "bad" });
  });
});

describe("parseMcpServerImport names", () => {
  it("trims a padded server name the way `openclaw mcp add` does", () => {
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { "  github  ": { command: "npx" } } }),
    );

    expect(parsed.kind === "ok" && parsed.entries[0]?.name).toBe("github");
  });

  it("refuses a blank server name", () => {
    // A blank name cannot be attached to a step or reached from the CLI, both of
    // which trim and reject it.
    expect(
      parseMcpServerImport(JSON.stringify({ mcpServers: { "   ": { command: "npx" } } })),
    ).toEqual({ kind: "json-entry-name-blank", detail: "   " });
  });
});

describe("parseMcpServerImport normalization", () => {
  it("writes the transport back normalized, not just validated", () => {
    // McpServerSchema accepts the exact lowercase spellings, so "SSE" would pass
    // the check here and fail at config Save with no form left to correct it in.
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { remote: { url: "https://a.dev", transport: " SSE " } } }),
    );

    expect(parsed.kind === "ok" && parsed.entries[0]?.server.transport).toBe("sse");
  });

  it("strips every transport label from a command entry", () => {
    // OpenClaw launches the command as stdio, but the CLI projection would
    // forward `type: "http"` plus a command as an HTTP server with no URL.
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { local: { type: "http", command: "./serve" } } }),
    );

    expect(parsed.kind === "ok" && parsed.entries[0]?.server).toEqual({ command: "./serve" });
  });

  it("refuses a transport alias nothing maps", () => {
    // The CLI projection gives `type` precedence, so assuming past it would
    // forward an unsupported configuration.
    expect(
      parseMcpServerImport(
        JSON.stringify({ mcpServers: { odd: { type: "websocket", url: "https://a.dev" } } }),
      ),
    ).toEqual({ kind: "json-entry-alias-unknown", detail: "odd" });
  });

  it("refuses two keys that trim to the same server name", () => {
    expect(
      parseMcpServerImport(
        JSON.stringify({ mcpServers: { a: { command: "x" }, " a ": { command: "y" } } }),
      ),
    ).toEqual({ kind: "json-entry-name-duplicate", detail: "a" });
  });
});

describe("parseMcpServerImport hostile aliases", () => {
  it("refuses a type naming an Object prototype key", () => {
    // A plain index lookup would find an inherited function, read as a valid
    // alias, and dial a transport the snippet never declared.
    expect(
      parseMcpServerImport(
        JSON.stringify({ mcpServers: { odd: { type: "constructor", url: "https://a.dev" } } }),
      ),
    ).toEqual({ kind: "json-entry-alias-unknown", detail: "odd" });
  });
});

describe("parseMcpServerImport blank launch fields", () => {
  it("drops a blank command from a URL entry", () => {
    // Codex rejects every command-plus-URL pair, and the projection copies both.
    const parsed = parseMcpServerImport(
      JSON.stringify({
        mcpServers: { remote: { command: "", url: "https://a.dev", transport: "sse" } },
      }),
    );

    expect(parsed.kind === "ok" && parsed.entries[0]?.server).toEqual({
      url: "https://a.dev",
      transport: "sse",
    });
  });

  it("drops a blank url from a command entry", () => {
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { local: { command: "./serve", url: "" } } }),
    );

    expect(parsed.kind === "ok" && parsed.entries[0]?.server).toEqual({ command: "./serve" });
  });
});

describe("parseMcpServerImport blank type alias", () => {
  it("drops a blank type so the CLI projection keeps a transport", () => {
    // toCliBundleMcpServerConfig treats any string-valued `type` as
    // authoritative and strips `transport`, leaving CLI agents with none.
    const parsed = parseMcpServerImport(
      JSON.stringify({ mcpServers: { remote: { type: "  ", url: "https://a.dev" } } }),
    );

    expect(parsed.kind === "ok" && parsed.entries[0]?.server).toEqual({
      url: "https://a.dev",
      transport: "streamable-http",
    });
  });
});

describe("parseMcpServerImport known-field validation", () => {
  const paste = (server: Record<string, unknown>) =>
    parseMcpServerImport(JSON.stringify({ mcpServers: { acme: server } }));

  it("refuses fields the typed editor cannot repair, such as a bad enabled flag", () => {
    // Checked against the real schema, so an unlisted field is caught too: the
    // form does not render `enabled` or `auth`, so an accepted-then-unsavable
    // entry leaves the operator nowhere to fix it.
    expect(paste({ command: "npx", enabled: "false" }).kind).toBe("json-entry-field-invalid");
    expect(paste({ command: "npx", auth: "none" }).kind).toBe("json-entry-field-invalid");
  });

  it("refuses invalid or ambiguous HTTP header names", () => {
    // The config schema accepts any key, but the MCP SDK builds a `Headers` from
    // this map and throws — so Save would succeed and the server never connect.
    expect(paste({ url: "https://mcp.acme.dev", headers: { "X Tenant": "acme" } }).kind).toBe(
      "json-entry-header-invalid",
    );
    expect(
      paste({ url: "https://mcp.acme.dev", headers: { Authorization: "a", authorization: "b" } })
        .kind,
    ).toBe("json-entry-header-invalid");
  });

  it("stringifies scalar headers the Codex projection would drop", () => {
    const result = paste({ url: "https://mcp.acme.dev", headers: { "X-Tenant": 42 } });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.entries[0]?.server.headers).toEqual({ "X-Tenant": "42" });
  });

  it("refuses shapes McpServerSchema rejects, instead of staging an unsavable entry", () => {
    // These pass every launch check and then fail at config save, long after the
    // import form closed — leaving the operator nothing to correct it in.
    expect(paste({ command: "npx", args: [42] }).kind).toBe("json-entry-field-invalid");
    expect(paste({ command: "npx", env: { TOKEN: null } }).kind).toBe("json-entry-field-invalid");
    expect(paste({ command: "npx", env: [] }).kind).toBe("json-entry-field-invalid");
    // A non-string command is not a launch at all, so it is reported as the
    // launchless entry it is rather than as a bad field.
    expect(paste({ command: 7 }).kind).toBe("json-entry-launchless");
  });

  it("still accepts the shapes the schema allows", () => {
    expect(paste({ command: "npx", args: ["-y", "acme"], env: { PORT: 3000 } }).kind).toBe("ok");
  });

  it("keeps letting unknown extension keys through", () => {
    // Unknown keys are what make a pasted `toolFilter` or OAuth block survive.
    const result = paste({ command: "npx", toolFilter: { include: ["search"] } });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.entries[0]?.server.toolFilter).toEqual({ include: ["search"] });
  });
});

describe("parseMcpServerImport redaction sentinels", () => {
  it("refuses a snippet copied out of a redacted config", () => {
    // Under a NEW name there is no stored secret to match the placeholder back
    // to, so the gateway rejects it and Save fails with the form already closed.
    const result = parseMcpServerImport(
      JSON.stringify({
        mcpServers: {
          acme: {
            url: "https://mcp.acme.dev",
            headers: { Authorization: "__OPENCLAW_REDACTED__" },
          },
        },
      }),
    );

    expect(result.kind).toBe("json-entry-redacted");
  });
});
