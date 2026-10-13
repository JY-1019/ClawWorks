import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "openclaw/plugin-sdk/zod";

type Classify = NonNullable<ProviderPlugin["classify"]>;
const probability = z.number().min(0).max(1);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        probabilities: z.record(z.string(), probability),
        confidence: probability,
      }),
      z.object({ type: z.literal("noul"), noul: probability }),
    ]),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

/** TypeSafe /v1/systemone is a typed evaluator, not an OpenAI chat endpoint. */
export const classify: Classify = async (context) => {
  if (!context.apiKey) {
    throw new Error("Jev requires a TypeSafe API key.");
  }
  context.signal.throwIfAborted();
  const questions = Object.fromEntries(
    Object.entries(context.questions).map(([id, question]) => {
      if (question.type === "choice") {
        const count = Object.keys(question.choices).length;
        if (count < 1 || count > 255) {
          throw new Error("Jev Choice requires 1–255 options.");
        }
        return [
          id,
          { type: "choice", instructions: question.instructions, criteria: question.choices },
        ];
      }
      return [id, { type: "noul", instructions: question.instructions }];
    }),
  );
  const { response, release } = await fetchWithSsrFGuard({
    url: "https://api.typesafe.ai/v1/systemone",
    requireHttps: true,
    maxRedirects: 0,
    signal: context.signal,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${context.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: context.modelId, state: context.state, questions }),
    },
  });
  try {
    if (!response.ok) {
      // Do not echo provider bodies: they can contain credentials or request data.
      throw Object.assign(new Error(`Jev classification failed (HTTP ${response.status}).`), {
        status: response.status,
      });
    }
    const text = await readResponseTextLimited(response, 2_000_000);
    const parsed = responseSchema.parse(JSON.parse(text));
    context.signal.throwIfAborted();
    const answers: Awaited<ReturnType<Classify>> = {};
    for (const [id, question] of Object.entries(context.questions)) {
      const answer = parsed.answers[id];
      if (
        question.type === "choice" &&
        answer?.type === "choice" &&
        Object.hasOwn(question.choices, answer.choice)
      ) {
        answers[id] = { type: "choice", choice: answer.choice };
      } else if (question.type === "binary" && answer?.type === "noul") {
        answers[id] = { type: "binary", probability: answer.noul };
      } else {
        throw new Error(`Jev returned an invalid answer for question ${id}.`);
      }
    }
    return answers;
  } finally {
    await release();
  }
};
