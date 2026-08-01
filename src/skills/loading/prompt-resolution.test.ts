// Prompt resolution tests cover skill prompt lookup and active skill selection.
import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { resolveSkillsPromptForRun } from "./workspace.js";

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      }),
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", () => {
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
        disableModelInvocation: true,
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("inherits agents.defaults.skills when rebuilding prompt for an agent", () => {
    const visible: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        baseDir: "/app/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [visible, hidden],
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).toContain("/app/skills/github/SKILL.md");
    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("uses agents.list[].skills as a full replacement for defaults", () => {
    const inheritedEntry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "weather",
        description: "Weather",
        filePath: "/app/skills/weather/SKILL.md",
        baseDir: "/app/skills/weather",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const explicitEntry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "docs-search",
        description: "Docs",
        filePath: "/app/skills/docs-search/SKILL.md",
        baseDir: "/app/skills/docs-search",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [inheritedEntry, explicitEntry],
      config: {
        agents: {
          defaults: {
            skills: ["weather"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).not.toContain("/app/skills/weather/SKILL.md");
    expect(prompt).toContain("/app/skills/docs-search/SKILL.md");
  });

  describe("allowedSkills (workflow grant)", () => {
    const granted = createCanonicalFixtureSkill({
      name: "refund-playbook",
      description: "Refunds",
      filePath: "/app/skills/refund-playbook/SKILL.md",
      baseDir: "/app/skills/refund-playbook",
      source: "openclaw-workspace",
    });
    const ungranted = createCanonicalFixtureSkill({
      name: "deploy-runbook",
      description: "Deploys",
      filePath: "/app/skills/deploy-runbook/SKILL.md",
      baseDir: "/app/skills/deploy-runbook",
      source: "openclaw-workspace",
    });

    it("rebuilds the snapshot catalog with only the granted skills", () => {
      const prompt = resolveSkillsPromptForRun({
        skillsSnapshot: {
          prompt: "SNAPSHOT",
          skills: [{ name: granted.name }, { name: ungranted.name }],
          resolvedSkills: [granted, ungranted],
        },
        workspaceDir: "/tmp/openclaw",
        allowedSkills: ["refund-playbook"],
      });

      expect(prompt).toContain("/app/skills/refund-playbook/SKILL.md");
      expect(prompt).not.toContain("/app/skills/deploy-runbook/SKILL.md");
      expect(prompt).not.toBe("SNAPSHOT");
    });

    it("empties the catalog when the work-map grants no skill", () => {
      const prompt = resolveSkillsPromptForRun({
        skillsSnapshot: {
          prompt: "SNAPSHOT",
          skills: [{ name: granted.name }],
          resolvedSkills: [granted],
        },
        workspaceDir: "/tmp/openclaw",
        allowedSkills: [],
      });

      expect(prompt).toBe("");
    });

    it("narrows entries too, so a sandbox run is governed like a plain one", () => {
      const prompt = resolveSkillsPromptForRun({
        entries: [
          { skill: granted, frontmatter: {} },
          { skill: ungranted, frontmatter: {} },
        ],
        workspaceDir: "/tmp/openclaw",
        allowedSkills: ["refund-playbook"],
      });

      expect(prompt).toContain("/app/skills/refund-playbook/SKILL.md");
      expect(prompt).not.toContain("/app/skills/deploy-runbook/SKILL.md");
    });

    it("leaves the snapshot prompt untouched without a grant", () => {
      const prompt = resolveSkillsPromptForRun({
        skillsSnapshot: {
          prompt: "SNAPSHOT",
          skills: [{ name: granted.name }],
          resolvedSkills: [granted],
        },
        workspaceDir: "/tmp/openclaw",
      });

      expect(prompt).toBe("SNAPSHOT");
    });
  });
});
