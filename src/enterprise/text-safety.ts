/**
 * Terminal-display and matcher safety for untrusted model/provider text in the
 * governance policy compiler. Two different rules, because the fields have different
 * jobs:
 *
 *  - Free text (policy descriptions, failure messages) may legitimately hold normal
 *    Unicode — emoji, accents, other languages — but never invisible/control chars.
 *  - Selector globs are matched verbatim against ASCII ids and printed for review, so
 *    anything that is invisible, whitespace, or a look-alike makes a policy that reads
 *    right but never matches.
 */

// DELETE default-ignorable code points (\p{Default_Ignorable_Code_Point}: zero-width
// spaces/joiners, the combining grapheme joiner U+034F, bidi controls, variation
// selectors, soft hyphen, ...) so a token an attacker split with one — e.g. a secret
// broken by U+200B or U+034F — rejoins into its real form before it is redacted or
// shown; a space would leave the fragments apart. REPLACE control chars and line/
// paragraph separators (\p{Cc}\p{Zl}\p{Zp}) with a space so structure stays readable.
// Visible Unicode (accents, emoji) is preserved.
const IGNORABLE_CHAR_GLOBAL = /\p{Default_Ignorable_Code_Point}/gu;
const CONTROL_OR_SEPARATOR_GLOBAL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** Make untrusted free text safe to display/redact while keeping visible Unicode. */
export function stripUnsafeDisplayChars(value: string): string {
  return value.replace(IGNORABLE_CHAR_GLOBAL, "").replace(CONTROL_OR_SEPARATOR_GLOBAL, " ");
}

// Selector globs are matched by the governance matcher (governance.ts ->
// isToolAllowedByPolicyName) for every family and printed for review. A tool name may be
// ANY non-blank string (plugins/tool-contracts.ts only trims), so a valid selector can
// hold accents, CJK, an ordinary space, "+", or a literal metacharacter — keep all of
// those targetable. Reject only what is invisible or a look-alike, which would render
// like a valid id yet never match:
//   - control chars (\p{Cc}) and line/paragraph separators (\p{Zl}\p{Zp});
//   - default-ignorable code points (\p{Default_Ignorable_Code_Point}: zero-width, the
//     combining grapheme joiner U+034F, bidi controls, variation selectors);
//   - every space separator (\p{Zs}) EXCEPT the ordinary U+0020 — NBSP, figure space,
//     narrow NBSP, etc. render like a space but normalizeToolName keeps them, so the
//     selector never matches the ordinary-space tool id it appears to. `(?! )` keeps
//     U+0020 allowed while rejecting the rest.
const UNSAFE_SELECTOR_CHAR = /[\p{Cc}\p{Zl}\p{Zp}]|\p{Default_Ignorable_Code_Point}|(?! )\p{Zs}/u;

/** True when a selector glob holds an invisible, control, or look-alike-space character. */
export function selectorHasUnsafeChar(value: string): boolean {
  return UNSAFE_SELECTOR_CHAR.test(value);
}
