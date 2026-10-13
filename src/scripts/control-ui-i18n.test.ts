// Control UI i18n script tests cover locale extraction and validation.
import { describe, expect, it } from "vitest";
import {
  buildLatestTranslationSourceHashesBySegment,
  findPlaceholderMismatches,
  isProviderAuthError,
  isStaleTranslationSource,
  resolveTranslationModel,
  shouldReuseExistingLocaleText,
  type TranslationMemoryEntry,
} from "../../scripts/control-ui-i18n.ts";
import { withEnv } from "../test-utils/env.js";

function translationMemoryEntry(textHash: string, updatedAt: string): TranslationMemoryEntry {
  return {
    cache_key: textHash,
    model: "test",
    provider: "test",
    segment_id: "enterprise.warning",
    source_path: "ui/src/i18n/locales/ko.ts",
    src_lang: "en",
    text: textHash,
    text_hash: textHash,
    tgt_lang: "ko",
    translated: textHash,
    updated_at: updatedAt,
  };
}

describe("control-ui-i18n placeholder validation", () => {
  it("reports missing and extra placeholders by key", () => {
    const mismatches = findPlaceholderMismatches(
      new Map([
        ["sessionsView.activeTooltip", "Updated in the last {count} minutes."],
        ["sessionsView.store", "Store: {path}"],
        ["sessionsView.limitTooltip", "Max sessions to load."],
      ]),
      new Map([
        ["sessionsView.activeTooltip", "Actualizadas en los últimos N minutos."],
        ["sessionsView.store", "Almacén: {path}"],
        ["sessionsView.limitTooltip", "Máximo {extra} de sesiones."],
      ]),
      "es",
    );

    expect(mismatches).toEqual([
      {
        key: "sessionsView.activeTooltip",
        locale: "es",
        sourcePlaceholders: ["count"],
        translatedPlaceholders: [],
      },
      {
        key: "sessionsView.limitTooltip",
        locale: "es",
        sourcePlaceholders: [],
        translatedPlaceholders: ["extra"],
      },
    ]);
  });
});

describe("control-ui-i18n translation runtime resolution", () => {
  it("uses the in-tree OpenClaw LLM model catalog", () => {
    expect(
      withEnv(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          OPENCLAW_CONTROL_UI_I18N_MODEL: undefined,
          OPENCLAW_CONTROL_UI_I18N_PROVIDER: undefined,
        },
        () => resolveTranslationModel(),
      ),
    ).toMatchObject({ id: "gpt-5.5", provider: "openai" });
  });
});

describe("control-ui-i18n provider auth errors", () => {
  it("recognizes OpenAI and Anthropic authentication failures", () => {
    expect(isProviderAuthError(new Error("401 Incorrect API key provided"))).toBe(true);
    expect(
      isProviderAuthError(
        new Error(
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        ),
      ),
    ).toBe(true);
    expect(isProviderAuthError(new Error("model timed out"))).toBe(false);
  });
});

describe("control-ui-i18n source refresh", () => {
  it("marks an existing translation stale when only an older source hash is known", () => {
    expect(isStaleTranslationSource("old", "current")).toBe(true);
    expect(isStaleTranslationSource("current", "current")).toBe(false);
    expect(isStaleTranslationSource(undefined, "current")).toBe(false);
  });

  it("compares a reverted source with the latest translation, not any historical one", () => {
    const memory = new Map([
      ["new", translationMemoryEntry("h2", "2026-01-02T00:00:00.000Z")],
      ["old", translationMemoryEntry("h1", "2026-01-01T00:00:00.000Z")],
    ]);
    const latest = buildLatestTranslationSourceHashesBySegment(memory, "ko");

    expect(latest.get("enterprise.warning")).toBe("h2");
    expect(isStaleTranslationSource(latest.get("enterprise.warning"), "h1")).toBe(true);
  });

  it("refreshes fallback and stale source text instead of reusing it", () => {
    expect(
      shouldReuseExistingLocaleText({ force: false, sourceChanged: false, wasFallback: true }),
    ).toBe(false);
    expect(
      shouldReuseExistingLocaleText({ force: false, sourceChanged: true, wasFallback: false }),
    ).toBe(false);
    expect(
      shouldReuseExistingLocaleText({ force: false, sourceChanged: false, wasFallback: false }),
    ).toBe(true);
  });
});
