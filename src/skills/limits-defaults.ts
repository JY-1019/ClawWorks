/**
 * Default skill limits, in their own dependency-free module.
 *
 * They live here rather than in `loading/workspace.ts` because callers that only
 * need the NUMBERS must not drag the loader in with them: `enterprise-mediation`
 * is imported eagerly by the embedded, CLI, and ACP paths — including runs with
 * enterprise mode off — and importing the loader there would pull the whole
 * skill-loading and plugin-metadata graph onto startup, defeating the lazy
 * boundary `agent-command.ts` keeps around the skills snapshot runtime.
 */
export const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
export const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;
export const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;
