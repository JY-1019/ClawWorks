// Defines ClawWorks enterprise-mode Zod schema fragments.
import { z } from "zod";
// The governance refinements (approval scope, knowledge-vs-tool exclusivity) live
// on GovernancePolicySchema in enterprise/schema.ts so config validation and the
// NL->policy compiler share one contract.
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

export const EnterpriseConfigSchema = z
  .object({
    mode: EnterpriseModeSchema.optional(),
    governance: EnterpriseGovernanceSchema,
  })
  .strict()
  .optional();

export type EnterpriseConfig = z.infer<typeof EnterpriseConfigSchema>;
