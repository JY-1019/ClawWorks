import { describe, expect, it } from "vitest";
import {
  chatModelProviderLabel,
  moveChatModelProviderFocus,
  selectChatModelProvider,
} from "./chat-model-provider-menu.ts";

describe("chatModelProviderLabel", () => {
  it("title-cases provider ids on the separators the ids use", () => {
    expect(chatModelProviderLabel("anthropic")).toBe("Anthropic");
    expect(chatModelProviderLabel("vercel-ai-gateway")).toBe("Vercel AI Gateway");
    expect(chatModelProviderLabel("github_copilot")).toBe("Github Copilot");
  });

  it("keeps known acronyms upper-case so the CLI route is readable", () => {
    expect(chatModelProviderLabel("claude-cli")).toBe("Claude CLI");
    expect(chatModelProviderLabel("openai")).toBe("OpenAI");
    expect(chatModelProviderLabel("zai")).toBe("Z.AI");
  });

  it("passes an unknown provider through rather than dropping it", () => {
    expect(chatModelProviderLabel("acme-corp")).toBe("Acme Corp");
    expect(chatModelProviderLabel("   ")).toBe("");
  });
});

function mountRail(): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "chat-controls__inline-select-menu--combined";
  menu.innerHTML = `
    <div class="chat-controls__provider-list">
      <button data-chat-model-provider="anthropic" aria-pressed="true" tabindex="0">Anthropic</button>
      <button data-chat-model-provider="claude-cli" aria-pressed="false" tabindex="-1">Claude CLI</button>
      <button data-chat-model-provider="openai" aria-pressed="false" tabindex="-1">OpenAI</button>
    </div>
    <div>
      <div data-chat-model-provider-group="anthropic"></div>
      <div data-chat-model-provider-group="claude-cli" hidden></div>
      <div data-chat-model-provider-group="openai" hidden></div>
    </div>
  `;
  document.body.replaceChildren(menu);
  return menu;
}

function providerButton(menu: HTMLElement, provider: string): HTMLButtonElement {
  const button = menu.querySelector<HTMLButtonElement>(`[data-chat-model-provider="${provider}"]`);
  if (!button) {
    throw new Error(`missing provider button: ${provider}`);
  }
  return button;
}

function visibleGroups(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]")]
    .filter((group) => !group.hidden)
    .map((group) => group.dataset.chatModelProviderGroup ?? "");
}

/** The event the rail handlers receive; only these three members are read. */
function railEvent(target: HTMLElement): Event {
  return { currentTarget: target, preventDefault() {}, stopPropagation() {} } as unknown as Event;
}

describe("selectChatModelProvider", () => {
  it("shows only the chosen provider's models", () => {
    const menu = mountRail();

    selectChatModelProvider(railEvent(providerButton(menu, "claude-cli")), "claude-cli");

    expect(visibleGroups(menu)).toEqual(["claude-cli"]);
  });

  it("moves the single tab stop onto the active provider", () => {
    const menu = mountRail();

    selectChatModelProvider(railEvent(providerButton(menu, "openai")), "openai");

    expect(providerButton(menu, "openai").getAttribute("aria-pressed")).toBe("true");
    expect(providerButton(menu, "openai").tabIndex).toBe(0);
    expect(providerButton(menu, "anthropic").getAttribute("aria-pressed")).toBe("false");
    expect(providerButton(menu, "anthropic").tabIndex).toBe(-1);
  });
});

describe("moveChatModelProviderFocus", () => {
  it("wraps around the rail with the arrow keys", () => {
    const menu = mountRail();
    const last = providerButton(menu, "openai");
    last.focus();

    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    Object.defineProperty(event, "currentTarget", { value: last });
    moveChatModelProviderFocus(event);

    expect(document.activeElement).toBe(providerButton(menu, "anthropic"));
  });

  it("ignores keys that are not rail navigation", () => {
    const menu = mountRail();
    const first = providerButton(menu, "anthropic");
    first.focus();

    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(event, "currentTarget", { value: first });
    moveChatModelProviderFocus(event);

    expect(document.activeElement).toBe(first);
  });
});
