// .list-item is a two-column grid that always reserves 200-260px for .list-meta.
// The tool catalog's rows have no meta child, and a catalog GROUP is a <details>
// whose expanded body is its second child — so grid auto-placement dropped the
// entire tool list into that narrow reserved column, where every tool id and
// description collapsed into a sliver pinned to the left of the card.
//
// Only a real layout engine can prove this: the class is applied either way, and
// jsdom/happy-dom compute no grid tracks. Measure the rendered boxes instead.
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

/** The dead gutter .list-item reserves: grid-template-columns' second track. */
const RESERVED_META_COLUMN_MAX_PX = 260;

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

function coreTool(id: string, description: string) {
  return { id, label: id, description, source: "core", defaultProfiles: [] };
}

const TOOLS_CATALOG = {
  groups: [
    {
      id: "fs",
      label: "Files",
      source: "core",
      tools: [coreTool("read", "Read a file from the workspace.")],
    },
    {
      id: "enterprise",
      label: "Enterprise",
      source: "core",
      tools: [
        coreTool("search_objects", "Search ontology objects in the current workflow step."),
        coreTool("knowledge_search", "Search enterprise knowledge foundations."),
      ],
    },
  ],
};

describeControlUiE2e("Control UI enterprise tool catalog layout", () => {
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

  it("gives catalog rows the full card width instead of the reserved meta column", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();

    await installMockGateway(page, {
      methodResponses: {
        "enterprise.mode.get": { mode: "enforce" },
        "enterprise.runs.list": { runs: [] },
        "enterprise.trees.list": { trees: [], importErrors: [] },
        "enterprise.knowledge.foundations.list": { foundations: [] },
        "skills.status": { skills: [] },
        "tools.catalog": TOOLS_CATALOG,
      },
    });

    await page.goto(`${server.baseUrl}enterprise/tools`);

    // The enterprise group renders expanded, so its rows are on screen without a
    // click — that is the state an operator lands in.
    const toolRow = page.locator(".catalog-children .list-item").first();
    await toolRow.waitFor({ timeout: 15_000 });

    const group = page.locator("details.list-item").first();
    const groupBox = await group.boundingBox();
    const rowBox = await toolRow.boundingBox();
    expect(groupBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    if (!groupBox || !rowBox) {
      return;
    }

    // The bug: the row was confined to the reserved meta track. Its width is now
    // driven by the group's width, so it must be far wider than that track and
    // must not start near the group's right edge.
    expect(rowBox.width).toBeGreaterThan(RESERVED_META_COLUMN_MAX_PX);
    expect(rowBox.width).toBeGreaterThan(groupBox.width * 0.8);
    expect(rowBox.x).toBeLessThan(groupBox.x + groupBox.width * 0.25);

    // The card itself must not have grown a horizontal scrollbar to fit them.
    const bodyOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(bodyOverflow).toBeLessThanOrEqual(1);
  });
});
