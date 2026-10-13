import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

it.each([1440, 390])("shows executable predecessors and local bindings at %ipx", async (width) => {
  const server = await startControlUiE2eServer();
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    locale: "en-US",
    recordVideo: {
      dir: ".artifacts/control-ui-e2e/sequential-workmap",
      size: { width, height: 1000 },
    },
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const tree = {
      id: "demo.sequential",
      version: "1.0.0",
      name: "Return assessment",
      source: "imported",
      capabilityGrants: "explicit",
      nodes: [
        {
          id: "intake",
          parentId: null,
          depth: 0,
          title: "Intake",
          ontology: { mcpServers: ["tracker"] },
        },
        { id: "check", parentId: "intake", depth: 1, title: "Check evidence", ontology: {} },
        {
          id: "decide",
          parentId: "check",
          depth: 2,
          title: "Decide",
          ontology: { mcpServers: ["ledger"] },
        },
      ],
    };
    const config = {
      mcp: { servers: { tracker: { command: "tracker" }, ledger: { command: "ledger" } } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          resolved: config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash: "config",
          valid: true,
        },
        "enterprise.mode.get": { mode: "enforce" },
        "enterprise.runs.list": { runs: [] },
        "enterprise.trees.list": { trees: [{ ...tree, nodeCount: 3 }], importErrors: [] },
        "enterprise.trees.get": { tree, warnings: [] },
        "enterprise.trees.history.list": { versions: [] },
        "enterprise.knowledge.foundations.list": { foundations: [] },
        "skills.status": { skills: [] },
        "tools.catalog": { groups: [] },
      },
    });
    await page.goto(`${server.baseUrl}enterprise`);
    await page.getByText("demo.sequential@1.0.0").click();
    await page
      .getByText("Each parent completes before its selected child.", { exact: false })
      .waitFor();
    await page.screenshot({
      path: `.artifacts/control-ui-e2e/sequential-workmap/sequence-${width}.png`,
    });
    expect((await gateway.waitForRequest("enterprise.trees.get")).params).toMatchObject({
      treeId: tree.id,
    });
    for (const [title, serverName] of [
      ["Intake", "tracker"],
      ["Check evidence", null],
      ["Decide", "ledger"],
    ] as const) {
      await page.getByRole("button", { name: title, exact: true }).click();
      const inspector = page.locator(".node-inspector");
      await inspector.waitFor();
      const entries = await inspector.locator(".chip-open").allTextContents();
      expect(entries.join(" ")).not.toContain(serverName === "tracker" ? "ledger" : "tracker");
      if (serverName) {
        expect(entries.join(" ")).toContain(serverName);
      } else {
        expect(await inspector.textContent()).toContain("no MCP server attached");
      }
      await inspector.locator('.node-section[data-kind="mcp"]').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.artifacts/control-ui-e2e/sequential-workmap/${title.replaceAll(" ", "-")}-${width}.png`,
      });
    }
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
