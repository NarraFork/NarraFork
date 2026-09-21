/**
 * Pre-write judgments for `substitute`.
 *
 * Each of these is a way a regex substitution can succeed loudly and be wrong quietly:
 * the call returns, `replacements` is a plausible number, and the damage is only visible
 * in the file. The tool has no way to notice afterwards, so the checks all run BEFORE
 * anything is rewritten, and each one leaves the text byte-identical when it fires.
 *
 * The JS engine's behaviour is the whole reason the rules look the way they do, and it is
 * not the behaviour other regex engines have — a rule lifted from a sed or RE2 based tool
 * would be wrong here in both directions. See the comments on the individual tests.
 */
import { describe, expect, test } from "bun:test";
import {
	EditOpError,
	substituteInRange,
	validateReplacementTemplate,
} from "@server/lib/agent/structural/edit-ops";

const WHOLE = { startLine: 1, endLine: 1 };

describe("zero-width matches", () => {
	test("a pattern matching between characters is refused", () => {
		// "abc".replace(/x*/g, "|") === "|a|b|c|" — every gap gets the replacement.
		expect(() => substituteInRange("abc\n", WHOLE, "x*", "|", { flags: "g" })).toThrow(
			/ZERO-WIDTH/,
		);
	});

	test("\\b is caught even though it cannot match an empty string", () => {
		// The cheap test would be `new RegExp(pattern).test("")`, and for \b that is
		// FALSE — an empty string has no word boundary. It still produces four
		// zero-width hits on "ab cd". Only the matches actually found reveal it.
		expect(/\b/.test("")).toBe(false);
		expect(() => substituteInRange("ab cd\n", WHOLE, "\\b", "|", { flags: "g" })).toThrow(
			/ZERO-WIDTH/,
		);
	});

	test("a refusal on a later line does not write the earlier ones", () => {
		// `q*` is fine on a line made of q's (one trailing zero-width hit) and ruinous on
		// a line without any (a hit in every gap). With both lines in range the whole
		// call has to fail, not substitute line 1 and then stop.
		const text = "qqq\nabc\n";
		expect(() =>
			substituteInRange(text, { startLine: 1, endLine: 2 }, "q*", "Z", { flags: "g" }),
		).toThrow(EditOpError);
		// Line 1 on its own is accepted, which is what makes the refusal above meaningful:
		// the scan covered the whole range before anything was applied.
		expect(substituteInRange(text, { startLine: 1, endLine: 1 }, "q*", "Z", { flags: "g" }).text).toBe(
			"ZZ\nabc\n",
		);
	});

	test("a single zero-width hit per line is a legitimate anchor", () => {
		// `s/^/prefix/` and `s/$/;/` are ordinary sed idioms and each matches once per
		// line. Banning zero-width outright would take them away for no benefit.
		expect(substituteInRange("abc\n", WHOLE, "^", "// ", { flags: "g" }).text).toBe("// abc\n");
		expect(substituteInRange("abc\n", WHOLE, "$", ";", { flags: "g" }).text).toBe("abc;\n");
	});
});

describe("replacement template references", () => {
	test("a reference with no group at all would be written as literal text", () => {
		// JS does NOT expand this to the empty string: "foo".replace(/foo/, "[$1]")
		// is "[$1]". The typo ends up in the source file.
		expect("foo".replace(/foo/, "[$1]")).toBe("[$1]");
		expect(() => substituteInRange("foo\n", WHOLE, "foo", "[$1]")).toThrow(/literal text/);
	});

	test("a number past the group count is refused", () => {
		expect(() => substituteInRange("foo\n", WHOLE, "f(o)", "[$2]")).toThrow(/only 1 capture/);
	});

	test("an unknown named group would expand to the empty string", () => {
		// The other direction: with named groups present, an unknown name silently
		// deletes the span. "foo".replace(/(?<a>f)/, "[$<b>]") === "[]oo".
		expect("foo".replace(/(?<a>f)/, "[$<b>]")).toBe("[]oo");
		expect(() => substituteInRange("foo\n", WHOLE, "(?<a>f)", "[$<b>]")).toThrow(/EMPTY STRING/);
	});

	test("$<…> against a pattern with no named groups is refused", () => {
		expect(() => substituteInRange("foo\n", WHOLE, "foo", "[$<n>]")).toThrow(
			/no named groups/,
		);
	});

	test("valid references pass", () => {
		expect(substituteInRange("a-b\n", WHOLE, "(a)-(b)", "$2$1").text).toBe("ba\n");
		expect(substituteInRange("foo\n", WHOLE, "(?<x>f)oo", "[$<x>]").text).toBe("[f]\n");
		expect(substituteInRange("foo\n", WHOLE, "foo", "[$&]").text).toBe("[foo]\n");
	});

	test("forms that are well-defined in JS are left alone", () => {
		// A trailing lone `$` is a literal dollar sign here, not an error as it is in
		// engines that require `$$`. Refusing it would reject a correct replacement.
		expect(() => validateReplacementTemplate("foo", "costs $")).not.toThrow();
		expect(() => validateReplacementTemplate("foo", "a$$b")).not.toThrow();
		// `$10` against one group resolves as group 1 followed by a literal "0".
		expect(() => validateReplacementTemplate("f(o)", "[$10]")).not.toThrow();
		expect("foo".replace(/f(o)/, "[$10]")).toBe("[o0]o");
	});

	test("groups are counted through backreferences and lookaround", () => {
		// The count comes from compiling the pattern, not from scanning its text for
		// "(" — which would have to know about escapes, classes and the whole `(?…`
		// family, and would miscount every one of these.
		expect(() => validateReplacementTemplate("(a)\\1", "$1")).not.toThrow();
		expect(() => validateReplacementTemplate("(?<=x)(y)", "$1")).not.toThrow();
		expect(() => validateReplacementTemplate("(a)(?:b)(c)", "$2")).not.toThrow();
		expect(() => validateReplacementTemplate("(a)(?:b)(c)", "$3")).toThrow(/only 2 capture/);
		expect(() => validateReplacementTemplate("\\(literal\\)", "$1")).toThrow(/literal text/);
	});
});

describe("all-or-nothing", () => {
	test("the match cap refuses before writing anything", () => {
		const wide = `${"x ".repeat(2000)}\n`;
		expect(() => substituteInRange(wide, WHOLE, "x", "y", { flags: "g" })).toThrow(
			/nothing was changed/,
		);
	});

	test("the timeout refuses before writing anything", () => {
		const many = `${"needle\n".repeat(400)}`;
		expect(() =>
			substituteInRange(many, { startLine: 1, endLine: 400 }, "needle", "pin", {
				flags: "g",
				timeoutMs: -1,
			}),
		).toThrow(/no lines were changed/);
	});

	test("a range with no match returns the original text", () => {
		const result = substituteInRange("a\nb\n", { startLine: 1, endLine: 2 }, "zzz", "y");
		expect(result.text).toBe("a\nb\n");
		expect(result.replacements).toBe(0);
	});
});

describe("flag handling", () => {
	test("m and s are rejected with the reason, not silently dropped", () => {
		expect(() => substituteInRange("a\n", WHOLE, "a", "b", { flags: "gm" })).toThrow(
			/one line at a time/,
		);
	});

	test("the error for an uncompilable pattern names this engine's real limit", () => {
		// Backreferences and lookaround DO work here; catastrophic backtracking is the
		// hazard instead. Saying "no backreferences" would be false and would send the
		// caller to rewrite a pattern that was fine.
		expect(() => substituteInRange("a\n", WHOLE, "([", "b")).toThrow(/backtrack/);
		expect(substituteInRange("aa\n", WHOLE, "(a)\\1", "b").text).toBe("b\n");
		expect(substituteInRange("xy\n", WHOLE, "(?<=x)y", "Z").text).toBe("xZ\n");
	});
});
