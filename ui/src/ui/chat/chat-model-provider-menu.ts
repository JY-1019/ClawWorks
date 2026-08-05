// Provider rail behavior for the chat model picker.
//
// The rail and the model groups are rendered together and only ONE group is
// visible at a time. Switching is done here rather than through a re-render so
// the open <details> menu keeps its scroll position and focus while the pointer
// moves across providers — a re-render would rebuild the list under the cursor.

/** Show only the chosen provider's model group and mark its rail button active. */
export function selectChatModelProvider(event: Event, provider: string): void {
  event.preventDefault();
  event.stopPropagation();
  const menu = (event.currentTarget as HTMLElement).closest(
    ".chat-controls__inline-select-menu--combined",
  );
  if (!(menu instanceof HTMLElement)) {
    return;
  }
  for (const button of menu.querySelectorAll<HTMLElement>("[data-chat-model-provider]")) {
    const active = button.dataset.chatModelProvider === provider;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    // Roving tabindex: only the active provider is a tab stop, so Tab leaves the
    // rail for the model list instead of walking every provider first.
    button.tabIndex = active ? 0 : -1;
  }
  for (const group of menu.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]")) {
    group.hidden = group.dataset.chatModelProviderGroup !== provider;
  }
}

/** Arrow/Home/End movement inside the provider rail. */
export function moveChatModelProviderFocus(event: KeyboardEvent): void {
  const direction =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  const current = event.currentTarget as HTMLElement;
  const list = current.closest(".chat-controls__provider-list");
  const buttons = list
    ? [...list.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider]")]
    : [];
  const currentIndex = buttons.indexOf(current as HTMLButtonElement);
  if (currentIndex < 0 || (direction === 0 && event.key !== "Home" && event.key !== "End")) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (currentIndex + direction + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}

/**
 * Human-readable provider name for the rail.
 *
 * Provider ids are config keys, not display strings, so they are title-cased on
 * the separators the ids actually use (`claude-cli` -> "Claude CLI",
 * `vercel-ai-gateway` -> "Vercel AI Gateway"). Known acronyms stay upper-case;
 * anything unrecognized is passed through capitalized rather than dropped, so a
 * provider this list has never heard of still reads as a name.
 */
const PROVIDER_WORD_OVERRIDES: Record<string, string> = {
  ai: "AI",
  api: "API",
  cli: "CLI",
  gmi: "GMI",
  llm: "LLM",
  oauth: "OAuth",
  openai: "OpenAI",
  xai: "xAI",
  zai: "Z.AI",
};

export function chatModelProviderLabel(provider: string): string {
  const trimmed = provider.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return PROVIDER_WORD_OVERRIDES[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
