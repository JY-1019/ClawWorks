// Skill environment override helpers expose safe env vars requested by active skills.
import { sanitizeEnvVars, validateEnvVarValue } from "../../agents/sandbox/sanitize-env-vars.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
} from "../../infra/host-env-security.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSkillConfig } from "../loading/config.js";
import { resolveSkillKey } from "../loading/frontmatter.js";
import { resolveSkillRuntimeConfig } from "../loading/runtime-config.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";

const log = createSubsystemLogger("env-overrides");

type EnvUpdate = { key: string; skillName: string };
type SkillConfig = NonNullable<ReturnType<typeof resolveSkillConfig>>;
type ActiveSkillEnvEntry = {
  baseline: string | undefined;
  value: string;
  count: number;
  /**
   * Which skills asked for this key, by the name a workflow grant uses, with a
   * count each. Needed because the environment is PROCESS-wide and shared by
   * concurrent runs: a run whose work-map withholds a skill has to be able to
   * recognize the keys that skill owns even when another run injected them.
   */
  owners: Map<string, number>;
  /**
   * The skill whose value is actually in the environment — the FIRST acquirer,
   * since a later one does not overwrite it. Two skills can want the same key
   * with different secrets, so "some owner is granted" would hand a granted
   * skill's run the withheld skill's value.
   */
  valueOwner: string;
};

/**
 * Tracks env var keys that are currently injected by skill overrides.
 * Used by ACP harness spawn to strip skill-injected keys so they don't
 * leak to child processes (e.g., OPENAI_API_KEY leaking to Codex CLI).
 * @see https://github.com/openclaw/openclaw/issues/36280
 */
const activeSkillEnvEntries = new Map<string, ActiveSkillEnvEntry>();

/** Returns a snapshot of env var keys currently injected by skill overrides. */
export function getActiveSkillEnvKeys(): ReadonlySet<string> {
  return new Set(activeSkillEnvEntries.keys());
}

/**
 * Injected keys that belong ONLY to skills outside this grant.
 *
 * The environment is process-wide and outlives one run, so skipping the
 * injection is not enough on its own: a concurrent run that granted the skill may
 * have put the key there already, and a child process started for THIS run copies
 * whatever `process.env` holds. Callers that hand an environment to a subprocess
 * subtract these (the ACP client strips every skill key the same way).
 *
 * A key whose value belongs to a granted skill is NOT listed: it is legitimately
 * part of this run's environment. When two skills want the same key, the value in
 * the environment is the first acquirer's, so that is the owner this reads —
 * sharing a key with a granted skill must not launder a withheld skill's secret.
 */
export function resolveSkillEnvKeysOutsideGrant(
  allowedSkills: readonly string[] | undefined,
): string[] {
  if (!allowedSkills) {
    return [];
  }
  const granted = new Set(allowedSkills);
  // The VALUE's owner decides, not any owner: the environment holds one secret
  // per key, and it belongs to whoever put it there.
  return [...activeSkillEnvEntries.entries()]
    .filter(([, entry]) => !granted.has(entry.valueOwner))
    .map(([key]) => key);
}

function addOwner(owners: Map<string, number>, skillName: string) {
  owners.set(skillName, (owners.get(skillName) ?? 0) + 1);
}

function acquireActiveSkillEnvKey(key: string, value: string, skillName: string): boolean {
  const active = activeSkillEnvEntries.get(key);
  if (active) {
    active.count += 1;
    addOwner(active.owners, skillName);
    if (process.env[key] === undefined) {
      process.env[key] = active.value;
    }
    return true;
  }
  if (process.env[key] !== undefined) {
    return false;
  }
  activeSkillEnvEntries.set(key, {
    baseline: process.env[key],
    value,
    count: 1,
    owners: new Map([[skillName, 1]]),
    valueOwner: skillName,
  });
  return true;
}

function releaseActiveSkillEnvKey(key: string, skillName: string) {
  const active = activeSkillEnvEntries.get(key);
  if (!active) {
    return;
  }
  active.count -= 1;
  const owned = (active.owners.get(skillName) ?? 0) - 1;
  if (owned > 0) {
    active.owners.set(skillName, owned);
  } else {
    active.owners.delete(skillName);
  }
  if (active.count > 0) {
    if (process.env[key] === undefined) {
      process.env[key] = active.value;
    }
    return;
  }
  activeSkillEnvEntries.delete(key);
  if (active.baseline === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = active.baseline;
  }
}

type SanitizedSkillEnvOverrides = {
  allowed: Record<string, string>;
  blocked: string[];
  warnings: string[];
};

// Always block skill env overrides that can alter runtime loading or host execution behavior.
const SKILL_ALWAYS_BLOCKED_ENV_PATTERNS: ReadonlyArray<RegExp> = [/^OPENSSL_CONF$/i];

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function isAlwaysBlockedSkillEnvKey(key: string): boolean {
  return (
    isDangerousHostEnvVarName(key) ||
    isDangerousHostEnvOverrideVarName(key) ||
    matchesAnyPattern(key, SKILL_ALWAYS_BLOCKED_ENV_PATTERNS)
  );
}

function sanitizeSkillEnvOverrides(params: {
  overrides: Record<string, string>;
  allowedSensitiveKeys: Set<string>;
}): SanitizedSkillEnvOverrides {
  if (Object.keys(params.overrides).length === 0) {
    return { allowed: {}, blocked: [], warnings: [] };
  }

  const result = sanitizeEnvVars(params.overrides);
  const allowed: Record<string, string> = {};
  const blocked = new Set<string>();
  const warnings = [...result.warnings];

  for (const [key, value] of Object.entries(result.allowed)) {
    if (isAlwaysBlockedSkillEnvKey(key)) {
      blocked.add(key);
      continue;
    }
    allowed[key] = value;
  }

  for (const key of result.blocked) {
    if (isAlwaysBlockedSkillEnvKey(key) || !params.allowedSensitiveKeys.has(key)) {
      blocked.add(key);
      continue;
    }
    const value = params.overrides[key];
    if (!value) {
      continue;
    }
    const warning = validateEnvVarValue(value);
    if (warning) {
      if (warning === "Contains null bytes") {
        blocked.add(key);
        continue;
      }
      warnings.push(`${key}: ${warning}`);
    }
    allowed[key] = value;
  }

  return { allowed, blocked: [...blocked], warnings };
}

function applySkillConfigEnvOverrides(params: {
  updates: EnvUpdate[];
  skillConfig: SkillConfig;
  primaryEnv?: string | null;
  requiredEnv?: string[] | null;
  skillKey: string;
  /** The skill's own name, which is what a workflow grant lists. */
  skillName: string;
}) {
  const { updates, skillConfig, primaryEnv, requiredEnv, skillKey } = params;
  const allowedSensitiveKeys = new Set<string>();
  const normalizedPrimaryEnv = primaryEnv?.trim();
  if (normalizedPrimaryEnv) {
    allowedSensitiveKeys.add(normalizedPrimaryEnv);
  }
  for (const envName of requiredEnv ?? []) {
    const trimmedEnv = envName.trim();
    if (trimmedEnv) {
      allowedSensitiveKeys.add(trimmedEnv);
    }
  }

  const pendingOverrides: Record<string, string> = {};
  if (skillConfig.env) {
    for (const [rawKey, envValue] of Object.entries(skillConfig.env)) {
      const envKey = rawKey.trim();
      const hasExternallyManagedValue =
        process.env[envKey] !== undefined && !activeSkillEnvEntries.has(envKey);
      if (!envKey || !envValue || hasExternallyManagedValue) {
        continue;
      }
      pendingOverrides[envKey] = envValue;
    }
  }

  const canInjectPrimaryEnv =
    normalizedPrimaryEnv &&
    (process.env[normalizedPrimaryEnv] === undefined ||
      activeSkillEnvEntries.has(normalizedPrimaryEnv));
  if (canInjectPrimaryEnv && !pendingOverrides[normalizedPrimaryEnv]) {
    const resolvedApiKey =
      normalizeResolvedSecretInputString({
        value: skillConfig.apiKey,
        path: `skills.entries.${skillKey}.apiKey`,
      }) ?? "";
    if (resolvedApiKey) {
      pendingOverrides[normalizedPrimaryEnv] = resolvedApiKey;
    }
  }

  const sanitized = sanitizeSkillEnvOverrides({
    overrides: pendingOverrides,
    allowedSensitiveKeys,
  });

  if (sanitized.blocked.length > 0) {
    log.warn(`Blocked skill env overrides for ${skillKey}: ${sanitized.blocked.join(", ")}`);
  }
  if (sanitized.warnings.length > 0) {
    log.warn(`Suspicious skill env overrides for ${skillKey}: ${sanitized.warnings.join(", ")}`);
  }

  for (const [envKey, envValue] of Object.entries(sanitized.allowed)) {
    if (!acquireActiveSkillEnvKey(envKey, envValue, params.skillName)) {
      continue;
    }
    updates.push({ key: envKey, skillName: params.skillName });
    process.env[envKey] = activeSkillEnvEntries.get(envKey)?.value ?? envValue;
  }
}

function shouldApplySkillConfigEnvOverrides(skillConfig: SkillConfig): boolean {
  return skillConfig.enabled !== false;
}

function createEnvReverter(updates: EnvUpdate[]) {
  return () => {
    for (const update of updates) {
      releaseActiveSkillEnvKey(update.key, update.skillName);
    }
  };
}

/**
 * Skill names a governed run may use, or undefined for "no restriction".
 *
 * These overrides put a skill's credentials into the PROCESS environment, where
 * any allowed tool call or subprocess can read them — so a work-map that
 * withholds a skill has to withhold its secrets too, not merely hide it from the
 * catalog (enterpriseRunGrantedSkills).
 */
function skillEnvGrantFilter(
  allowedSkills: readonly string[] | undefined,
): (name: string) => boolean {
  if (!allowedSkills) {
    return () => true;
  }
  const granted = new Set(allowedSkills);
  return (name) => granted.has(name);
}

export function applySkillEnvOverrides(params: {
  skills: SkillEntry[];
  config?: OpenClawConfig;
  allowedSkills?: readonly string[];
}) {
  const { skills } = params;
  const config = resolveSkillRuntimeConfig(params.config);
  const isGranted = skillEnvGrantFilter(params.allowedSkills);
  const updates: EnvUpdate[] = [];

  for (const entry of skills) {
    // By skill NAME, the same identity the catalog and the CLI plugin filter use;
    // the config key below can differ (resolveSkillKey), and matching on that
    // would let a renamed key slip an ungranted skill's secrets through.
    if (!isGranted(entry.skill.name)) {
      continue;
    }
    const skillKey = resolveSkillKey(entry.skill, entry);
    const skillConfig = resolveSkillConfig(config, skillKey);
    if (!skillConfig) {
      continue;
    }
    if (!shouldApplySkillConfigEnvOverrides(skillConfig)) {
      continue;
    }

    applySkillConfigEnvOverrides({
      updates,
      skillConfig,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env,
      skillKey,
      skillName: entry.skill.name,
    });
  }

  return createEnvReverter(updates);
}

export function applySkillEnvOverridesFromSnapshot(params: {
  snapshot?: SkillSnapshot;
  config?: OpenClawConfig;
  allowedSkills?: readonly string[];
}) {
  const { snapshot } = params;
  const config = resolveSkillRuntimeConfig(params.config);
  if (!snapshot) {
    return () => {};
  }
  const isGranted = skillEnvGrantFilter(params.allowedSkills);
  const updates: EnvUpdate[] = [];

  for (const skill of snapshot.skills) {
    if (!isGranted(skill.name)) {
      continue;
    }
    const skillConfig = resolveSkillConfig(config, skill.name);
    if (!skillConfig) {
      continue;
    }
    if (!shouldApplySkillConfigEnvOverrides(skillConfig)) {
      continue;
    }

    applySkillConfigEnvOverrides({
      updates,
      skillConfig,
      primaryEnv: skill.primaryEnv,
      requiredEnv: skill.requiredEnv,
      skillKey: skill.name,
      skillName: skill.name,
    });
  }

  return createEnvReverter(updates);
}
