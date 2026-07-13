// Chat-surface enterprise controls: the mode selector and the route card.
//
// The mode selector is the switch the operator flips to put the assistant under
// governance. The route card answers the question that immediately follows —
// "so which part of the workflow did it actually run?" — by showing the branch
// the run took through the tree, and how much of the tree that covered.
import { html, nothing, type TemplateResult } from "lit";
import type { EnterpriseRunDetail } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { ENTERPRISE_MODES, type EnterpriseMode } from "../controllers/enterprise-chat.ts";
import { icons } from "../icons.ts";

export type EnterpriseChatControlsProps = {
  mode: EnterpriseMode | null;
  busy: boolean;
  disabled: boolean;
  /** Last switch failure (e.g. missing operator.admin); shown, never swallowed. */
  error?: string | null;
  onSelect: (mode: EnterpriseMode) => void;
};

/** Inline selector in the chat control row, mirroring the model/thinking picker. */
export function renderEnterpriseModeSelect(
  props: EnterpriseChatControlsProps,
): TemplateResult | typeof nothing {
  // No mode means the gateway did not answer (no operator.read, older gateway):
  // render nothing rather than a control that cannot work.
  if (!props.mode) {
    return nothing;
  }
  const disabled = props.disabled || props.busy;
  const label = t(`enterprise.mode.${props.mode}.label`);
  return html`
    <details class="chat-controls__session chat-controls__inline-select">
      <summary
        class="chat-controls__inline-select-trigger ${disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""}"
        data-chat-enterprise-select="true"
        data-chat-enterprise-value=${props.mode}
        aria-label=${`${t("enterprise.mode.label")}: ${label}`}
        aria-disabled=${disabled ? "true" : "false"}
        title=${t("enterprise.mode.hint")}
        @click=${(event: MouseEvent) => {
          if (disabled) {
            event.preventDefault();
          }
        }}
      >
        <span class="chat-controls__inline-select-label">
          ${t("enterprise.mode.label")}: ${label}
        </span>
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </summary>
      <div class="chat-controls__inline-select-menu" aria-label=${t("enterprise.mode.label")}>
        ${props.error
          ? html`<div class="chat-enterprise-mode__error">${props.error}</div>`
          : nothing}
        ${ENTERPRISE_MODES.map(
          (mode) => html`
            <button
              type="button"
              class="chat-controls__inline-select-option ${mode === props.mode
                ? "chat-controls__inline-select-option--selected"
                : ""}"
              ?disabled=${disabled}
              @click=${(event: MouseEvent) => {
                // Close the <details> the option lives in, like the sibling pickers.
                (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
                // Re-picking the current mode would still persist openclaw.json and
                // reload the gateway, so a no-op click must stay a no-op.
                if (mode !== props.mode) {
                  props.onSelect(mode);
                }
              }}
            >
              <span>${t(`enterprise.mode.${mode}.label`)}</span>
              <span class="chat-controls__inline-select-option-hint">
                ${t(`enterprise.mode.${mode}.hint`)}
              </span>
            </button>
          `,
        )}
      </div>
    </details>
  `;
}

/**
 * The route the last governed run in this thread took: the branch ids, the
 * coverage (how much of the tree was planned), and the steps in order.
 *
 * Coverage is the honest signal — a narrow route means the planner found the
 * right branch; a route covering most of the tree means it hedged, or fell back.
 */
export function renderEnterpriseRouteCard(
  run: EnterpriseRunDetail | null,
): TemplateResult | typeof nothing {
  if (!run) {
    return nothing;
  }
  const route = run.route;
  const steps = run.nodes;
  return html`
    <div class="chat-enterprise-route">
      <div class="chat-enterprise-route__head">
        <span class="chat-enterprise-route__title">${t("enterprise.routeTitle")}</span>
        <span class="chat-enterprise-route__tree">${run.treeName}</span>
        ${route
          ? html`<span class="chat-enterprise-route__coverage">
              ${t("enterprise.routeCoverage", {
                coverage: `${route.selectedNodes}/${route.totalNodes}`,
              })}
            </span>`
          : nothing}
        <span class="chat-enterprise-route__mode">${run.mode}</span>
      </div>
      ${route?.routes.length
        ? html`<div class="chat-enterprise-route__routes">
            ${route.routes.map((id) => html`<code>${id}</code>`)}
          </div>`
        : nothing}
      <ol class="chat-enterprise-route__steps">
        ${steps.map(
          (step) => html`
            <li class=${step.nodeId === run.activeNodeId ? "is-active" : ""}>
              <span class="chat-enterprise-route__step-title">${step.title}</span>
              <code>${step.nodeId}</code>
            </li>
          `,
        )}
      </ol>
      ${route ? html`<div class="chat-enterprise-route__why">${route.rationale}</div>` : nothing}
    </div>
  `;
}
