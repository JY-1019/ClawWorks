import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  installMockGateway,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

let server: ControlUiE2eServer;
let browser: Browser;
let context: BrowserContext | undefined;
const nodes = [
  { id: "root", parentId: null, depth: 0, title: "Operations", ontology: {} },
  ...Array.from({ length: 8 }, (_, branch) => [
    {
      id: `root.b${branch}`,
      parentId: "root",
      depth: 1,
      title: `Department ${branch}`,
      ontology: {},
    },
    ...Array.from({ length: 5 }, (_, leaf) => ({
      id: `root.b${branch}.l${leaf}`,
      parentId: `root.b${branch}`,
      depth: 2,
      title: `Task ${branch}.${leaf}`,
      ontology: {},
    })),
  ]).flat(),
];

describe("whole work-map navigation", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  });
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([1440, 390])("fits all nodes, zooms, pans and restores focus at %ipx", async (width) => {
    context = await browser.newContext({
      viewport: { width, height: 900 },
      locale: "en-US",
      recordVideo: {
        dir: ".artifacts/control-ui-e2e/workmap-navigation",
        size: { width, height: 900 },
      },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const tree = {
      id: "demo.navigation",
      version: "1.0.0",
      name: "Navigation",
      source: "imported",
      nodes,
    };
    await installMockGateway(page, {
      methodResponses: {
        "enterprise.mode.get": { mode: "enforce" },
        "enterprise.runs.list": { runs: [] },
        "enterprise.trees.list": {
          trees: [{ ...tree, nodeCount: nodes.length }],
          importErrors: [],
        },
        "enterprise.trees.get": { tree, warnings: [] },
        "enterprise.trees.history.list": { versions: [] },
        "enterprise.knowledge.foundations.list": { foundations: [] },
      },
    });
    await page.goto(`${server.baseUrl}enterprise`);
    await page.getByText("demo.navigation@1.0.0").click();
    const trigger = page.getByRole("button", { name: "Open whole work-map", exact: true });
    await trigger.click();
    const dialog = page.locator("openclaw-workflow-tree-graph openclaw-modal-dialog");
    await dialog.getByRole("dialog").waitFor();
    const canvas = dialog.locator("svg");
    const shell = dialog.locator(".tree-shell");
    await page.waitForFunction(() => {
      const graph = document.querySelector("openclaw-workflow-tree-graph")?.shadowRoot;
      const viewport = graph?.querySelector(".tree-shell");
      const svg = viewport?.querySelector("svg");
      return viewport && svg && svg.getBoundingClientRect().width <= viewport.clientWidth;
    });
    expect(await canvas.locator("rect.node-action").count()).toBe(nodes.length);
    const fit = await shell.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("rect.node-action")).every((node) => {
        const box = node.getBoundingClientRect();
        return (
          box.left >= bounds.left &&
          box.right <= bounds.right &&
          box.top >= bounds.top &&
          box.bottom <= bounds.bottom
        );
      });
    });
    expect(fit).toBe(true);
    await page.screenshot({
      path: `.artifacts/control-ui-e2e/workmap-navigation/fit-${width}.png`,
    });
    const bounds = (await shell.boundingBox())!;
    const pointer = { x: bounds.x + bounds.width / 2, y: bounds.y + 80 };
    const before = (await canvas.boundingBox())!;
    const fraction = (pointer.x - before.x) / before.width;
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, -350);
    await page.waitForFunction((oldWidth) => {
      const svg = document
        .querySelector("openclaw-workflow-tree-graph")
        ?.shadowRoot?.querySelector("svg");
      return svg && svg.getBoundingClientRect().width > oldWidth;
    }, before.width);
    // Reserving inner space reproduces a classic scrollbar's content-box
    // resize without depending on the host's overlay-scrollbar preference.
    await shell.evaluate((element) => {
      (element as HTMLElement).style.paddingBottom = "20px";
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const after = (await canvas.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width);
    expect(Math.abs(after.x + fraction * after.width - pointer.x)).toBeLessThan(3);
    const scrollBefore = await shell.evaluate((element) => element.scrollLeft);
    await page.mouse.move(pointer.x, bounds.y + bounds.height - 30);
    await page.mouse.down();
    await page.mouse.move(pointer.x + 60, bounds.y + bounds.height - 30, { steps: 4 });
    await page.mouse.up();
    expect(await shell.evaluate((element) => element.scrollLeft)).toBeLessThan(scrollBefore);
    await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.screenshot({
      path: `.artifacts/control-ui-e2e/workmap-navigation/zoom-${width}.png`,
    });
    await dialog.getByRole("button", { name: "Fit to view", exact: true }).click();
    await dialog.getByRole("button", { name: "Operations", exact: true }).click();
    expect(
      await dialog
        .getByRole("button", { name: "Operations", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => {
      const graph = document.querySelector("openclaw-workflow-tree-graph")?.shadowRoot;
      return graph?.activeElement === graph?.querySelector("button.expand");
    });
    expect(
      await page
        .getByRole("button", { name: "Operations", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
