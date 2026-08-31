import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
// Config metadata migration for the ClawWorks version line.
//
// ClawWorks forked OpenClaw onto its own version line, and `meta.lastTouchedVersion`
// still holds whatever wrote the config last. Upstream OpenClaw is calendar
// versioned (`2026.6.10`), ClawWorks is not (`0.1.0-beta.1`), so every comparison
// reads the fork as a DOWNGRADE — and the future-version guard
// (src/config/future-version-guard.ts) does not merely warn about that: it refuses
// to start or restart the gateway service. A config carried across the fork
// therefore leaves the gateway unstartable, with no way back that does not involve
// the escape env var.
//
// Deleting the marker is the whole repair. It is auto-managed
// (AUTO_MANAGED_CONFIG_META_FIELDS in src/config/io.meta.ts) and the very next
// config write stamps it with the running version, so the config self-heals onto
// this line instead of carrying a marker from a product line this binary knows
// nothing about.
import { parseOpenClawVersion } from "../../../config/version.js";
import { VERSION } from "../../../version.js";

/**
 * Lowest major that can only be a calendar version.
 *
 * Upstream OpenClaw stamps `YYYY.M.PATCH`; no semver line reaches a major this
 * high, so the two lines are told apart by magnitude alone — which keeps the
 * check working without a list of released upstream versions to maintain.
 */
const CALENDAR_VERSION_MIN_MAJOR = 2000;

function isCalendarVersion(raw: unknown): boolean {
  const parsed = typeof raw === "string" ? parseOpenClawVersion(raw) : null;
  return parsed !== null && parsed.major >= CALENDAR_VERSION_MIN_MAJOR;
}

/**
 * True when `touched` was written by a calendar-versioned upstream build and
 * `current` is not one.
 *
 * Deliberately narrow: a downgrade WITHIN either line still leaves the marker
 * alone, so the guard keeps protecting the case it was built for — an older
 * binary opening a config a newer one already migrated.
 */
export function isCrossLineTouchedVersion(touched: unknown, current: string = VERSION): boolean {
  return isCalendarVersion(touched) && !isCalendarVersion(current);
}

const CROSS_LINE_TOUCHED_VERSION_RULE: LegacyConfigRule = {
  path: ["meta", "lastTouchedVersion"],
  message:
    'meta.lastTouchedVersion was written by a calendar-versioned OpenClaw build, which this ClawWorks binary reads as a downgrade and refuses to start the gateway for. Run "openclaw doctor --fix".',
  match: (value) => isCrossLineTouchedVersion(value),
  requireSourceLiteral: true,
};

/** Legacy config migration specs for config metadata. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_META: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "meta.lastTouchedVersion-cross-line",
    describe: "Drop meta.lastTouchedVersion written by a calendar-versioned OpenClaw build",
    legacyRules: [CROSS_LINE_TOUCHED_VERSION_RULE],
    apply: (raw, changes) => {
      const meta = getRecord(raw.meta);
      if (!meta || !isCrossLineTouchedVersion(meta.lastTouchedVersion)) {
        return;
      }
      const touched = meta.lastTouchedVersion;
      delete meta.lastTouchedVersion;
      changes.push(
        `Dropped meta.lastTouchedVersion (${String(touched)}); it was written by a different version line and blocked the gateway from starting.`,
      );
    },
  }),
];
