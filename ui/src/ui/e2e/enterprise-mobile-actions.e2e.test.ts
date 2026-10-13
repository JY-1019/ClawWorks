// Enterprise action bars contain more controls than a phone-width card can hold.
// The content surface intentionally hides horizontal overflow, so a button laid
// out past the right edge is unreachable rather than merely inconvenient.
import { chromium, type Browser, type BrowserContext, type Locator } from "playwright";
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

let server: ControlUiE2eServer;
let browser: Browser;
let context: BrowserContext | undefined;

async function expectInsideViewport(button: Locator) {
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
}

describeControlUiE2e("Control UI enterprise mobile actions", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}.`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close();
  });

  afterEach(async () => {
    await context?.close().catch(() => {});
    context = undefined;
  });

  it("keeps every Worktree and MCP row action reachable", async () => {
    context = await browser.newContext({
      locale: "en-US",
      recordVideo: {
        dir: ".artifacts/control-ui-e2e/customer-lifecycle",
        size: { width: 1745, height: 900 },
      },
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    const tree = {
      id: "acme.mobile",
      version: "1.0.0",
      hash: "mobile-tree-hash",
      name: "Mobile workflow",
      source: "imported",
      nodes: [
        {
          id: "root",
          parentId: null,
          depth: 0,
          title: "Financial operations and customer account administration",
          ontology: { mcpServers: [] },
        },
        {
          id: "customer",
          parentId: "root",
          depth: 1,
          title: "Customer lifecycle",
          description: "Onboard a customer, keep their records current, and close them out.",
          ontology: {
            guidance: "Read the customer record before choosing the next action. ".repeat(8),
            contextHints: ["Keep the customer account identifier attached to the request."],
            expectedOutput: "Explain the current customer state and the permitted next action.",
            audit: true,
          },
        },
      ],
    };
    const config = {
      enterprise: { mode: "enforce" },
      mcp: { servers: { "mobile-server": { command: "mobile-mcp" } } },
    };

    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          hash: "mobile-config-hash",
          raw: JSON.stringify(config),
          resolved: config,
          sourceConfig: config,
          valid: true,
        },
        "enterprise.mode.get": { mode: "enforce" },
        "enterprise.runs.list": { runs: [] },
        "enterprise.trees.list": {
          trees: [
            {
              id: tree.id,
              version: tree.version,
              name: tree.name,
              source: tree.source,
              nodeCount: tree.nodes.length,
            },
          ],
          importErrors: [],
        },
        "enterprise.trees.get": { tree, warnings: [] },
        "enterprise.trees.export": {
          content: JSON.stringify({
            schema: "clawworks.workflow-tree",
            schemaVersion: 1,
            id: tree.id,
            version: tree.version,
            name: tree.name,
            root: {
              id: tree.nodes[0].id,
              title: tree.nodes[0].title,
              ontology: tree.nodes[0].ontology,
              children: [
                {
                  id: tree.nodes[1].id,
                  title: tree.nodes[1].title,
                  description: tree.nodes[1].description,
                  ontology: tree.nodes[1].ontology,
                },
              ],
            },
          }),
          source: "imported",
        },
        "enterprise.trees.history.list": { versions: [] },
        "enterprise.knowledge.foundations.list": { foundations: [] },
        "skills.status": { skills: [] },
        "tools.catalog": { groups: [] },
      },
    });

    await page.goto(`${server.baseUrl}enterprise`);
    await expectInsideViewport(
      page.getByRole("main").getByRole("button", { name: "Import bundle", exact: true }),
    );
    await page.getByText("acme.mobile@1.0.0").click();
    await page.waitForTimeout(500);
    const main = page.getByRole("main");
    for (const label of [
      "Settings",
      "Edit",
      "Export YAML",
      "Export JSON",
      "Bundle YAML",
      "Bundle JSON",
    ]) {
      await expectInsideViewport(main.getByRole("button", { name: label, exact: true }));
    }
    await main.getByRole("button", { name: "Edit", exact: true }).click();
    await main.getByRole("button", { name: "Save", exact: true }).waitFor();
    for (const label of ["Remove", "Stop requiring MCP attachments", "Grant explicitly"]) {
      await expectInsideViewport(main.getByRole("button", { name: label, exact: true }));
    }

    await page.getByRole("button", { name: /^Customer lifecycle:/ }).click();
    const form = page.locator(".node-inspector .form-grid");
    await form.waitFor();
    for (const width of [1745, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // Let the responsive sidebar transition settle before measuring the card.
      await page.waitForTimeout(500);
      await form.scrollIntoViewIfNeeded();
      const geometry = await form.evaluate((element) => {
        const fields = Array.from(
          element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            "input, textarea, select",
          ),
        );
        const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        return {
          columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
          checkboxHeight: checkbox.getBoundingClientRect().height,
          inputHeights: fields
            .filter((field) => field.tagName === "INPUT")
            .map((field) => field.getBoundingClientRect().height),
          overflowing: fields.some(
            (field) =>
              field.getBoundingClientRect().right > element.getBoundingClientRect().right + 1,
          ),
          textOverflows: fields
            .filter((field) => field.tagName === "TEXTAREA")
            .some((field) => field.scrollWidth > field.clientWidth + 1),
        };
      });
      await page.screenshot({
        path: `.artifacts/control-ui-e2e/customer-lifecycle/form-${width}.png`,
      });
      expect(geometry.columns).toBeLessThanOrEqual(2);
      expect(geometry.checkboxHeight).toBeLessThanOrEqual(20);
      expect(geometry.inputHeights.every((height) => height < 60)).toBe(true);
      expect(geometry.overflowing).toBe(false);
      expect(geometry.textOverflows).toBe(false);
    }

    await page.goto(`${server.baseUrl}enterprise/mcp`);
    await expectInsideViewport(
      page.getByRole("main").getByRole("button", { name: "Register server", exact: true }),
    );
    const serverRow = page.locator(".list-item").filter({ hasText: "mobile-server" });
    await serverRow.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    for (const label of ["Disable", "Edit", "Remove"]) {
      await expectInsideViewport(serverRow.getByRole("button", { name: label, exact: true }));
    }
  });
});
