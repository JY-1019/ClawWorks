import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
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
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/enterprise-bundle");

let server: ControlUiE2eServer;
let browser: Browser;
let context: BrowserContext | undefined;

describeControlUiE2e("Control UI enterprise bundle exchange", () => {
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

  it("previews exact file bytes before apply and downloads the selected work-map", async () => {
    context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const reviewToken = "a".repeat(64);
    const tree = {
      id: "acme.bundle",
      version: "1.0.0",
      hash: "current-tree-hash",
      name: "Bundle workflow",
      source: "imported",
      nodes: [{ id: "root", parentId: null, depth: 0, title: "Root", ontology: {} }],
    };
    const bundleContent = `${JSON.stringify({
      schema: "clawworks.workflow-bundle",
      schemaVersion: 1,
      trees: [{ id: "acme.bundle", version: "2.0.0" }],
      knowledgeFoundations: [],
      requiredTools: ["read"],
      requiredSkills: ["refund-playbook"],
      requiredMcpServers: ["acme-tracker"],
    })}\n`;
    const exportedContent = '{"schema":"clawworks.workflow-bundle","schemaVersion":1}\n';
    const config = {
      enterprise: { mode: "enforce" },
      mcp: { servers: { "acme-tracker": { command: "tracker-mcp" } } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          hash: "bundle-config-hash",
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
        "enterprise.trees.history.list": { versions: [] },
        "enterprise.knowledge.foundations.list": { foundations: [] },
        "skills.status": {
          agentId: "main",
          skills: [{ name: "refund-playbook", eligible: true, disabled: false }],
        },
        "tools.catalog": { agentId: "main", groups: [] },
        "enterprise.bundles.preview": {
          ok: true,
          reviewToken,
          trees: [
            {
              id: tree.id,
              version: "2.0.0",
              replaced: "imported",
              currentVersion: tree.version,
              currentHash: tree.hash,
            },
          ],
          foundations: ["acme.kb"],
          missingFoundations: [],
          removedFoundations: [],
          replacedFoundations: [],
          shadowedFoundations: ["acme.kb"],
          requiredTools: ["read"],
          requiredSkills: ["refund-playbook"],
          requiredMcpServers: ["acme-tracker"],
          missingMcpServers: [],
          warnings: [],
          missingGovernancePolicies: [],
          conflictingGovernancePolicies: [],
        },
        "enterprise.bundles.import": {
          ok: true,
          trees: [{ id: tree.id, replaced: "imported" }],
          foundations: ["acme.kb"],
          missingFoundations: [],
          removedFoundations: [],
          replacedFoundations: [],
          shadowedFoundations: ["acme.kb"],
          requiredTools: ["read"],
          requiredSkills: ["refund-playbook"],
          requiredMcpServers: ["acme-tracker"],
          missingMcpServers: [],
          warnings: [],
          missingGovernancePolicies: [],
          conflictingGovernancePolicies: [],
        },
        "enterprise.bundles.export": {
          ok: true,
          content: exportedContent,
          source: "imported",
          skippedFoundations: [],
          impliedAllowAllKnowledge: false,
        },
      },
    });

    await page.goto(`${server.baseUrl}enterprise`);
    await page.getByText("acme.bundle@1.0.0").click();
    const importInput = page
      .locator('label[role="button"]')
      .filter({ hasText: "Import bundle" })
      .locator('input[type="file"]');
    await importInput.setInputFiles({
      name: "acme.bundle.json",
      mimeType: "application/json",
      buffer: Buffer.from(bundleContent),
    });

    const previewRequest = await gateway.waitForRequest("enterprise.bundles.preview");
    expect(previewRequest.params).toEqual({ content: bundleContent, format: "json" });
    const previewCopy = page
      .locator("openclaw-modal-dialog .exec-approval-card > .muted")
      .filter({ hasText: "Nothing has been changed yet." });
    const requiredSkill = page.getByText("refund-playbook", { exact: true });
    const requiredMcp = page.getByText("acme-tracker", { exact: true });
    const shadowWarning = page.getByText(
      "Bundled knowledge ignored at runtime (a global/plugin foundation with the same id takes precedence)",
      { exact: true },
    );
    await previewCopy.waitFor();
    await requiredSkill.waitFor();
    await requiredMcp.waitFor();
    await shadowWarning.waitFor();
    expect(await previewCopy.isVisible()).toBe(true);
    expect(await requiredSkill.isVisible()).toBe(true);
    expect(await requiredMcp.isVisible()).toBe(true);
    expect(await shadowWarning.isVisible()).toBe(true);
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({
      fullPage: true,
      path: path.join(artifactDir, "01-bundle-preview.png"),
    });

    await page.getByRole("button", { name: "Apply bundle", exact: true }).click();
    const importRequest = await gateway.waitForRequest("enterprise.bundles.import");
    expect(importRequest.params).toEqual({
      content: bundleContent,
      format: "json",
      reviewToken,
      expectedHash: tree.hash,
    });

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Bundle JSON", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("acme.bundle.bundle.json");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (downloadPath) {
      expect(await readFile(downloadPath, "utf8")).toBe(exportedContent);
    }
    expect((await gateway.waitForRequest("enterprise.bundles.export")).params).toEqual({
      treeId: tree.id,
      format: "json",
    });
  });
});
