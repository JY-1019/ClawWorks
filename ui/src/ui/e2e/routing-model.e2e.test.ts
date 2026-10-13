import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  startControlUiE2eServer,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

it.each([1440, 390])(
  "sends a routing-only override and restores Default at %ipx",
  async (width) => {
    const server = await startControlUiE2eServer();
    const browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      locale: "en-US",
      recordVideo: { dir: ".artifacts/control-ui-e2e/routing-model" },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "enterprise.mode.get": { mode: "enforce" },
          "enterprise.runs.list": { runs: [] },
        },
      });
      await page.goto(`${server.baseUrl}chat`);
      const trigger = page.locator("summary").filter({ hasText: "Routing model:" });
      await trigger.click();
      const field = page.getByRole("combobox", { name: "Routing model", exact: true });
      const menu = page.locator(".chat-controls__inline-select-menu--routing");
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await field.fill("jev/jev-latest");
      await field.press("Tab");
      await expect.poll(() => trigger.textContent()).toContain("jev/jev-latest");
      const selectedBox = (await menu.boundingBox())!;
      expect(selectedBox.x).toBeGreaterThanOrEqual(0);
      expect(selectedBox.x + selectedBox.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `.artifacts/control-ui-e2e/routing-model/selection-${width}.png`,
      });
      await trigger.click();
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Assess return eligibility");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const first = await gateway.waitForRequest("chat.send");
      const firstParams = first.params as Record<string, unknown>;
      expect(firstParams.routeModel).toBe("jev/jev-latest");
      expect(first.params).not.toHaveProperty("model");
      await gateway.emitChatFinal({
        runId: String(firstParams.idempotencyKey),
        text: "Assessed.",
      });
      await page.getByText("Assessed.", { exact: true }).waitFor();
      await trigger.click();
      await page.getByRole("button", { name: "Default", exact: true }).click();
      await trigger.click();
      await page.locator(".agent-chat__composer-combobox textarea").fill("Use configured routing");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
      expect((await gateway.getRequests("chat.send"))[1].params).not.toHaveProperty("routeModel");
      await page.screenshot({
        path: `.artifacts/control-ui-e2e/routing-model/default-${width}.png`,
      });
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
);
