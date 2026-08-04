/**
 * Codex's own skills block, for a run whose work-map grants skills explicitly.
 *
 * Codex scans its OWN skill roots and injects their instructions by default
 * (`skills.include_instructions`,
 * ../codex/codex-rs/config/src/skills_config.rs:30-32, applied per thread through
 * the thread-config override in
 * ../codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:94-95).
 * ClawWorks narrows its own catalog for a governed run, but that block belongs to
 * Codex, so a governed thread would still be offered skills the work-map never
 * granted.
 *
 * The wire shape stays HERE, in the harness that owns it; core only answers the
 * provider-neutral question of whether the run grants explicitly.
 */
export function resolveGovernedCodexSkillsThreadConfig(
  grant: readonly string[] | null,
): { skills: { include_instructions: boolean } } | undefined {
  return grant ? { skills: { include_instructions: false } } : undefined;
}
