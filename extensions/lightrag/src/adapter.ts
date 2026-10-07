// LightRAG knowledge foundation adapter: retrieves context chunks from a
// LightRAG API server (`POST /query/data`) and maps them onto ClawWorks knowledge
// snippets. The server, api key, and query mode come from plugin config.
import type {
  KnowledgeDocumentRemovalOutcome,
  KnowledgeDocumentStatus,
  KnowledgeDocumentUploadOutcome,
  KnowledgeFoundationAdapter,
  KnowledgeFoundationConnectionResult,
  KnowledgeFoundationDescriptor,
  KnowledgeFoundationDocument,
  KnowledgeFoundationKind,
  KnowledgeSnippet,
} from "openclaw/plugin-sdk/enterprise-knowledge-host";

/** LightRAG server retrieval modes (see LightRAG /query `mode`). */
export type LightRagQueryMode = "local" | "global" | "hybrid" | "naive" | "mix" | "bypass";

// LightRAG rejects queries shorter than 3 chars with HTTP 400; skip those.
const LIGHTRAG_MIN_QUERY_CHARS = 3;

// The connection probe runs on an operator click, not an agent run, so no
// run-scoped signal bounds it; without an own timeout a hung server would hold
// the gateway request open until the socket died.
const LIGHTRAG_CONNECTION_TIMEOUT_MS = 5_000;

// Document calls move file bytes and can queue behind an ingest pipeline, so
// they get a longer bound than the liveness probe.
const LIGHTRAG_DOCUMENT_TIMEOUT_MS = 60_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type LightRagAdapterOptions = {
  /** Configured foundation id; the operator-facing display name. */
  foundationId: string;
  serverUrl: string;
  /** Who administers this server's content (operator-declared, see config). */
  kind: KnowledgeFoundationKind;
  mode: LightRagQueryMode;
  /** Operator-supplied one-line summary of what this foundation covers. */
  description?: string;
  apiKey?: string;
  /** Override the default global fetch (tests). */
  fetchImpl?: FetchLike;
};

// Shown instead of a server url whose secret-bearing parts cannot be identified.
const UNRECOGNIZED_SERVER_URL = "(unrecognized server url)";

/**
 * `serverUrl` reduced to a locator safe to display. `describe()` crosses the
 * gateway into the Control UI, so this allow-lists the two components that
 * cannot carry a secret (origin and path) rather than trying to strip the ones
 * that can — userinfo, query, and fragment are all used by token-in-URL
 * deployments. Anything unparseable or non-HTTP is withheld outright: its parts
 * cannot be identified, so no substring of it is provably safe to echo.
 */
function stripUrlCredentials(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return UNRECOGNIZED_SERVER_URL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return UNRECOGNIZED_SERVER_URL;
  }
  // `origin` excludes userinfo by construction, so no manual clearing is needed.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Node wraps network faults as `TypeError: fetch failed` with a coded cause. */
function connectionFailureDetail(err: unknown): string {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : "unreachable";
}

/**
 * LightRAG's DocStatus pipeline (see its `base.py`):
 * PENDING -> PARSING -> ANALYZING -> PROCESSING -> PROCESSED | FAILED, plus the
 * deprecated PREPROCESSED. Everything between pending and terminal collapses to
 * "processing": the inspector shows progress, not pipeline internals.
 */
const DOCUMENT_STATUS_BY_LIGHTRAG_STATE: Record<string, KnowledgeDocumentStatus> = {
  pending: "pending",
  parsing: "processing",
  analyzing: "processing",
  processing: "processing",
  preprocessed: "processing",
  processed: "indexed",
  failed: "failed",
};

/**
 * One document from LightRAG `POST /documents/paginated`.
 * The nullables are not defensive typing: a freshly uploaded document really is
 * served as `{"chunks_count": null, "error_msg": null, "content_summary": ""}`
 * until indexing fills them in.
 */
type LightRagDocument = {
  id?: string;
  status: string;
  file_path?: string;
  content_summary?: string | null;
  content_length?: number | null;
  chunks_count?: number | null;
  error_msg?: string | null;
  updated_at?: string | null;
};

type LightRagDocumentsResponse = {
  documents: LightRagDocument[];
  pagination: { page: number; has_next: boolean };
};

type LightRagUploadResponse = { status?: string; message?: string; track_id?: string };
type LightRagDeleteResponse = { status?: string; message?: string };

/** Structured retrieval keeps backend failure distinct from an empty successful result. */
type LightRagQueryResponse = {
  status: string;
  data?: { chunks?: Array<{ content: string; reference_id?: string; file_path?: string }> };
};

export class LightRagKnowledgeFoundation implements KnowledgeFoundationAdapter {
  private readonly baseUrl: string;

  constructor(private readonly options: LightRagAdapterOptions) {
    this.baseUrl = options.serverUrl.replace(/\/+$/, "");
  }

  /** Request headers with the API key attached when one is configured. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...extra,
      ...(this.options.apiKey ? { "X-API-Key": this.options.apiKey } : {}),
    };
  }

  /**
   * One authenticated call against a document route. These run on operator
   * actions rather than agent runs, so each carries its own timeout for the
   * same reason `testConnection` does.
   */
  private request(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(init.headers),
      signal: AbortSignal.timeout(LIGHTRAG_DOCUMENT_TIMEOUT_MS),
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  }

  describe(): KnowledgeFoundationDescriptor {
    return {
      kind: this.options.kind,
      displayName: this.options.foundationId,
      detail: stripUrlCredentials(this.options.serverUrl),
      ...(this.options.description !== undefined ? { description: this.options.description } : {}),
    };
  }

  /**
   * Probe `GET /health`, LightRAG's liveness endpoint (answers 200 even to
   * unauthenticated callers). `/query` would also prove reachability but costs
   * an LLM call on every operator click.
   */
  async testConnection(): Promise<KnowledgeFoundationConnectionResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(LIGHTRAG_CONNECTION_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${this.baseUrl}/health`, {
        method: "GET",
        headers: this.headers(),
        signal: timeout,
      });
      return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` };
    } catch (err) {
      if (timeout.aborted) {
        return { ok: false, detail: `timed out after ${LIGHTRAG_CONNECTION_TIMEOUT_MS}ms` };
      }
      return { ok: false, detail: connectionFailureDetail(err) };
    }
  }

  /** Read all pages: a first-page-only list hides older failed or indexed uploads. */
  async listDocuments(): Promise<KnowledgeFoundationDocument[]> {
    const documents: KnowledgeFoundationDocument[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request("POST", "/documents/paginated", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page, page_size: 200, sort_field: "id", sort_direction: "asc" }),
      });
      if (!response.ok) {
        throw new Error(`LightRAG document list failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as LightRagDocumentsResponse;
      if (
        !Array.isArray(body.documents) ||
        body.pagination?.page !== page ||
        typeof body.pagination?.has_next !== "boolean" ||
        (body.pagination.has_next && body.documents.length === 0)
      ) {
        throw new Error("LightRAG document list returned invalid pagination");
      }
      for (const entry of body.documents) {
        if (entry.id) {
          documents.push(mapDocument(entry, entry.status));
        }
      }
      if (!body.pagination.has_next) {
        break;
      }
    }
    return documents.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async uploadDocument(file: {
    name: string;
    content: Uint8Array;
  }): Promise<KnowledgeDocumentUploadOutcome> {
    const form = new FormData();
    // Field name must be "file": LightRAG's upload route declares
    // `file: UploadFile = File(...)`.
    form.append("file", new Blob([file.content as BlobPart]), file.name);
    const response = await this.request("POST", "/documents/upload", { body: form });
    if (response.status === 409) {
      // LightRAG treats the filename as the document key and rejects same-name
      // uploads outright; it is no longer a soft 200 "duplicated".
      return { outcome: "duplicate", detail: await responseDetail(response) };
    }
    if (response.status === 413) {
      return { outcome: "too-large", detail: await responseDetail(response) };
    }
    if (!response.ok) {
      return { outcome: "rejected", detail: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as LightRagUploadResponse;
    if (body.status === "failure") {
      return { outcome: "rejected", ...(body.message ? { detail: body.message } : {}) };
    }
    return { outcome: "accepted", ...(body.track_id ? { trackingId: body.track_id } : {}) };
  }

  /**
   * Deletion is a background job on LightRAG's side, so a 200 means "accepted",
   * never "gone" — and it refuses with `status: "busy"` while the ingest
   * pipeline holds the destructive slot.
   */
  async removeDocument(documentId: string): Promise<KnowledgeDocumentRemovalOutcome> {
    const response = await this.request("DELETE", "/documents/delete_document", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc_ids: [documentId] }),
    });
    if (!response.ok) {
      return { outcome: "refused", detail: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as LightRagDeleteResponse;
    if (body.status === "busy") {
      return { outcome: "busy", ...(body.message ? { detail: body.message } : {}) };
    }
    if (body.status !== "deletion_started") {
      return { outcome: "refused", ...(body.message ? { detail: body.message } : {}) };
    }
    return { outcome: "started" };
  }

  async retrieve(params: {
    foundationId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<KnowledgeSnippet[]> {
    if (params.query.trim().length < LIGHTRAG_MIN_QUERY_CHARS) {
      return [];
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers = this.headers({ "content-type": "application/json" });
    const response = await fetchImpl(`${this.baseUrl}/query/data`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: params.query,
        mode: this.options.mode,
        top_k: params.limit,
        chunk_top_k: params.limit,
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `LightRAG query failed for foundation "${params.foundationId}": HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as LightRagQueryResponse;
    // /query synthesizes prose and can mask a failed retrieval as an empty answer.
    // /query/data exposes retrieval status and raw chunks, without answer generation.
    if (body.status !== "success" || !Array.isArray(body.data?.chunks)) {
      throw new Error(`LightRAG retrieval failed for foundation "${params.foundationId}"`);
    }
    return body.data.chunks
      .filter((chunk) => typeof chunk.content === "string" && chunk.content.trim())
      .slice(0, params.limit)
      .map((chunk) =>
        Object.assign(
          {
            foundationId: params.foundationId,
            text: chunk.content.trim(),
          },
          chunk.reference_id ? { title: chunk.reference_id } : {},
          chunk.file_path ? { source: chunk.file_path } : {},
        ),
      );
  }
}

function mapDocument(entry: LightRagDocument, state: string): KnowledgeFoundationDocument {
  const document: KnowledgeFoundationDocument = {
    id: entry.id as string,
    // file_path is the name LightRAG keys uploads by; fall back to the id so a
    // row is still identifiable rather than blank.
    name: entry.file_path ?? (entry.id as string),
    status: DOCUMENT_STATUS_BY_LIGHTRAG_STATE[state.toLowerCase()] ?? "unknown",
  };
  // Compare against null, not undefined: a document still being indexed comes
  // back with explicit `"chunks_count": null` / `"error_msg": null`, and
  // carrying those through would put a literal "null" on the operator's screen
  // and break the optional-number contract these fields declare.
  if (entry.content_summary) {
    document.summary = entry.content_summary;
  }
  if (entry.content_length != null) {
    document.contentLength = entry.content_length;
  }
  if (entry.chunks_count != null) {
    document.chunkCount = entry.chunks_count;
  }
  if (entry.error_msg != null) {
    document.error = entry.error_msg;
  }
  if (entry.updated_at != null) {
    document.updatedAt = entry.updated_at;
  }
  return document;
}

/**
 * The server's own explanation for a rejected upload (duplicate name, size
 * cap). FastAPI puts it in `detail`; fall back to the status code when the body
 * is not the shape we expect.
 */
async function responseDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) {
      return body.detail;
    }
  } catch {
    // Non-JSON error body (proxy page): the status code is all we can report.
  }
  return `HTTP ${response.status}`;
}

/** Flatten LightRAG references into snippets, capped at the requested limit. */
