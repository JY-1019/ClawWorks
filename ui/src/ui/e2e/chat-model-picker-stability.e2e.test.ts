// The chat model picker is anchored by its BOTTOM edge (opens upward from the
// composer), so anything that changes its height slides every row vertically.
// The provider rail switches groups on hover, and providers hold different
// numbers of models — so without a size-stable models pane the list moves out
// from under the pointer that caused the switch and options cannot be clicked.
//
// Measured in a real browser against the real bundle: the grid stacking that
// enforces this is layout, which a DOM-less unit test cannot observe.
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

// Deliberately lopsided: five models on one provider, two on the other. An
// equal split would pass even with the old per-group sizing.
const MODELS = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8 (Claude CLI)", provider: "claude-cli" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Claude CLI)", provider: "claude-cli" },
];

let server: ControlUiE2eServer;
const contextBrowsers = new WeakMap<BrowserContext, Browser>();
const openBrowserContexts = new Set<BrowserContext>();

async function newBrowserContext(options: Parameters<Browser["newContext"]>[0]) {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext(options);
    contextBrowsers.set(context, browser);
    openBrowserContexts.add(context);
    return context;
  } catch (error) {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  const browser = contextBrowsers.get(context);
  openBrowserContexts.delete(context);
  contextBrowsers.delete(context);
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

async function closeOpenBrowserContexts(): Promise<void> {
  await Promise.all([...openBrowserContexts].map((context) => closeBrowserContext(context)));
}

describeControlUiE2e("chat model picker size stability", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await closeOpenBrowserContexts();
    await server?.close();
  });

  afterEach(async () => {
    await closeOpenBrowserContexts();
  });

  it("does not resize or move when the provider rail switches groups", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();

    await installMockGateway(page, { models: MODELS });
    await page.goto(`${server.baseUrl}chat`);

    const main = page.getByRole("main");
    const trigger = main.locator('[data-chat-model-select="true"]').first();
    await trigger.waitFor({ state: "visible", timeout: 15_000 });
    await trigger.click();

    const menu = main.locator(".chat-controls__inline-select-menu--combined").first();
    await menu.waitFor({ state: "visible", timeout: 15_000 });

    const smallerProvider = main.locator('[data-chat-model-provider="claude-cli"]');
    await smallerProvider.waitFor({ state: "visible", timeout: 15_000 });

    const before = await menu.boundingBox();
    expect(before).not.toBeNull();

    // Hover is what an operator does on the way to a click, and it is what used
    // to reflow the menu mid-gesture.
    await smallerProvider.hover();
    const afterHover = await menu.boundingBox();
    expect(afterHover).not.toBeNull();

    await smallerProvider.click();
    const afterClick = await menu.boundingBox();
    expect(afterClick).not.toBeNull();
    if (!before || !afterHover || !afterClick) {
      return;
    }

    // Sub-pixel drift is fine; a group swap must not move the box.
    for (const after of [afterHover, afterClick]) {
      expect(Math.abs(after.height - before.height)).toBeLessThan(2);
      expect(Math.abs(after.y - before.y)).toBeLessThan(2);
      expect(Math.abs(after.width - before.width)).toBeLessThan(2);
    }

    // And the switch really did happen — otherwise the assertions above are
    // vacuous.
    const visibleGroup = main.locator(
      '[data-chat-model-provider-group="claude-cli"]:not([hidden])',
    );
    await visibleGroup.waitFor({ state: "attached", timeout: 15_000 });
    expect(await smallerProvider.getAttribute("aria-pressed")).toBe("true");
  });
});
