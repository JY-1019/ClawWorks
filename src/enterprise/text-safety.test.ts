import { describe, expect, it } from "vitest";
import { selectorHasUnsafeChar, stripUnsafeDisplayChars } from "./text-safety.js";

describe("stripUnsafeDisplayChars", () => {
  it("deletes zero-width and other invisible chars so a split token rejoins", () => {
    const zwsp = String.fromCharCode(0x200b); // format char (\p{Cf})
    const cgj = String.fromCharCode(0x034f); // combining grapheme joiner (\p{Mn}, still invisible)
    expect(stripUnsafeDisplayChars(`sk-1234${zwsp}56${cgj}78`)).toBe("sk-12345678");
  });

  it("replaces control and line/paragraph separators with a space", () => {
    const bell = String.fromCharCode(7);
    const lineSep = String.fromCharCode(0x2028);
    expect(stripUnsafeDisplayChars(`a${bell}b${lineSep}c`)).toBe("a b c");
  });

  it("preserves normal Unicode such as accents and emoji", () => {
    expect(stripUnsafeDisplayChars("café 🎉")).toBe("café 🎉");
  });
});

describe("selectorHasUnsafeChar", () => {
  it("accepts any visible tool name — accents, CJK, spaces, wildcards, metacharacters", () => {
    // A plugin tool name may be any non-blank string, so all of these must stay
    // targetable (spaces and "+" included; "*" is the wildcard).
    for (const glob of [
      "shell",
      "mcp__server__tool",
      "assist.*",
      "*",
      "a/b:c@d",
      "foo+bar",
      "refund-?",
      "café",
      "翻訳ツール",
      "my tool",
    ]) {
      expect(selectorHasUnsafeChar(glob)).toBe(false);
    }
  });

  it("rejects invisible chars and non-ASCII space look-alikes (but allows U+0020)", () => {
    const esc = String.fromCharCode(27); // control
    const zwsp = String.fromCharCode(0x200b); // zero-width space
    const cgj = String.fromCharCode(0x034f); // combining grapheme joiner (invisible)
    const lineSep = String.fromCharCode(0x2028); // line separator
    const nbsp = String.fromCharCode(0x00a0); // non-breaking space (a space look-alike)
    const narrowNbsp = String.fromCharCode(0x202f);
    for (const glob of [
      `exec${esc}`,
      `exec${zwsp}`,
      `exec${cgj}`,
      `exec${lineSep}`,
      `my${nbsp}tool`,
      `my${narrowNbsp}tool`,
    ]) {
      expect(selectorHasUnsafeChar(glob)).toBe(true);
    }
    // An ordinary space stays allowed so real "my tool" names are targetable.
    expect(selectorHasUnsafeChar("my tool")).toBe(false);
  });
});
