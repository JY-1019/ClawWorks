/**
 * Resolve the instructions behind a work-map's declared skills so the run digest
 * can CARRY them instead of pointing at them.
 *
 * Naming a skill in the digest is not enough on its own: the model would still
 * have to open the SKILL.md, and how that works is the dispatching runtime's
 * business — the embedded loop reads the file with the `read` tool (which a
 * governed step's scope routinely withholds), a `claude-cli` run resolves skills
 * natively through a plugin directory, and a step that cannot read is simply
 * told about know-how it can never reach. Inlining the text removes the question:
 * the instructions are in the prompt before the first turn, whatever the runtime
 * and whatever the step's tool scope.
 *
 * CONTAINMENT. Candidates come from the snapshot the runner already resolved for
 * this agent, so a step can only surface a skill the agent already had — a
 * declaration narrows what the model is pointed at, it can never add a skill or
 * bypass an agent's skill filter. And instructions are text: they still cannot
 * call anything the step's `allowedTools` withholds.
 *
 * NOT a discovery pass. Nothing is scanned: the snapshot supplies the candidate
 * set and each declared skill's path, so this reads at most the few files the
 * work-map actually names, once per run, and only when a step declares any.
 */
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import { scanFenceSpans } from "../../packages/markdown-core/src/fences.js";
import { openRootFile } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { EnterpriseRunPlan } from "./types.js";

const log = createSubsystemLogger("enterprise");

/** fs.promises cannot read from a raw fd, and the boundary helper hands back one. */
function readFdText(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(fd, "utf8", (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/**
 * Prompt budget. Skills are operator-authored and unbounded, and this text lands
 * in every turn's system prompt, so a long one is truncated rather than allowed
 * to crowd out the workflow guidance it is supposed to support.
 */
const MAX_SKILLS = 8;
const MAX_CHARS_PER_SKILL = 4000;
const MAX_TOTAL_CHARS = 12000;
/**
 * Read cap. Defaults to the loader's own file limit so a skill the loader
 * accepted is not silently dropped here; an operator who raised
 * `skills.limits.maxSkillFileBytes` gets that value instead.
 */
const DEFAULT_SKILL_READ_BYTES = 256_000;
/**
 * What the digest wraps these bodies in (plan.ts): one label line, then a
 * "### <name>" heading per skill. Charged exactly, per resolved name, so the
 * rendered appendix honors the budget instead of an estimate of it.
 */
const APPENDIX_LABEL_CHARS = "\nSkill instructions for the steps above ():\n".length;
/**
 * What one resolved skill costs beyond its body: its "### name" heading plus its
 * entry in the label's comma-separated name list. Charged per name so eight long
 * names cannot push the rendered appendix past the budget.
 */
const perSkillWrapperCost = (name: string): number => `### ${name}\n`.length + name.length + 2;

/**
 * A declared skill whose SKILL.md body was resolved for this run.
 *
 * Name and body only - deliberately no path. Mediation runs BEFORE sandbox
 * preparation, so any path here is the HOST's; a sandboxed run materializes its
 * own copies, and rendering the host location would put a path the run cannot
 * use into the provider prompt. Bodies reference siblings relatively
 * (`references/...`), which resolves against the skill's own directory in either
 * view, so the relative form is the one that travels.
 */
export type ResolvedSkillInstructions = { name: string; instructions: string };

/**
 * Where a skill the AGENT already has lives; supplied by the runner's snapshot.
 * `baseDir` is the skill's own directory and is the read boundary — see
 * readSkillBody.
 */
export type AvailableSkill = { name: string; filePath: string; baseDir: string };

/**
 * Split off YAML frontmatter WITHOUT parsing it. Only the body is wanted, and the
 * skills loader is deliberately tolerant of frontmatter that strict YAML rejects
 * (an unquoted description containing a colon, say). Parsing here would throw on
 * a skill the loader accepted and silently drop its instructions.
 */
function skillBody(content: string): string {
  // The loader accepts a UTF-8 BOM, so strip it before looking for the fence —
  // otherwise the frontmatter reads as body and spends the truncation budget on
  // metadata instead of the instructions.
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return normalized.trim();
  }
  const end = normalized.indexOf("\n---", 3);
  return end === -1 ? normalized.trim() : normalized.slice(end + 4).trim();
}

/**
 * Read a SKILL.md through the same root boundary the skills loader uses
 * (readSkillFileSync in src/skills/loading/local-loader.ts), so a path rebound to
 * a symlink cannot escape the skill's own directory. Without it an attacker who
 * can swap a workspace skill file gets arbitrary host-file contents copied into
 * the system prompt — which then leaves for the model provider.
 */
async function readSkillBody(skill: AvailableSkill, maxBytes: number): Promise<string | null> {
  // fs-safe treats `rootRealPath` as ALREADY canonical and does not validate the
  // root link itself, so resolve it here. Plugin and workspace-symlink skills
  // have a symlinked baseDir; passing the lexical path would let a swap of that
  // link after snapshot resolution redirect this read into another directory.
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(skill.baseDir);
  } catch {
    return null;
  }
  // Async open + read on purpose: this runs on the gateway event loop, and a
  // slow or networked workspace would otherwise stall every other session (and
  // delay abort delivery) while the file is pulled in.
  const opened = await openRootFile({
    absolutePath: skill.filePath,
    rootPath: skill.baseDir,
    rootRealPath,
    boundaryLabel: "skill root",
    maxBytes,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    return skillBody(await readFdText(opened.fd));
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Every skill name the plan's steps declare, deduped and sorted. */
export function collectPlanDeclaredSkills(plan: EnterpriseRunPlan): string[] {
  const names = new Set<string>();
  for (const node of plan.nodes) {
    for (const name of node.ontology.skills ?? []) {
      names.add(name);
    }
  }
  return [...names].toSorted();
}

/**
 * The fence marker still open at the end of `text`, or null.
 *
 * Delegates to the repo's CommonMark scanner rather than matching lines here: a
 * closer must use the same character, be at least as long as the opener, and
 * carry nothing but whitespace after it — a ``` inside prose is not a close, and
 * getting that wrong swallows the next skill into a code block.
 */
function openFenceMarker(text: string): string | null {
  const open = scanFenceSpans(text).state.open;
  return open ? open.marker : null;
}

/** The longest fence marker the body opens; what a synthetic closer may cost. */
function longestFenceMarker(text: string): number {
  const markers = text.match(/^ {0,3}(?:`{3,}|~{3,})/gm) ?? [];
  return markers.reduce((longest, marker) => Math.max(longest, marker.trim().length), 0);
}

/**
 * Bound one body to `max` and leave it structurally closed.
 *
 * Closing runs on BOTH paths: an unclosed fence is legal at the end of a
 * standalone file, but these bodies are concatenated, so one would absorb every
 * following heading. Room for the closer is reserved BEFORE slicing so the
 * result still honors the budget it was given.
 */
function boundBody(text: string, max: number): string {
  const open = openFenceMarker(text);
  // Count the closer against the budget BEFORE deciding not to truncate: a body
  // that just fits but ends mid-fence would otherwise overrun `max`, and a long
  // fence marker overruns it by a lot.
  const closerCost = open ? open.length + 1 : 0;
  if (text.length + closerCost <= max) {
    return open ? `${text}\n${open}` : text;
  }
  const reserve = longestFenceMarker(text);
  const room = Math.max(0, max - 1 - (reserve > 0 ? reserve + 1 : 0));
  const cut = `${text.slice(0, room).trimEnd()}\u2026`;
  const cutOpen = openFenceMarker(cut);
  return cutOpen ? `${cut}\n${cutOpen}` : cut;
}

/**
 * Read the declared skills' instructions, intersected with what the agent has.
 *
 * Sorted by name and bounded so the same work-map produces the same bytes every
 * run (prompt cache). A skill the agent does not have, or whose file cannot be
 * read, is skipped rather than reported into the prompt: the operator surfaces
 * are where an unresolved declaration belongs, and a prompt that announces its
 * own gaps spends tokens telling the model about something it cannot use.
 */
export async function resolveEnterpriseSkillInstructions(params: {
  plan: EnterpriseRunPlan;
  /** The agent's already-resolved skills. Absent means nothing can be inlined. */
  available?: readonly AvailableSkill[];
  /**
   * The operator's `skills.limits.maxSkillsPromptChars`, when set. This appendix
   * is model-facing skill text like the catalog is, so it answers to the same
   * context cap — otherwise a work-map could reinstate skill bytes the operator
   * capped, including when they capped them to zero.
   */
  maxPromptChars?: number;
  /** The operator's `skills.limits.maxSkillsInPrompt`, when set. */
  maxSkills?: number;
  /** The operator's `skills.limits.maxSkillFileBytes`, when set. */
  maxSkillFileBytes?: number;
}): Promise<ResolvedSkillInstructions[]> {
  const declared = collectPlanDeclaredSkills(params.plan);
  if (declared.length === 0 || !params.available?.length) {
    return [];
  }
  const skillCap = Math.min(MAX_SKILLS, Math.max(0, params.maxSkills ?? MAX_SKILLS));
  const readBytes = Math.max(1, params.maxSkillFileBytes ?? DEFAULT_SKILL_READ_BYTES);
  const totalBudget =
    params.maxPromptChars === undefined
      ? MAX_TOTAL_CHARS
      : Math.min(MAX_TOTAL_CHARS, Math.max(0, params.maxPromptChars) - APPENDIX_LABEL_CHARS);
  if (totalBudget <= 0 || skillCap === 0) {
    return [];
  }
  const byName = new Map(params.available.map((skill) => [skill.name, skill]));
  const resolved: ResolvedSkillInstructions[] = [];
  let total = 0;
  for (const name of declared) {
    if (resolved.length >= skillCap || total >= totalBudget) {
      break;
    }
    const skill = byName.get(name);
    if (!skill) {
      continue;
    }
    let body: string | null;
    try {
      body = await readSkillBody(skill, readBytes);
    } catch (err) {
      // A declared skill whose file went away mid-session is an install problem,
      // not a reason to fail the run: the step keeps its scope and its other
      // guidance, and the operator sees the gap on the Skills screen.
      log.warn(`enterprise: could not read skill "${name}" at ${skill.filePath}: ${String(err)}`);
      continue;
    }
    if (!body) {
      continue;
    }
    // The name's own heading is part of what the model receives, so it comes out
    // of the same budget as the body it introduces.
    const room = Math.min(MAX_CHARS_PER_SKILL, totalBudget - total - perSkillWrapperCost(name));
    if (room <= 0) {
      break;
    }
    const instructions = boundBody(body, room);
    resolved.push({ name, instructions });
    total += instructions.length + perSkillWrapperCost(name);
  }
  return resolved;
}
