import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildEnterpriseRunPlan } from "./plan.js";
import {
  collectPlanDeclaredSkills,
  resolveEnterpriseSkillInstructions,
} from "./skill-instructions.js";
import type { WorkflowTreeDefinition } from "./types.js";

const dir = mkdtempSync(path.join(tmpdir(), "skill-instructions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeSkill(name: string, body: string): { filePath: string; baseDir: string } {
  const baseDir = path.join(dir, name);
  mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  writeFileSync(filePath, `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
  return { filePath, baseDir };
}

function planWith(skills: Record<string, string[]>): ReturnType<typeof buildEnterpriseRunPlan> {
  const tree: WorkflowTreeDefinition = {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.desk",
    version: "1.0.0",
    name: "Desk",
    match: { triggers: ["user"] },
    root: {
      id: "desk",
      title: "Handle a request",
      ontology: { allowedTools: ["message"] },
      children: Object.entries(skills).map(([id, names]) => ({
        id: `desk.${id}`,
        title: id,
        ontology: { skills: names },
      })),
    },
  };
  return buildEnterpriseRunPlan({
    runId: "run-skill-instructions",
    requestText: "hello",
    mode: "enforce",
    tree,
    matchedBy: "planner",
  });
}

describe("resolveEnterpriseSkillInstructions", () => {
  it("inlines the SKILL.md body, without its frontmatter", async () => {
    const triage = writeSkill("triage", "# Triage\n\nAsk for the order id first.");
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["triage"] }),
      available: [{ name: "triage", ...triage }],
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe("triage");
    expect(resolved[0].instructions).toContain("Ask for the order id first.");
    // The frontmatter is metadata for the loader, not instructions for the model.
    expect(resolved[0].instructions).not.toContain("description: d");
  });

  it("cannot surface a skill the agent does not have", async () => {
    // The containment boundary: a work-map declaration narrows what the model is
    // pointed at; it must never add a skill the agent's own filter excluded.
    const allowed = writeSkill("allowed", "Allowed body.");
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["allowed", "not-installed"] }),
      available: [{ name: "allowed", ...allowed }],
    });
    expect(resolved.map((skill) => skill.name)).toEqual(["allowed"]);
  });

  it("resolves nothing when the caller had no snapshot", async () => {
    // No snapshot means no candidate set, so there is nothing to intersect
    // against — and discovering one here would put a scan on the run path.
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["triage"] }),
    });
    expect(resolved).toEqual([]);
  });

  it("does not read anything when no step declares a skill", async () => {
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: [] }),
      available: [
        { name: "triage", filePath: path.join(dir, "x", "SKILL.md"), baseDir: path.join(dir, "x") },
      ],
    });
    expect(resolved).toEqual([]);
  });

  it("skips a declared skill whose file is gone instead of failing the run", async () => {
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["missing"] }),
      available: [
        {
          name: "missing",
          filePath: path.join(dir, "gone", "SKILL.md"),
          baseDir: path.join(dir, "gone"),
        },
      ],
    });
    expect(resolved).toEqual([]);
  });

  it("bounds a long skill so it cannot crowd out the workflow guidance", async () => {
    const long = writeSkill("long", "x".repeat(20_000));
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["long"] }),
      available: [{ name: "long", ...long }],
    });
    expect(resolved[0].instructions.length).toBeLessThanOrEqual(4000);
    expect(resolved[0].instructions.endsWith("…")).toBe(true);
  });

  it("orders by name so the same work-map produces the same prompt bytes", async () => {
    const b = writeSkill("beta", "Beta body.");
    const a = writeSkill("alpha", "Alpha body.");
    const resolved = await resolveEnterpriseSkillInstructions({
      // Declared on separate steps and out of order on purpose.
      plan: planWith({ second: ["beta"], first: ["alpha"] }),
      available: [
        { name: "beta", ...b },
        { name: "alpha", ...a },
      ],
    });
    expect(resolved.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  });

  it("refuses a SKILL.md rebound to a file outside the skill directory", async () => {
    // Without the root boundary this copies arbitrary host-file contents into the
    // system prompt, which then leaves for the model provider.
    const secret = path.join(dir, "outside-secret.txt");
    writeFileSync(secret, "PRIVATE HOST CONTENT");
    const baseDir = path.join(dir, "escaping");
    mkdirSync(baseDir, { recursive: true });
    const filePath = path.join(baseDir, "SKILL.md");
    symlinkSync(secret, filePath);
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["escaping"] }),
      available: [{ name: "escaping", filePath, baseDir }],
    });
    expect(resolved).toEqual([]);
  });

  it("keeps a skill whose frontmatter strict YAML would reject", async () => {
    // The skills loader is tolerant here, so parsing frontmatter to find the body
    // would drop instructions for a skill the loader itself accepted.
    const baseDir = path.join(dir, "loose");
    mkdirSync(baseDir, { recursive: true });
    const filePath = path.join(baseDir, "SKILL.md");
    writeFileSync(
      filePath,
      "---\nname: loose\ndescription: Do this: then that\n---\n\nBody kept.\n",
    );
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["loose"] }),
      available: [{ name: "loose", filePath, baseDir }],
    });
    expect(resolved.map((skill) => skill.name)).toEqual(["loose"]);
    expect(resolved[0].instructions).toBe("Body kept.");
  });

  it("closes a code fence the truncation budget cut open", async () => {
    // Several bundled skills exceed the per-skill budget. An unclosed fence would
    // swallow the next skill's heading and body into one code block.
    const fenced = writeSkill("fenced", `Intro.\n\n\`\`\`sh\n${"echo hi\n".repeat(900)}`);
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["fenced"] }),
      available: [{ name: "fenced", ...fenced }],
    });
    const fences = resolved[0].instructions.match(/^```/gm) ?? [];
    expect(fences.length % 2).toBe(0);
    expect(resolved[0].instructions.endsWith("```")).toBe(true);
  });

  it("closes a four-backtick fence with a four-backtick closer", async () => {
    // CommonMark: a closer must be at least as long as the opener, so three
    // backticks would leave a four-backtick block open.
    const wide = writeSkill("wide", `Intro.\n\n\`\`\`\`sh\n${"echo hi\n".repeat(900)}`);
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["wide"] }),
      available: [{ name: "wide", ...wide }],
    });
    expect(resolved[0].instructions.endsWith("````")).toBe(true);
  });

  it("closes a tilde fence with a tilde closer", async () => {
    const tilde = writeSkill("tilde", `Intro.\n\n~~~sh\n${"echo hi\n".repeat(900)}`);
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["tilde"] }),
      available: [{ name: "tilde", ...tilde }],
    });
    expect(resolved[0].instructions.endsWith("~~~")).toBe(true);
  });

  it("finds the body of a BOM-prefixed SKILL.md", async () => {
    // The loader accepts a BOM; without stripping it the frontmatter fence is
    // missed and the whole document is treated as instructions.
    const baseDir = path.join(dir, "bom");
    mkdirSync(baseDir, { recursive: true });
    const filePath = path.join(baseDir, "SKILL.md");
    writeFileSync(filePath, "\uFEFF---\nname: bom\ndescription: d\n---\n\nBody after BOM.\n");
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["bom"] }),
      available: [{ name: "bom", filePath, baseDir }],
    });
    expect(resolved[0].instructions).toBe("Body after BOM.");
  });

  it("closes an open fence even when the body was not truncated", async () => {
    // Legal at the end of a standalone file, but these bodies are concatenated:
    // an open fence would absorb the next skill's heading and body.
    const short = writeSkill("short-open", "Intro.\n\n```sh\necho hi");
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["short-open"] }),
      available: [{ name: "short-open", ...short }],
    });
    expect(resolved[0].instructions.length).toBeLessThan(4000);
    expect(resolved[0].instructions.endsWith("```")).toBe(true);
  });

  it("does not mistake a backticked run inside prose for a closing fence", async () => {
    // CommonMark allows only whitespace after a closing marker.
    const prose = writeSkill(
      "prose",
      `Intro.\n\n\`\`\`sh\n\`\`\` not a close\n${"echo hi\n".repeat(900)}`,
    );
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["prose"] }),
      available: [{ name: "prose", ...prose }],
    });
    expect(resolved[0].instructions.endsWith("```")).toBe(true);
  });

  it("keeps the synthesized closer inside the per-skill budget", async () => {
    const wide = writeSkill("budget", `Intro.\n\n\`\`\`\`\`\`sh\n${"echo hi\n".repeat(900)}`);
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["budget"] }),
      available: [{ name: "budget", ...wide }],
    });
    expect(resolved[0].instructions.length).toBeLessThanOrEqual(4000);
    expect(resolved[0].instructions.endsWith("``````")).toBe(true);
  });

  it("keeps a short body plus its synthesized closer inside the budget", async () => {
    // A body that fits only until the closer is added must still be bounded.
    const nearLimit = writeSkill("near", `\`\`\`sh\n${"x".repeat(3990)}`);
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["near"] }),
      available: [{ name: "near", ...nearLimit }],
    });
    expect(resolved[0].instructions.length).toBeLessThanOrEqual(4000);
    expect(resolved[0].instructions.endsWith("```")).toBe(true);
  });

  it("honors the operator's skills prompt cap", async () => {
    // The appendix is model-facing skill text, so a work-map must not be able to
    // reinstate bytes the operator capped.
    const capped = writeSkill("capped", "y".repeat(3000));
    const under = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["capped"] }),
      available: [{ name: "capped", ...capped }],
      maxPromptChars: 500,
    });
    // Under the cap AND leaving room for the appendix label and heading.
    expect(under[0].instructions.length).toBeLessThan(500);

    const zero = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["capped"] }),
      available: [{ name: "capped", ...capped }],
      maxPromptChars: 0,
    });
    expect(zero).toEqual([]);
  });

  it("honors the operator's skill-count cap", async () => {
    const a = writeSkill("count-a", "A body.");
    const b = writeSkill("count-b", "B body.");
    const resolved = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["count-a", "count-b"] }),
      available: [
        { name: "count-a", ...a },
        { name: "count-b", ...b },
      ],
      maxSkills: 1,
    });
    expect(resolved.map((skill) => skill.name)).toEqual(["count-a"]);

    const none = await resolveEnterpriseSkillInstructions({
      plan: planWith({ triage: ["count-a"] }),
      available: [{ name: "count-a", ...a }],
      maxSkills: 0,
    });
    expect(none).toEqual([]);
  });

  it("dedupes a skill two steps both declare", () => {
    expect(collectPlanDeclaredSkills(planWith({ a: ["shared"], b: ["shared"] }))).toEqual([
      "shared",
    ]);
  });
});
