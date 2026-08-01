/**
 * Narrowing a run's skill SNAPSHOT to what its work-map grants.
 *
 * Split from enterprise-skill-scope.ts because rebuilding the catalog needs the
 * skills loader, and that scope module is exported to plugin harnesses.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildSkillsCatalogPrompt,
  buildWorkspaceSkillsPrompt,
} from "../skills/loading/workspace.js";
import type { SkillSnapshot } from "../skills/types.js";
import { resolveRunSkillGrant } from "./enterprise-skill-scope.js";

/**
 * The run's snapshot with the withheld skills removed, or the original when
 * nothing is narrowed.
 *
 * Applied once, where the runner still owns the snapshot, because a plugin-owned
 * HARNESS builds its own prompt straight from `skillsSnapshot.prompt` and never
 * passes through the catalog resolver — a governed Codex run would otherwise be
 * offered every skill the agent has. The runner-side resolvers narrow again for
 * what they rebuild from entries (sandbox paths); doing both is idempotent.
 *
 * A reused persisted snapshot (a scheduled turn has one) carries the catalog
 * without the `resolvedSkills` it was built from. Reuse exists to avoid
 * re-scanning the workspace every turn, so that scan happens HERE only for a
 * governed run — and if there is no workspace to scan, the catalog is emptied
 * rather than handed over whole: deny-by-default is the contract.
 *
 * One limit: the skill-instruction budget was already computed from the ORIGINAL
 * catalog by the time this runs (see applyEnterpriseMediation), so a run that
 * withholds most of a large catalog leaves the appendix less room than its final
 * prompt would allow. Conservative in the safe direction — fewer inlined bodies,
 * never a bigger prompt than the operator's caps.
 */
export function narrowRunSkillsSnapshot<T extends SkillSnapshot | undefined>(params: {
  runId?: string;
  skillsSnapshot: T;
  workspaceDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): T {
  const snapshot = params.skillsSnapshot;
  if (!snapshot) {
    return params.skillsSnapshot;
  }
  const grant = resolveRunSkillGrant({ ...params, skillsSnapshot: snapshot });
  if (!grant) {
    return params.skillsSnapshot;
  }
  const granted = new Set(grant);
  const resolved = snapshot.resolvedSkills;
  if (!resolved) {
    // Rebuilt through the workspace builder, not by hand: it applies this agent's
    // own filter, drops the skills whose frontmatter hides them from the model,
    // and honors the operator's catalog limits — all of which a governed rebuild
    // must keep. With no workspace to load from, the catalog is emptied instead
    // of handed over whole.
    return {
      ...snapshot,
      // Same as below: the name/env metadata stays whole so the withheld skills
      // are still recognizable to the credential filter.
      prompt: params.workspaceDir
        ? buildWorkspaceSkillsPrompt(params.workspaceDir, {
            skillFilter: [...granted],
            ...(params.config ? { config: params.config } : {}),
            ...(params.agentId ? { agentId: params.agentId } : {}),
          }).trim()
        : "",
    } as T;
  }
  const keptSkills = resolved.filter((skill) => granted.has(skill.name));
  if (keptSkills.length === resolved.length) {
    return params.skillsSnapshot;
  }
  return {
    ...snapshot,
    // `skills` deliberately keeps EVERY name: it is env metadata (primaryEnv /
    // requiredEnv), and the credential withholding downstream needs to know what a
    // WITHHELD skill declares — a warm subprocess may still hold that key. Only
    // the model-facing catalog narrows.
    resolvedSkills: keptSkills,
    // The same builder the stock catalog uses, so a governed run's block differs
    // from a plain one only by the skills it withholds.
    // The operator's catalog limits apply to a governed run too, so the same
    // config and agent the original snapshot was built with are passed back in.
    prompt: buildSkillsCatalogPrompt({
      skills: keptSkills,
      ...(params.config ? { config: params.config } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    }).trim(),
  } as T;
}
