import { describe, expect, it } from "vitest";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.ts";
import { isCrossLineTouchedVersion } from "./legacy-config-migrations.runtime.meta.ts";

describe("cross-line lastTouchedVersion", () => {
  it("recognizes an upstream calendar version under a ClawWorks binary", () => {
    expect(isCrossLineTouchedVersion("2026.6.10", "0.1.0-beta.1")).toBe(true);
    expect(isCrossLineTouchedVersion("2025.12.1", "1.4.0")).toBe(true);
  });

  it("leaves a downgrade inside one line alone, which is what the guard is for", () => {
    // The future-version guard exists to stop an older binary mutating a config a
    // newer one already migrated. Clearing the marker in these cases would defeat
    // it rather than repair the fork.
    expect(isCrossLineTouchedVersion("2026.6.10", "2026.5.1")).toBe(false);
    expect(isCrossLineTouchedVersion("0.2.0", "0.1.0-beta.1")).toBe(false);
  });

  it("ignores a missing or unparsable marker", () => {
    expect(isCrossLineTouchedVersion(undefined, "0.1.0-beta.1")).toBe(false);
    expect(isCrossLineTouchedVersion("not-a-version", "0.1.0-beta.1")).toBe(false);
  });

  it("drops the marker so the next write restamps it on this line", () => {
    const { next, changes } = applyLegacyDoctorMigrations({
      meta: { lastTouchedVersion: "2026.6.10", lastTouchedAt: "2026-08-19T14:42:19.433Z" },
      enterprise: { mode: "enforce" },
    });
    expect(next?.meta).toEqual({ lastTouchedAt: "2026-08-19T14:42:19.433Z" });
    // Everything else passes through: this repairs one marker, not the config.
    expect(next?.enterprise).toEqual({ mode: "enforce" });
    expect(changes.some((change) => change.includes("meta.lastTouchedVersion"))).toBe(true);
  });
});
