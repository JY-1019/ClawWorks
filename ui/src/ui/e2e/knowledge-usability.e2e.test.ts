import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const artifactDir = path.resolve(".artifacts/control-ui-e2e/knowledge-usability");
let server: ControlUiE2eServer;
let browser: Browser;

describeControlUiE2e("Knowledge document usability", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}.`);
    }
    await mkdir(artifactDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({
      executablePath: chromiumExecutablePath,
    });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ])(
    "refreshes indexing and retries failed document loads on $name",
    async ({ name, width, height }) => {
      const context: BrowserContext = await browser.newContext({
        locale: "en-US",
        viewport: { width, height },
        recordVideo: { dir: artifactDir, size: { width, height } },
        serviceWorkers: "block",
      });
      try {
        const page = await context.newPage();
        const foundationId = "acme.support-kb";
        const manifest = JSON.parse(
          await readFile("extensions/lightrag/openclaw.plugin.json", "utf8"),
        ) as { configSchema: unknown };
        const config = {
          plugins: {
            entries: {
              lightrag: {
                enabled: true,
                config: {
                  foundations: [{ id: foundationId, serverUrl: "http://rag.test", kind: "local" }],
                },
              },
            },
          },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config,
              hash: "knowledge-test",
              raw: JSON.stringify(config),
              valid: true,
            },
            "config.schema": {
              schema: {
                properties: {
                  plugins: {
                    properties: {
                      entries: {
                        properties: { lightrag: { properties: { config: manifest.configSchema } } },
                      },
                    },
                  },
                },
              },
              uiHints: {},
              version: "test",
              generatedAt: "2026-10-07T00:00:00Z",
            },
            "enterprise.knowledge.foundations.list": {
              foundations: [
                {
                  id: foundationId,
                  displayName: "Customer support",
                  kind: "local",
                  referencedBy: [],
                },
              ],
            },
            "enterprise.knowledge.documents.list": { status: "ok", documents: [] },
            "enterprise.knowledge.documents.upload": {
              status: "accepted",
              trackingId: "index-job",
            },
          },
        });
        await page.goto(`${server.baseUrl}knowledge`);
        await page.getByRole("button", { name: "Show files", exact: true }).click();
        const upload = page.getByRole("button", { name: "Upload document", exact: true });
        await upload.waitFor();
        await page.getByRole("button", { name: "Connect a source", exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Hide files", exact: true })
          .evaluate((button) => button.scrollIntoView({ block: "start" }));
        await page.screenshot({
          path: path.join(artifactDir, `${name}-01-empty.png`),
          fullPage: true,
        });

        // The native button must work from the keyboard, not just through a forced click.
        await upload.focus();
        const chooser = page.waitForEvent("filechooser");
        await page.keyboard.press("Enter");
        await gateway.deferNext("enterprise.knowledge.documents.list");
        await (
          await chooser
        ).setFiles({
          name: "support-policy.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("Return within 30 days."),
        });
        const request = await gateway.waitForRequest("enterprise.knowledge.documents.upload");
        expect(request.params).toMatchObject({ foundationId, name: "support-policy.md" });
        await expect
          .poll(
            async () => (await gateway.getRequests("enterprise.knowledge.documents.list")).length,
          )
          .toBe(2);
        await gateway.resolveDeferred("enterprise.knowledge.documents.list", {
          status: "ok",
          documents: [{ id: "policy", name: "support-policy.md", status: "pending" }],
        });
        await page.getByRole("status").filter({ hasText: "Pending: 1" }).waitFor();
        await page
          .getByRole("button", { name: "Hide files", exact: true })
          .evaluate((button) => button.scrollIntoView({ block: "start" }));
        await page.screenshot({
          path: path.join(artifactDir, `${name}-02-pending.png`),
          fullPage: true,
        });

        // Global refresh must fetch documents too, without Hide/Show as a workaround.
        await gateway.deferNext("enterprise.knowledge.documents.list");
        await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
        await expect
          .poll(
            async () => (await gateway.getRequests("enterprise.knowledge.documents.list")).length,
          )
          .toBe(3);
        await gateway.resolveDeferred("enterprise.knowledge.documents.list", {
          status: "ok",
          documents: [
            { id: "policy", name: "support-policy.md", status: "indexed", chunkCount: 1 },
          ],
        });
        await page.getByRole("status").filter({ hasText: "Indexed: 1" }).waitFor();
        await expect
          .poll(async () => page.getByRole("status").filter({ hasText: "Pending: 1" }).count())
          .toBe(0);
        await page
          .getByRole("button", { name: "Hide files", exact: true })
          .evaluate((button) => button.scrollIntoView({ block: "start" }));
        await page.screenshot({
          path: path.join(artifactDir, `${name}-03-indexed.png`),
          fullPage: true,
        });

        await gateway.deferNext("enterprise.knowledge.documents.list");
        await page.getByRole("button", { name: "Refresh", exact: true }).last().click();
        await expect
          .poll(
            async () => (await gateway.getRequests("enterprise.knowledge.documents.list")).length,
          )
          .toBe(4);
        await gateway.rejectDeferred("enterprise.knowledge.documents.list", {
          code: "UNAVAILABLE",
          message: "Temporarily unavailable",
        });
        await page.getByText("Could not load documents.", { exact: true }).waitFor();
        await expect.poll(async () => upload.count()).toBe(0);
        await page
          .getByRole("button", { name: "Hide files", exact: true })
          .evaluate((button) => button.scrollIntoView({ block: "start" }));
        await page.screenshot({
          path: path.join(artifactDir, `${name}-04-retry.png`),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Refresh", exact: true }).last().click();
        await upload.waitFor();
        await expect
          .poll(
            async () => (await gateway.getRequests("enterprise.knowledge.documents.list")).length,
          )
          .toBe(5);
        await expect
          .poll(async () => page.getByText("Could not load documents.", { exact: true }).count())
          .toBe(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page
          .getByRole("button", { name: "Hide files", exact: true })
          .evaluate((button) => button.scrollIntoView({ block: "start" }));
        await page.screenshot({
          path: path.join(artifactDir, `${name}-05-recovered.png`),
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    },
    60_000,
  );
});
