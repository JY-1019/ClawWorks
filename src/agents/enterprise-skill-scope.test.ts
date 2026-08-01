import { afterEach, describe, expect, it } from "vitest";
import {
  clearEnterpriseActiveRunsForTest,
  registerEnterpriseActiveRun,
} from "../enterprise/active-runs.js";
import type { EnterpriseRunPlan } from "../enterprise/types.js";
import { resolveRunSkillGrant, resolveRunWithheldSkillEnvKeys } from "./enterprise-skill-scope.js";

function governedRun(params: { runId: string; grantedSkills: string[] }) {
  const plan: EnterpriseRunPlan = {
    runId: params.runId,
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    matchedBy: "planner",
    requestSummary: "help",
    nodes: [{ nodeId: "support", parentId: null, seq: 0, title: "Support", ontology: {} }],
    activeNodeId: "support",
    capabilityGrants: "explicit",
    grantedSkills: params.grantedSkills,
    mcpGoverned: true,
    mode: "enforce",
    createdAt: 0,
  };
  registerEnterpriseActiveRun({ plan, policies: [] });
}

afterEach(() => {
  clearEnterpriseActiveRunsForTest();
});

describe("resolveRunSkillGrant", () => {
  it("intersects the work-map's names with the skills this agent has", () => {
    // A work-map may name a skill this agent filtered out or never installed;
    // keeping that name would make the credential strip spare a key the run
    // cannot use anyway.
    governedRun({ runId: "run-grant", grantedSkills: ["triage", "not-installed"] });

    expect(
      resolveRunSkillGrant({
        runId: "run-grant",
        skillsSnapshot: { skills: [{ name: "triage" }, { name: "summarize" }] },
      }),
    ).toEqual(["triage"]);
  });

  it("keeps the raw grant when the run has no snapshot to intersect with", () => {
    governedRun({ runId: "run-no-snapshot", grantedSkills: ["triage"] });

    expect(resolveRunSkillGrant({ runId: "run-no-snapshot" })).toEqual(["triage"]);
  });

  it("narrows nothing for a run no work-map governs", () => {
    expect(
      resolveRunSkillGrant({
        runId: "run-unknown",
        skillsSnapshot: { skills: [{ name: "triage" }] },
      }),
    ).toBeNull();
  });
});

describe("resolveRunSkillGrant with an empty snapshot", () => {
  it("grants nothing when the run resolved no skills at all", () => {
    // A provided snapshot is authoritative even when empty: nothing the work-map
    // named is usable, so no credential may be spared for one of those names.
    governedRun({ runId: "run-empty-snapshot", grantedSkills: ["triage"] });

    expect(
      resolveRunSkillGrant({
        runId: "run-empty-snapshot",
        skillsSnapshot: { skills: [], resolvedSkills: [] },
      }),
    ).toEqual([]);
  });
});

describe("resolveRunWithheldSkillEnvKeys", () => {
  it("names a withheld skill's declared keys even when nothing injected them", () => {
    // The case a long-lived child creates: an earlier run put the key inside a
    // warm process and then restored the gateway environment, so by now no
    // override is active — yet the secret is still in that process. Declared keys
    // are stable, so they also keep a governed run off that warm process.
    governedRun({ runId: "run-withheld-declared", grantedSkills: ["triage"] });

    const keys = resolveRunWithheldSkillEnvKeys({
      runId: "run-withheld-declared",
      skillsSnapshot: {
        skills: [
          { name: "triage", primaryEnv: "TRIAGE_TOKEN" },
          { name: "billing", primaryEnv: "ACME_TOKEN", requiredEnv: ["ACME_REGION"] },
        ],
      },
      config: {
        skills: { entries: { billing: { env: { ACME_EXTRA: "x" } } } },
      } as Parameters<typeof resolveRunWithheldSkillEnvKeys>[0]["config"],
    });

    expect(keys.toSorted()).toEqual(["ACME_EXTRA", "ACME_REGION", "ACME_TOKEN"]);
    // The granted skill keeps its own key.
    expect(keys).not.toContain("TRIAGE_TOKEN");
  });

  it("withholds nothing for a run no work-map governs", () => {
    expect(
      resolveRunWithheldSkillEnvKeys({
        runId: "run-ungoverned",
        skillsSnapshot: { skills: [{ name: "billing", primaryEnv: "ACME_TOKEN" }] },
      }),
    ).toEqual([]);
  });
});

describe("narrowRunSkillsSnapshot keeps env metadata", () => {
  it("leaves the withheld skills' env declarations readable after narrowing", async () => {
    // The credential filter runs LATER, on the narrowed snapshot: if narrowing
    // dropped the withheld names, a warm subprocess would keep their keys with
    // nothing left to name them.
    const { narrowRunSkillsSnapshot } = await import("./enterprise-skill-snapshot.js");
    governedRun({ runId: "run-narrow-env", grantedSkills: ["triage"] });
    const skill = (name: string) => ({
      name,
      description: name,
      filePath: `/skills/${name}/SKILL.md`,
      baseDir: `/skills/${name}`,
      source: "test",
      sourceInfo: {
        path: `/skills/${name}/SKILL.md`,
        source: "test",
        scope: "temporary" as const,
        origin: "top-level" as const,
      },
      disableModelInvocation: false,
    });

    const narrowed = narrowRunSkillsSnapshot({
      runId: "run-narrow-env",
      skillsSnapshot: {
        prompt: "CATALOG",
        skills: [
          { name: "triage", primaryEnv: "TRIAGE_TOKEN" },
          { name: "billing", primaryEnv: "ACME_TOKEN" },
        ],
        resolvedSkills: [skill("triage"), skill("billing")],
      },
    });

    expect(narrowed?.resolvedSkills?.map((entry) => entry.name)).toEqual(["triage"]);
    expect(narrowed?.skills.map((entry) => entry.name)).toEqual(["triage", "billing"]);
    expect(
      resolveRunWithheldSkillEnvKeys({ runId: "run-narrow-env", skillsSnapshot: narrowed }),
    ).toContain("ACME_TOKEN");
  });
});
