import type { EnterpriseRunDetail } from "../../../packages/gateway-protocol/src/index.js";
import { t } from "../i18n/index.ts";

/** User-facing explanation for the server-owned run continuation decision. */
export function enterpriseResumeRefusalMessage(
  reason: NonNullable<EnterpriseRunDetail["resumeRefusalReason"]>,
): string {
  switch (reason) {
    case "still-running":
      return t("enterprise.resumeRefusedRunning");
    case "no-session":
      return t("enterprise.resumeRefusedNoSession");
    case "no-steps-completed":
      return t("enterprise.resumeRefusedNoSteps");
    case "route-complete":
      return t("enterprise.resumeRefusedRouteComplete");
    case "transcript-rotated":
      return t("enterprise.resumeRefusedRotated");
    default:
      return t("enterprise.resumeRefusedNotFound");
  }
}
