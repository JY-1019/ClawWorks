import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseKnowledgeFoundations,
  registerEnterpriseKnowledgeFoundation,
} from "../../enterprise/knowledge.js";
import { enterpriseHandlers } from "./enterprise.js";

async function invoke(method: string, params: Record<string, unknown>) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  await enterpriseHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
    context: {} as never,
  });
  expect(calls).toHaveLength(1);
  return calls[0];
}

function registerLocalUpload(onUpload: (file: { name: string }) => void) {
  registerEnterpriseKnowledgeFoundation("local.kb", {
    retrieve: async () => [],
    describe: () => ({ kind: "local", displayName: "Local KB" }),
    uploadDocument: async (file: { name: string; content: Uint8Array }) => {
      onUpload(file);
      return { outcome: "accepted" };
    },
  } as never);
}

const VALID_CONTENT = Buffer.from("x").toString("base64");

afterEach(() => {
  clearEnterpriseKnowledgeFoundations();
});

describe("enterprise.knowledge.documents.upload input validation", () => {
  it("accepts ordinary names with spaces, hyphens, dots, parentheses and non-ASCII", async () => {
    // Guards the rejections below from over-correcting into "nothing uploads".
    const seen: string[] = [];
    registerLocalUpload((file) => seen.push(file.name));

    for (const name of ["my report-v2.final.pdf", "설계 문서.md", "a_b (1).txt"]) {
      const { ok, payload } = await invoke("enterprise.knowledge.documents.upload", {
        foundationId: "local.kb",
        name,
        contentBase64: VALID_CONTENT,
      });
      expect(ok).toBe(true);
      expect((payload as { status: string }).status).toBe("accepted");
    }
    expect(seen).toHaveLength(3);
  });

  it("rejects path separators and traversal before any adapter sees the name", async () => {
    let reached = false;
    registerLocalUpload(() => {
      reached = true;
    });

    for (const name of ["../../etc/passwd", "sub/dir.txt", "back\\slash.txt", "..", "."]) {
      const { ok, error } = await invoke("enterprise.knowledge.documents.upload", {
        foundationId: "local.kb",
        name,
        contentBase64: VALID_CONTENT,
      });
      expect(ok).toBe(false);
      expect(String((error as { message?: string }).message)).toMatch(/name must be a plain file/);
    }
    // The store never gets the chance to sanitize on our behalf; a future
    // adapter without upstream sanitization is protected by this boundary.
    expect(reached).toBe(false);
  });

  it("rejects control characters and over-long names", async () => {
    const cases = [
      "evil\u0001name.txt", // C0 control
      "nul\u0000.txt", // NUL
      "del\u007f.txt", // DEL
      `${"a".repeat(201)}.txt`, // beyond DOCUMENT_NAME_MAX_LENGTH
    ];
    for (const name of cases) {
      const { ok } = await invoke("enterprise.knowledge.documents.upload", {
        foundationId: "local.kb",
        name,
        contentBase64: VALID_CONTENT,
      });
      expect(ok).toBe(false);
    }
  });

  it("rejects malformed base64 instead of silently storing truncated bytes", async () => {
    let reached = false;
    registerLocalUpload(() => {
      reached = true;
    });

    // Buffer.from ignores characters outside the alphabet, so "Zm9v!!!!" would
    // decode to "foo" and "!!!!" to an empty file.
    for (const contentBase64 of ["Zm9v!!!!", "!!!!", "not base64 at all"]) {
      const { ok, error } = await invoke("enterprise.knowledge.documents.upload", {
        foundationId: "local.kb",
        name: "notes.md",
        contentBase64,
      });
      expect(ok).toBe(false);
      expect(String((error as { message?: string }).message)).toMatch(/not valid base64/);
    }
    expect(reached).toBe(false);
  });
});

describe("document adapter fault containment", () => {
  it("sanitizes a synchronously thrown adapter error, not just a rejected promise", async () => {
    // A sync throw used to escape the host's try block entirely, handing the
    // gateway a raw error that can carry urls and credentials.
    registerEnterpriseKnowledgeFoundation("local.kb", {
      retrieve: async () => [],
      describe: () => ({ kind: "local", displayName: "Local KB" }),
      listDocuments: () => {
        throw new Error("http://admin:hunter2@kb:9621 exploded");
      },
    } as never);

    const { ok, payload } = await invoke("enterprise.knowledge.documents.list", {
      foundationId: "local.kb",
    });

    expect(ok).toBe(true);
    expect(payload).toEqual({ status: "failed", documents: [], detail: "document list failed" });
    expect(JSON.stringify(payload)).not.toContain("hunter2");
  });
});
