// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/lib/translate.ts";
import { getUsageCacheRefreshTitle } from "./usage-cache-status.ts";

describe("getUsageCacheRefreshTitle", () => {
  // These assert the English source. The manager initializes from the host
  // locale and its module state is shared across files (--isolate=false), so a
  // jsdom file that switched locale first would otherwise decide what this reads.
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("formats non-fresh cache states for the Usage loading badge", () => {
    expect(
      getUsageCacheRefreshTitle({
        status: "refreshing",
        cachedFiles: 4,
        pendingFiles: 2,
        staleFiles: 2,
      }),
    ).toBe("refreshing: 2 pending, 2 stale, 4 cached");
    expect(
      getUsageCacheRefreshTitle({
        status: "partial",
        cachedFiles: 4,
        pendingFiles: 1,
        staleFiles: 1,
      }),
    ).toBe("partial: 1 pending, 1 stale, 4 cached");
    expect(
      getUsageCacheRefreshTitle({
        status: "fresh",
        cachedFiles: 4,
        pendingFiles: 0,
        staleFiles: 0,
      }),
    ).toBeNull();
  });
});
