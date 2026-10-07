import { describe, expect, it } from "vitest";
import { LightRagKnowledgeFoundation, type LightRagAdapterOptions } from "./adapter.js";

type Captured = { url: string; init: RequestInit };
type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function mockFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: FetchImpl; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
    } as Response;
  };
  return { fetchImpl, calls };
}

function buildAdapter(overrides: Partial<LightRagAdapterOptions> = {}) {
  return new LightRagKnowledgeFoundation({
    foundationId: "kb",
    serverUrl: "http://x",
    kind: "remote",
    mode: "mix",
    ...overrides,
  });
}

describe("LightRagKnowledgeFoundation", () => {
  it("posts to /query/data with mode, limit, and api key, mapping raw chunks to snippets", async () => {
    const { fetchImpl, calls } = mockFetch({
      status: "success",
      data: {
        chunks: [
          {
            reference_id: "doc-1",
            file_path: "kb/refunds.md",
            content: "Refund window is 30 days",
          },
          { reference_id: "doc-2", file_path: "kb/ship.md", content: "Free shipping over $50" },
        ],
      },
    });
    const adapter = buildAdapter({
      serverUrl: "http://localhost:9621/",
      mode: "hybrid",
      apiKey: "secret-token",
      fetchImpl,
    });

    const snippets = await adapter.retrieve({
      foundationId: "acme.kb",
      query: "refund policy",
      limit: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:9621/query/data"); // trailing slash normalized
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("secret-token");
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toMatchObject({
      query: "refund policy",
      mode: "hybrid",
      top_k: 5,
      chunk_top_k: 5,
    });
    expect(snippets).toEqual([
      {
        foundationId: "acme.kb",
        text: "Refund window is 30 days",
        title: "doc-1",
        source: "kb/refunds.md",
      },
      {
        foundationId: "acme.kb",
        text: "Free shipping over $50",
        title: "doc-2",
        source: "kb/ship.md",
      },
    ]);
  });

  it("caps flattened chunks at the limit and skips blank chunks", async () => {
    const { fetchImpl } = mockFetch({
      status: "success",
      data: { chunks: ["a", "  ", "b", "c"].map((content) => ({ reference_id: "d", content })) },
    });
    const adapter = buildAdapter({ fetchImpl });
    const snippets = await adapter.retrieve({ foundationId: "kb", query: "hello", limit: 2 });
    expect(snippets.map((snippet) => snippet.text)).toEqual(["a", "b"]);
  });

  it("skips too-short queries without calling the server", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const adapter = buildAdapter({ fetchImpl });
    expect(await adapter.retrieve({ foundationId: "kb", query: "hi", limit: 5 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("omits the api-key header when unset and throws on non-200", async () => {
    const { fetchImpl, calls } = mockFetch({}, { ok: false, status: 502 });
    const adapter = buildAdapter({ fetchImpl });
    await expect(
      adapter.retrieve({ foundationId: "kb", query: "hello", limit: 5 }),
    ).rejects.toThrow(/HTTP 502/);
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  it("forwards the abort signal to fetch", async () => {
    const { fetchImpl, calls } = mockFetch({ status: "success", data: { chunks: [] } });
    const adapter = buildAdapter({ fetchImpl });
    const controller = new AbortController();
    await adapter.retrieve({
      foundationId: "kb",
      query: "hello",
      limit: 5,
      signal: controller.signal,
    });
    expect(calls[0].init.signal).toBe(controller.signal);
  });

  it.each([
    { status: "failure", data: { chunks: [] } },
    { response: "No context", references: [] },
    { status: "success", data: {} },
  ])("does not treat retrieval failure or malformed data as no matches: %j", async (body) => {
    const { fetchImpl } = mockFetch(body);
    await expect(
      buildAdapter({ fetchImpl }).retrieve({ foundationId: "kb", query: "refund", limit: 5 }),
    ).rejects.toThrow("retrieval failed");
  });

  describe("describe", () => {
    it("reports the configured kind, id, and server url", () => {
      const adapter = buildAdapter({
        foundationId: "acme.kb",
        serverUrl: "http://localhost:9621/",
        kind: "local",
      });
      expect(adapter.describe()).toEqual({
        kind: "local",
        displayName: "acme.kb",
        detail: "http://localhost:9621",
      });
    });

    it("includes the configured description so the model can route to it", () => {
      const adapter = buildAdapter({
        foundationId: "acme.kb",
        serverUrl: "http://localhost:9621",
        kind: "local",
        description: "Support policies and macros",
      });
      expect(adapter.describe()).toEqual({
        kind: "local",
        displayName: "acme.kb",
        detail: "http://localhost:9621",
        description: "Support policies and macros",
      });
    });

    it("strips credentials embedded in the server url", () => {
      // describe() crosses the gateway into the Control UI, so a password in
      // the configured url must never reach an operator's screen.
      const adapter = buildAdapter({ serverUrl: "http://admin:hunter2@lightrag.internal:9621" });
      expect(adapter.describe().detail).toBe("http://lightrag.internal:9621");
    });

    it("drops a query string or fragment that could carry a token", () => {
      const adapter = buildAdapter({ serverUrl: "https://kb.example.com/base?apiKey=sekret#tok" });
      expect(adapter.describe().detail).toBe("https://kb.example.com/base");
    });

    it("strips userinfo from an IPv6 host", () => {
      const adapter = buildAdapter({ serverUrl: "http://admin:hunter2@[::1]:9621" });
      expect(adapter.describe().detail).toBe("http://[::1]:9621");
    });

    it("withholds a non-HTTP scheme whose shape it cannot reason about", () => {
      const adapter = buildAdapter({ serverUrl: "file:///etc/lightrag/secret-token" });
      expect(adapter.describe().detail).toBe("(unrecognized server url)");
    });

    it("withholds an unparseable server url even without an @ marker", () => {
      // Nothing in an unparseable string is provably non-secret, so none of it
      // is echoed — not just the forms that look like they carry credentials.
      const adapter = buildAdapter({ serverUrl: "kb.example.com/s3cret-path" });
      expect(adapter.describe().detail).toBe("(unrecognized server url)");
    });
  });

  describe("testConnection", () => {
    it("probes GET /health with the api key and reports success", async () => {
      const { fetchImpl, calls } = mockFetch({ status: "healthy" });
      const adapter = buildAdapter({
        serverUrl: "http://localhost:9621/",
        apiKey: "secret-token",
        fetchImpl,
      });

      expect(await adapter.testConnection()).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:9621/health");
      expect(calls[0].init.method).toBe("GET");
      expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("secret-token");
      // A timeout is always attached: an operator probe has no run-scoped
      // signal to bound it (see LIGHTRAG_CONNECTION_TIMEOUT_MS).
      expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it("reports the status code when the server answers non-2xx", async () => {
      const { fetchImpl } = mockFetch({}, { ok: false, status: 503 });
      const adapter = buildAdapter({ fetchImpl });
      expect(await adapter.testConnection()).toEqual({ ok: false, detail: "HTTP 503" });
    });

    it("surfaces the network error code when the server is unreachable", async () => {
      const adapter = buildAdapter({
        fetchImpl: async () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNREFUSED" },
          });
        },
      });
      expect(await adapter.testConnection()).toEqual({ ok: false, detail: "ECONNREFUSED" });
    });

    it("falls back to a generic reason when the failure carries no code", async () => {
      const adapter = buildAdapter({
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      });
      expect(await adapter.testConnection()).toEqual({ ok: false, detail: "unreachable" });
    });
  });
});

describe("LightRagKnowledgeFoundation documents", () => {
  it("reads every paginated document page and preserves processing/error details", async () => {
    const calls: Captured[] = [];
    const pages = [
      {
        documents: [
          {
            id: "one",
            status: "processed",
            file_path: "handbook.pdf",
            content_summary: "Company handbook",
            content_length: 5000,
            chunks_count: 12,
          },
          {
            id: "two",
            status: "parsing",
            file_path: "ship.md",
            chunks_count: null,
            error_msg: null,
            content_summary: "",
          },
        ],
        pagination: { page: 1, has_next: true },
      },
      {
        documents: [
          { id: "three", status: "failed", file_path: "broken.txt", error_msg: "indexing failed" },
        ],
        pagination: { page: 2, has_next: false },
      },
    ];
    const adapter = buildAdapter({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(pages[calls.length - 1]));
      },
    });
    const documents = await adapter.listDocuments();
    expect(calls.map((c) => c.url)).toEqual([
      "http://x/documents/paginated",
      "http://x/documents/paginated",
    ]);
    expect(calls.map((c) => JSON.parse(c.init.body as string).page)).toEqual([1, 2]);
    expect(calls[0].init.method).toBe("POST");
    expect(documents.map((d) => d.name)).toEqual(["broken.txt", "handbook.pdf", "ship.md"]);
    expect(documents[0]).toMatchObject({ status: "failed", error: "indexing failed" });
    expect(documents[1]).toMatchObject({ status: "indexed", chunkCount: 12, contentLength: 5000 });
    expect(documents[2]).toEqual({ id: "two", name: "ship.md", status: "processing" });
  });

  it("keeps unknown pipeline states visible and omits rows without a document id", async () => {
    const { fetchImpl } = mockFetch({
      documents: [
        { id: "d", status: "new-state", file_path: "a.md" },
        { status: "processed", file_path: "ghost.md" },
      ],
      pagination: { page: 1, has_next: false },
    });
    expect(await buildAdapter({ fetchImpl }).listDocuments()).toEqual([
      { id: "d", name: "a.md", status: "unknown" },
    ]);
  });

  it.each([
    { documents: [], pagination: { page: 1, has_next: true } },
    { documents: [], pagination: { page: 2, has_next: false } },
    { documents: [] },
  ])("rejects non-progressing or malformed pagination: %j", async (body) => {
    const { fetchImpl } = mockFetch(body);
    await expect(buildAdapter({ fetchImpl }).listDocuments()).rejects.toThrow("invalid pagination");
  });

  it("throws on a non-200 document list so the host reports a failure", async () => {
    const { fetchImpl } = mockFetch({}, { ok: false, status: 500 });
    const adapter = buildAdapter({ fetchImpl });
    await expect(adapter.listDocuments()).rejects.toThrow(/HTTP 500/);
  });

  it("uploads multipart to /documents/upload and returns the tracking id", async () => {
    const { fetchImpl, calls } = mockFetch({ status: "success", track_id: "upload-123" });
    const adapter = buildAdapter({ serverUrl: "http://localhost:9621", apiKey: "k", fetchImpl });

    const outcome = await adapter.uploadDocument({
      name: "notes.md",
      content: new TextEncoder().encode("hello"),
    });

    expect(calls[0].url).toBe("http://localhost:9621/documents/upload");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("k");
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // LightRAG's route declares `file: UploadFile = File(...)`.
    expect((form.get("file") as File).name).toBe("notes.md");
    expect(outcome).toEqual({ outcome: "accepted", trackingId: "upload-123" });
  });

  it("reports a same-name upload as a duplicate, not a generic failure", async () => {
    // LightRAG keys documents by filename and answers 409; the operator has to
    // delete the existing one, so this must not read as a server fault.
    const { fetchImpl } = mockFetch(
      { detail: "Document storage already contains notes.md" },
      { ok: false, status: 409 },
    );
    const adapter = buildAdapter({ fetchImpl });
    expect(
      await adapter.uploadDocument({ name: "notes.md", content: new Uint8Array([1]) }),
    ).toEqual({
      outcome: "duplicate",
      detail: "Document storage already contains notes.md",
    });
  });

  it("reports an oversized upload distinctly from other rejections", async () => {
    const { fetchImpl } = mockFetch({ detail: "too big" }, { ok: false, status: 413 });
    const adapter = buildAdapter({ fetchImpl });
    expect(await adapter.uploadDocument({ name: "big.bin", content: new Uint8Array([1]) })).toEqual(
      { outcome: "too-large", detail: "too big" },
    );
  });

  it("falls back to the status code when a rejection body is not JSON", async () => {
    const calls: Captured[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return {
        ok: false,
        status: 409,
        json: async () => {
          throw new SyntaxError("not json");
        },
      } as unknown as Response;
    };
    const adapter = buildAdapter({ fetchImpl });
    expect(
      await adapter.uploadDocument({ name: "notes.md", content: new Uint8Array([1]) }),
    ).toEqual({ outcome: "duplicate", detail: "HTTP 409" });
  });

  it("treats a failure status in a 200 upload body as a rejection", async () => {
    const { fetchImpl } = mockFetch({ status: "failure", message: "unsupported type" });
    const adapter = buildAdapter({ fetchImpl });
    expect(await adapter.uploadDocument({ name: "x.zip", content: new Uint8Array([1]) })).toEqual({
      outcome: "rejected",
      detail: "unsupported type",
    });
  });

  it("deletes by id and reports that removal only started", async () => {
    const { fetchImpl, calls } = mockFetch({ status: "deletion_started", doc_id: "doc-1" });
    const adapter = buildAdapter({ serverUrl: "http://localhost:9621", fetchImpl });

    const outcome = await adapter.removeDocument("doc-1");

    // The route is /documents/delete_document with a JSON body, NOT
    // DELETE /documents/{id} (which does not exist despite an upstream docstring).
    expect(calls[0].url).toBe("http://localhost:9621/documents/delete_document");
    expect(calls[0].init.method).toBe("DELETE");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ doc_ids: ["doc-1"] });
    // Deletion runs in the background: "started" is not "removed".
    expect(outcome).toEqual({ outcome: "started" });
  });

  it("surfaces a busy pipeline instead of claiming the delete succeeded", async () => {
    const { fetchImpl } = mockFetch({ status: "busy", message: "pipeline busy" });
    const adapter = buildAdapter({ fetchImpl });
    expect(await adapter.removeDocument("doc-1")).toEqual({
      outcome: "busy",
      detail: "pipeline busy",
    });
  });

  it("treats an unexpected delete status as a refusal", async () => {
    const { fetchImpl } = mockFetch({ status: "not_allowed", message: "nope" });
    const adapter = buildAdapter({ fetchImpl });
    expect(await adapter.removeDocument("doc-1")).toEqual({ outcome: "refused", detail: "nope" });
  });

  it("reports a non-200 delete as refused", async () => {
    const { fetchImpl } = mockFetch({}, { ok: false, status: 500 });
    const adapter = buildAdapter({ fetchImpl });
    expect(await adapter.removeDocument("doc-1")).toEqual({
      outcome: "refused",
      detail: "HTTP 500",
    });
  });
});
