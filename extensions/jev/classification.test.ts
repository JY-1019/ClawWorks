import { beforeEach, describe, expect, it, vi } from "vitest";
const { fetchGuard, release } = vi.hoisted(() => ({
  fetchGuard: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: fetchGuard }));
import { classify } from "./classification.js";

const request = {
  modelId: "jev-latest",
  apiKey: "test-token",
  state: "Refund order 1043",
  questions: {
    tree: {
      type: "choice" as const,
      instructions: "Choose a domain",
      choices: { support: "Returns", sales: "Quotes" },
    },
    refund: { type: "binary" as const, instructions: "Does this request a refund?" },
  },
  signal: new AbortController().signal,
};
const body = {
  model: "jev-1.13.0",
  usage: { input_tokens: 30, output_tokens: 5 },
  answers: {
    tree: {
      type: "choice",
      choice: "support",
      probabilities: { support: 0.98, sales: 0.02 },
      confidence: 0.9,
    },
    refund: { type: "noul", noul: 0.95 },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  fetchGuard.mockResolvedValue({ response: new Response(JSON.stringify(body)), release });
});
describe("Jev structured API adapter", () => {
  it("uses native questions and validates answers without a chat-completions request", async () => {
    expect(await classify(request)).toEqual({
      tree: { type: "choice", choice: "support" },
      refund: { type: "binary", probability: 0.95 },
    });
    const sent = fetchGuard.mock.calls[0][0];
    expect(sent.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent.signal).toBe(request.signal);
    expect(JSON.parse(sent.init.body)).toMatchObject({
      model: "jev-latest",
      state: request.state,
      questions: {
        tree: { type: "choice", criteria: request.questions.tree.choices },
        refund: { type: "noul" },
      },
    });
    expect(release).toHaveBeenCalledOnce();
  });
  it.each([
    { ...body, answers: { ...body.answers, refund: { type: "noul", noul: 1.1 } } },
    { ...body, answers: { ...body.answers, tree: { ...body.answers.tree, choice: "unknown" } } },
    { ...body, answers: { tree: body.answers.tree } },
  ])("rejects malformed, unknown and missing answers", async (invalid) => {
    fetchGuard.mockResolvedValue({ response: new Response(JSON.stringify(invalid)), release });
    await expect(classify(request)).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });
  it("does not send an aborted request or leak an HTTP error body", async () => {
    const signal = AbortSignal.abort();
    await expect(classify({ ...request, signal })).rejects.toThrow();
    expect(fetchGuard).not.toHaveBeenCalled();
    fetchGuard.mockResolvedValue({
      response: new Response("secret-provider-body", { status: 401 }),
      release,
    });
    await expect(classify(request)).rejects.toMatchObject({
      message: "Jev classification failed (HTTP 401).",
      status: 401,
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
