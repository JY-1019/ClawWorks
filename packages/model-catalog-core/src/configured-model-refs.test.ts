// Model Catalog Core tests cover configured model refs behavior.
import { describe, expect, it } from "vitest";
import {
  collectConfiguredModelRefs,
  collectConfiguredModelRefValues,
  extractProviderFromModelRef,
} from "./configured-model-refs.js";

describe("configured model refs", () => {
  it("collects agent, hook, message, and channel model refs with config paths", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
            compaction: { memoryFlush: { model: "openai/gpt-5.5-mini" } },
          },
          list: [{ id: "custom", model: "xai/grok-4-fast" }],
        },
        hooks: {
          mappings: [{ model: "openai/gpt-5.5-nano" }],
        },
        messages: {
          tts: { summaryModel: "openai/gpt-5.5-mini" },
        },
        channels: {
          modelByChannel: {
            discord: {
              guild: "anthropic/claude-opus-4-8",
            },
          },
        },
      }),
    ).toEqual([
      { path: "agents.defaults.model.primary", value: "openai/gpt-5.5" },
      { path: "agents.defaults.model.fallbacks.0", value: "anthropic/claude-sonnet-4-6" },
      { path: "agents.defaults.compaction.memoryFlush.model", value: "openai/gpt-5.5-mini" },
      { path: "agents.list.0.model", value: "xai/grok-4-fast" },
      { path: "channels.modelByChannel.discord.guild", value: "anthropic/claude-opus-4-8" },
      { path: "hooks.mappings.0.model", value: "openai/gpt-5.5-nano" },
      { path: "messages.tts.summaryModel", value: "openai/gpt-5.5-mini" },
    ]);
  });

  it("collects the enterprise route planner model", () => {
    // It can be the only reference to its provider; leaving it out leaves that
    // plugin un-activated and routing reports unavailable at run time.
    expect(
      collectConfiguredModelRefs({
        enterprise: { routePlanner: { model: "mistral/mistral-medium-3-5" } },
      }),
    ).toContainEqual({
      path: "enterprise.routePlanner.model",
      value: "mistral/mistral-medium-3-5",
    });
  });

  it("skips the route planner model when enterprise mode is off", () => {
    // Nothing can consult the router then, so a dormant setting must not activate a
    // provider plugin on what is otherwise a stock install.
    expect(
      collectConfiguredModelRefs({
        enterprise: { mode: "off", routePlanner: { model: "mistral/mistral-medium-3-5" } },
      }),
    ).toEqual([]);
  });

  it("can exclude channel model overrides from configured refs", () => {
    expect(
      collectConfiguredModelRefValues(
        {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          channels: { modelByChannel: { discord: { guild: "anthropic/claude-sonnet-4-6" } } },
        },
        { includeChannelModelOverrides: false },
      ),
    ).toEqual(["openai/gpt-5.5"]);
  });

  it("ignores array-shaped malformed records", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            models: ["openai/gpt-5.5"],
          },
        },
      }),
    ).toEqual([]);
  });

  it("extracts normalized providers from provider-prefixed refs", () => {
    expect(extractProviderFromModelRef(" OpenAI/gpt-5.5 ")).toBe("openai");
    expect(extractProviderFromModelRef("gpt-5.5")).toBeNull();
  });
});
