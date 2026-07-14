// The whole-tree view of a real workflow tree is thousands of pixels wide and
// hundreds tall. The chat bubble lays its children out with align-items:
// flex-start, which sizes them to their CONTENT — so the route card must clamp
// itself to the bubble and scroll the tree INSIDE it. Otherwise the graph spills
// out of the bubble and off the screen, and the parts that overflow are simply
// unreachable.
//
// Measured in a real browser against the real bundle: the shadow-DOM styles that
// enforce this cannot be proven by a DOM-less unit test.
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

/** The cap in workflow-tree-graph.ts: max-height: min(60vh, 460px). */
const TREE_MAX_HEIGHT_PX = 460;

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

const EMPTY_ONTOLOGY = {};

/** A wide, deep tree (24 leaves, depth 5) — the shape of a real workflow tree. */
function buildWideTree(hash: string) {
  const nodes: Array<{
    id: string;
    parentId: string | null;
    depth: number;
    title: string;
    ontology: typeof EMPTY_ONTOLOGY;
  }> = [{ id: "root", parentId: null, depth: 0, title: "Financial operations", ontology: {} }];
  for (let domain = 0; domain < 4; domain++) {
    const domainId = `root.d${domain}`;
    nodes.push({
      id: domainId,
      parentId: "root",
      depth: 1,
      title: `Domain ${domain}`,
      ontology: {},
    });
    for (let stage = 0; stage < 3; stage++) {
      const stageId = `${domainId}.s${stage}`;
      nodes.push({
        id: stageId,
        parentId: domainId,
        depth: 2,
        title: `Stage ${domain}.${stage}`,
        ontology: {},
      });
      for (let leaf = 0; leaf < 2; leaf++) {
        nodes.push({
          id: `${stageId}.l${leaf}`,
          parentId: stageId,
          depth: 3,
          title: `Step ${domain}.${stage}.${leaf}`,
          ontology: {},
        });
      }
    }
  }
  // Depth matters as much as breadth: a real tree runs 5 levels deep, which is
  // what makes the whole-tree view overflow VERTICALLY as well.
  nodes.push({
    id: "root.d0.s0.l0.c0",
    parentId: "root.d0.s0.l0",
    depth: 4,
    title: "Check 0",
    ontology: {},
  });
  nodes.push({
    id: "root.d0.s0.l0.c0.c1",
    parentId: "root.d0.s0.l0.c0",
    depth: 5,
    title: "Check 1",
    ontology: {},
  });
  return {
    id: "acme.financial-operations",
    version: "1.0.0",
    hash,
    name: "Financial operations",
    source: "builtin",
    nodes,
  };
}

/** The planned route: a single branch, the way a planner would pick it. */
function buildPlanNodes() {
  return [
    { nodeId: "root", parentId: null, seq: 0, title: "Financial operations", ontology: {} },
    { nodeId: "root.d1", parentId: "root", seq: 1, title: "Domain 1", ontology: {} },
    { nodeId: "root.d1.s0", parentId: "root.d1", seq: 2, title: "Stage 1.0", ontology: {} },
    { nodeId: "root.d1.s0.l0", parentId: "root.d1.s0", seq: 3, title: "Step 1.0.0", ontology: {} },
  ];
}

describeControlUiE2e("Control UI enterprise route card overflow", () => {
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

  it("scrolls the whole tree inside the bubble instead of overflowing the screen", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();

    const now = Date.now();
    const treeHash = "hash-under-test";
    // The run must be COMPLETED and must have started after the oldest visible
    // message but before the reply — that is what binds the card to this bubble.
    const runCreatedAt = now - 5_000;
    const runDetail = {
      executionId: "exec-1",
      runId: "run-1",
      sessionKey: "main",
      agentId: "main",
      treeId: "acme.financial-operations",
      treeVersion: "1.0.0",
      treeName: "Financial operations",
      treeHash,
      mode: "enforce",
      status: "completed",
      matchedBy: "keyword",
      requestSummary: "settle the claim",
      activeNodeId: "root.d1.s0.l0",
      route: {
        routes: ["root.d1.s0"],
        rationale: "Claim settlement lives under domain 1.",
        source: "planner",
        selectedNodes: 4,
        totalNodes: 43,
      },
      nodes: buildPlanNodes(),
      events: [],
      executionCount: 1,
      createdAt: runCreatedAt,
      updatedAt: now,
      endedAt: now,
    };

    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "settle the claim", type: "text" }],
          role: "user",
          timestamp: now - 60_000,
        },
      ],
      methodResponses: {
        "enterprise.mode.get": { mode: "enforce" },
        "enterprise.runs.list": {
          runs: [
            {
              executionId: "exec-1",
              runId: "run-1",
              sessionKey: "main",
              treeId: "acme.financial-operations",
              treeVersion: "1.0.0",
              mode: "enforce",
              status: "completed",
              requestSummary: "settle the claim",
              activeNodeId: "root.d1.s0.l0",
              createdAt: runCreatedAt,
              updatedAt: now,
              endedAt: now,
            },
          ],
        },
        "enterprise.runs.get": { run: runDetail },
        "enterprise.trees.get": { tree: buildWideTree(treeHash) },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("settle the claim").first().waitFor({ timeout: 10_000 });

      // Drive a real turn: the route card loads when the run reaches a terminal
      // state, exactly as it does in production.
      await page.locator(".agent-chat__composer-combobox textarea").fill("settle the claim");
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = sendRequest.params as Record<string, unknown>;
      await gateway.emitChatFinal({
        runId: String(params.idempotencyKey),
        text: "Settled via domain 1.",
      });

      await page.getByText("Route taken").waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Whole tree" }).click();

      const shell = page.locator(".tree-shell");
      await shell.waitFor({ timeout: 10_000 });

      const geometry = await shell.evaluate((element) => {
        const treeShell = element as HTMLElement;
        // Climb OUT of two shadow roots: .tree-shell lives in the graph's shadow
        // tree, the graph in the card's. closest() cannot cross either boundary,
        // so the bubble is only reachable by hopping host to host.
        const graphHost = (treeShell.getRootNode() as ShadowRoot).host as HTMLElement;
        const cardHost = (graphHost.getRootNode() as ShadowRoot).host as HTMLElement;
        // The card must live in an assistant bubble; if it does not, the clamp
        // assertions below would pass vacuously.
        const bubble = cardHost.closest(".chat-group-messages") as HTMLElement | null;
        return {
          bubbleWidth: bubble?.getBoundingClientRect().width ?? -1,
          cardWidth: cardHost.getBoundingClientRect().width,
          boxHeight: treeShell.getBoundingClientRect().height,
          clientHeight: treeShell.clientHeight,
          clientWidth: treeShell.clientWidth,
          scrollHeight: treeShell.scrollHeight,
          scrollWidth: treeShell.scrollWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });

      // The tree really is bigger than the box: this is the overflow case, not a
      // tree that happened to fit (which would make the assertions meaningless).
      expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);

      // ...and it is reachable by scrolling inside the card, not by spilling out.
      expect(geometry.bubbleWidth).toBeGreaterThan(0);
      expect(geometry.cardWidth).toBeLessThanOrEqual(geometry.bubbleWidth + 1);
      expect(geometry.boxHeight).toBeLessThanOrEqual(TREE_MAX_HEIGHT_PX);

      // The page itself must not gain a horizontal scrollbar.
      expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);

      // The far edge of the tree is actually reachable.
      const scrolledTo = await shell.evaluate((element) => {
        const treeShell = element as HTMLElement;
        treeShell.scrollLeft = treeShell.scrollWidth;
        return treeShell.scrollLeft;
      });
      expect(scrolledTo).toBeGreaterThan(0);
    } finally {
      await closeBrowserContext(context);
    }
  });
});
