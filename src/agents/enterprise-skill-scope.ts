/**
 * One run's effective skill scope, for every surface that hands skills to a
 * model or a subprocess.
 *
 * The work-map's grant is a list of NAMES an operator wrote; what a run can
 * actually use is that list intersected with the skills the run resolved for its
 * agent. Both halves matter: the catalog must not offer a name the agent lacks,
 * and the credential strip must not keep a key alive just because a work-map
 * named a skill this agent never had.
 *
 * Deliberately light — it is exported to plugin-owned harnesses, so it stays
 * clear of the skills LOADER (see enterprise-skill-snapshot.ts for the catalog
 * rebuild, which needs it).
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enterpriseRunGrantedSkills } from "../enterprise/active-runs.js";
import { resolveSkillEnvKeysOutsideGrant } from "../skills/runtime/env-overrides.js";

/**
 * The parts of a skill snapshot this scope reads: names, plus the env a skill
 * declares. The env metadata matters for withholding — see
 * resolveRunWithheldSkillEnvKeys.
 */
export type RunSkillScopeSnapshot = {
  skills?: ReadonlyArray<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  resolvedSkills?: ReadonlyArray<{ name: string }>;
};

/**
 * Skill names this run may use, or null for "do not narrow" (unmediated run, or
 * a work-map that does not grant explicitly).
 *
 * An empty array is a real answer: a work-map that grants explicitly and attaches
 * nothing reaches no skill.
 */
export function resolveRunSkillGrant(params: {
  runId?: string;
  skillsSnapshot?: RunSkillScopeSnapshot;
}): readonly string[] | null {
  const granted = enterpriseRunGrantedSkills(params.runId);
  if (!granted) {
    return null;
  }
  // Both lists, because they describe the same set from different states: a
  // persisted snapshot carries the names without the resolved entries.
  const available = params.skillsSnapshot
    ? new Set([
        ...(params.skillsSnapshot.skills ?? []).map((skill) => skill.name),
        ...(params.skillsSnapshot.resolvedSkills ?? []).map((skill) => skill.name),
      ])
    : null;
  // A snapshot that resolved to NOTHING is still authoritative: the run has no
  // skills, so nothing it named is usable and no key can be spared for one.
  return available ? granted.filter((name) => available.has(name)) : granted;
}

/**
 * Env keys a subprocess started for this run must not inherit: everything a skill
 * outside this run's grant can own.
 *
 * Two sources, and both are needed. The ACTIVE overrides cover a key a concurrent
 * run injected right now. The DECLARED env of each withheld skill covers the
 * harder case: a long-lived child (a warm Codex app-server) that inherited the key
 * from an earlier run and keeps it after that run restored the gateway
 * environment — by then nothing is active to find, yet the secret is still inside
 * the reused process. Declared keys are stable, so they also make a governed run's
 * launch options differ, which is what keeps it off that warm process.
 *
 * Empty for an ungoverned run.
 */
export function resolveRunWithheldSkillEnvKeys(params: {
  runId?: string;
  skillsSnapshot?: RunSkillScopeSnapshot;
  config?: OpenClawConfig;
}): string[] {
  const grant = resolveRunSkillGrant(params);
  if (!grant) {
    return [];
  }
  const granted = new Set(grant);
  const keys = new Set(resolveSkillEnvKeysOutsideGrant(grant));
  for (const skill of params.skillsSnapshot?.skills ?? []) {
    if (granted.has(skill.name)) {
      continue;
    }
    for (const key of [
      skill.primaryEnv,
      ...(skill.requiredEnv ?? []),
      ...Object.keys(params.config?.skills?.entries?.[skill.name]?.env ?? {}),
    ]) {
      const trimmed = key?.trim();
      if (trimmed) {
        keys.add(trimmed);
      }
    }
  }
  return [...keys];
}
