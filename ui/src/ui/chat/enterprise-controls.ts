// Chat-surface enterprise controls: the mode selector and the route card.
//
// The mode selector is the switch the operator flips to put the assistant under
// governance. The route card answers the question that immediately follows —
// "so which part of the workflow did it actually run?" — by showing the branch
// the run took through the tree, and how much of the tree that covered.
import { html, nothing, type TemplateResult } from "lit";
import type {
  EnterpriseRunDetail,
  EnterpriseTreeDetail,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";
import { ENTERPRISE_MODES, type EnterpriseMode } from "../controllers/enterprise-chat.ts";
import { icons } from "../icons.ts";

// <openclaw-chat-route-card> is registered by the chat VIEW, not here: this module
// is also imported for the mode selector alone (app-render.helpers.ts, which runs in
// node-environment tests), and a side-effect import would drag two browser-only custom
// elements onto that path.

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
 * The route the last governed run in this thread took. Rendered as a tree (the
 * shape is the point), with a switch between the route alone and the whole tree
 * with the untaken branches dimmed.
 */
export function renderEnterpriseRouteCard(
  run: EnterpriseRunDetail | null,
  tree: EnterpriseTreeDetail | null,
): TemplateResult | typeof nothing {
  if (!run) {
    return nothing;
  }
  return html` <openclaw-chat-route-card .run=${run} .tree=${tree}></openclaw-chat-route-card> `;
}
