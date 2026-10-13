import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  startControlUiE2eServer,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

it.each([1440, 390])("edits a saved work-map model and restores Default at %ipx", async (width) => {
  const server = await startControlUiE2eServer();
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "en-US" });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const definition = {
      schema: "clawworks.workflow-tree",
      schemaVersion: 1,
      id: "demo.bound",
      version: "1.0.0",
      name: "Bound map",
      executionModel: "ollama/qwen3:8b",
      root: { id: "root", title: "Assess return" },
    };
    const tree = {
      ...definition,
      hash: "bound-hash",
      source: "imported",
      nodes: [{ ...definition.root, parentId: null, depth: 0, ontology: {} }],
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "enterprise.mode.get": { mode: "enforce" },
        "enterprise.runs.list": { runs: [] },
        "enterprise.trees.list": { trees: [{ ...tree, nodeCount: 1 }], importErrors: [] },
        "enterprise.trees.get": { tree, warnings: [] },
        "enterprise.trees.export": { content: JSON.stringify(definition), source: "imported" },
        "enterprise.trees.import": { ok: true, treeId: tree.id, replaced: tree.version },
        "enterprise.trees.history.list": { versions: [] },
        "enterprise.knowledge.foundations.list": { foundations: [] },
        "skills.status": { skills: [] },
        "tools.catalog": { groups: [] },
      },
    });
    await page.goto(`${server.baseUrl}enterprise`);
    await page.getByText("demo.bound@1.0.0").click();
    await page.getByRole("main").getByRole("button", { name: "Settings", exact: true }).click();
    const input = page.getByRole("textbox", { name: /^Execution model/ });
    expect(await input.inputValue()).toBe("ollama/qwen3:8b");
    await input.fill("mistral/mistral-small-latest");
    await input.scrollIntoViewIfNeeded();
    const box = (await input.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.artifacts/control-ui-e2e/workmap-model/binding-${width}.png` });
    await page.locator("form").getByRole("button", { name: "Save", exact: true }).click();
    // Review remains local; saving sends the complete tree with the pin intact.
    expect(await gateway.getRequests("enterprise.trees.import")).toHaveLength(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .locator("openclaw-modal-dialog")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    const request = await gateway.waitForRequest("enterprise.trees.import");
    expect(JSON.parse((request.params as { content: string }).content).executionModel).toBe(
      "mistral/mistral-small-latest",
    );
    await page.getByRole("main").getByRole("button", { name: "Settings", exact: true }).click();
    await input.fill("");
    await page.locator("form").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .locator("openclaw-modal-dialog")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect
      .poll(async () => (await gateway.getRequests("enterprise.trees.import")).length)
      .toBe(2);
    const cleared = (await gateway.getRequests("enterprise.trees.import"))[1];
    expect(JSON.parse((cleared.params as { content: string }).content)).not.toHaveProperty(
      "executionModel",
    );
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
