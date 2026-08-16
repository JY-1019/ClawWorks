/**
 * A CLI-runtime OAuth credential must refresh through the provider that issued
 * its token.
 *
 * The credential the Claude CLI hands over carries `provider: "claude-cli"`,
 * but the OAuth registry is keyed by "anthropic". Looked up unresolved it
 * matched nothing, so the credential could never be refreshed: once its access
 * token expired the profile resolved to null and the candidate loop skipped it
 * in silence, handing the run whatever credential sorted next — on a
 * subscription-only box, typically a stale API key. Nothing surfaced that.
 *
 * No module mocks on purpose: this asserts against the real OAuth registry and
 * the real alias map, so it stays correct if either gains an entry, and it
 * cannot leak a mocked module graph into sibling files under `--isolate=false`.
 */
import { describe, expect, it } from "vitest";
import { resolveCredentialOAuthProvider } from "./oauth.js";

describe("resolveCredentialOAuthProvider", () => {
  it("routes a claude-cli credential to the anthropic provider", () => {
    expect(resolveCredentialOAuthProvider("claude-cli")).toBe("anthropic");
  });

  it("leaves a credential that already names its issuer alone", () => {
    expect(resolveCredentialOAuthProvider("anthropic")).toBe("anthropic");
    expect(resolveCredentialOAuthProvider("github-copilot")).toBe("github-copilot");
  });

  it("does not invent an issuer for a runtime that aliases none", () => {
    // Borrowing an unrelated registry entry would send one vendor's refresh
    // token to another's endpoint.
    expect(resolveCredentialOAuthProvider("gemini-cli")).toBeNull();
    expect(resolveCredentialOAuthProvider("definitely-not-a-provider")).toBeNull();
  });
});
