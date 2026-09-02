// Defines ClawWorks enterprise-mode Zod schema fragments.
import { z } from "zod";
// The governance refinements (approval scope, knowledge-vs-tool exclusivity) live
// on GovernancePolicySchema in enterprise/schema.ts so config validation and the
// NL->policy compiler share one contract.
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { GovernancePolicySchema } from "../enterprise/schema.js";

/**
 * Enterprise execution mode:
 * - "enforce": every run binds to a workflow tree; governance denials block.
 * - "observe": runs bind and trace, but denials are recorded, not enforced.
 * - "off": stock OpenClaw behavior with no enterprise mediation.
 */
export const EnterpriseModeSchema = z.enum(["enforce", "observe", "off"]);

const EnterpriseGovernanceSchema = z
  .object({
    policies: z.array(GovernancePolicySchema).optional(),
  })
  .strict()
  .optional();

const QUALIFIED_MODEL_REF = /^[^\s/]+\/\S+$/;

/**
 * A ref that still names a provider AND a model once its auth-profile suffix is
 * removed the way the runtime removes it.
 *
 * Checking the post-split value is what separates `mistral/@work` — whose model half
 * is only a profile, leaving the unparseable `mistral/` — from `openrouter/@preset/x`
 * and `openai/@cf/y`, where the `@` belongs to the model path and the splitter
 * deliberately keeps it. A plain regex over the raw value cannot tell them apart.
 */
function isQualifiedRoutePlannerModelRef(raw: string): boolean {
  if (!raw || raw !== raw.trim()) {
    return false;
  }
  return QUALIFIED_MODEL_REF.test(splitTrailingAuthProfile(raw).model);
}

/**
 * The model that picks a work-map and route, when it should not be the one the
 * turn runs on.
 *
 * Routing is a different workload from the turn: one small structured answer, made
 * through the direct completion API before the tool loop starts. A CLI backend runs
 * the turn by handing it to a binary that authenticates itself, so it has no API
 * credential to lend the router — which makes the router the one part of a governed
 * run that can need a credential, and a model, of its own. Naming one here also names
 * WHERE the routing prompt goes, which is the fact the derivation from the run's own
 * model cannot establish by itself.
 *
 * A plain `provider/model` ref on purpose. The router makes ONE bounded call, so the
 * fallback list and per-capability timeout the tool-model shape carries would be
 * surface with nothing behind them — the planner already owns its own deadline.
 *
 * The provider half is REQUIRED, and that is a safety rule rather than tidiness.
 * Naming a router overrides the gate that skips planning when a hook may swap the
 * run onto a private provider, on the grounds that the operator said where the
 * prompt may go. A bare `llama3` says no such thing: it resolves against whatever
 * the agent's default provider happens to be, so accepting it would let a typo send
 * the routing prompt somewhere nobody named. Gateway providers route slash-bearing
 * ids (`openrouter/anthropic/claude-sonnet-4-6`), so only the FIRST segment is the
 * provider and the rest is the model.
 */
const EnterpriseRoutePlannerSchema = z
  .object({
    model: z
      .string()
      .refine(
        isQualifiedRoutePlannerModelRef,
        'Route planner model must be a qualified "provider/model" ref, for example "mistral/mistral-medium-3-5".',
      )
      .optional(),
  })
  .strict()
  .optional();

export const EnterpriseConfigSchema = z
  .object({
    mode: EnterpriseModeSchema.optional(),
    governance: EnterpriseGovernanceSchema,
    routePlanner: EnterpriseRoutePlannerSchema,
  })
  .strict()
  .optional();

export type EnterpriseConfig = z.infer<typeof EnterpriseConfigSchema>;
