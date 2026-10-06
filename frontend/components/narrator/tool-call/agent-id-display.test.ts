/**
 * agent-id-display.test.ts — a raw nanoid never reaches a header.
 *
 * The visible symptom this closes: `Await agent: UscgG1vLFnxzyKyaUOIfR`. The
 * server now ships a readable label, but two cases still hand the UI a raw id
 * (pre-change metadata, or a model that addressed the agent by full id), so the
 * fallback must shorten. The other half of the contract matters just as much:
 * aliases must survive untouched, or `run-tests` would render as `run-test…`.
 */

import { describe, expect, test } from "bun:test";
import {
	agentTargetDisplay,
	formatAgentIdForDisplay,
	looksLikeGeneratedId,
} from "./agent-id-display";

const NANOID = "UscgG1vLFnxzyKyaUOIfR";

describe("looksLikeGeneratedId", () => {
	test("recognizes a nanoid", () => {
		expect(looksLikeGeneratedId(NANOID)).toBe(true);
		expect(looksLikeGeneratedId("-tLSXSnYCPV_Z9m6gyRgX")).toBe(true);
	});

	test("does not mistake a long slugified alias for an id", () => {
		// This is the case that would regress most visibly: aliases are derived from
		// descriptions, so they are often longer than 12 chars.
		expect(looksLikeGeneratedId("map-the-providers")).toBe(false);
		expect(looksLikeGeneratedId("generate-changelog-2")).toBe(false);
		expect(looksLikeGeneratedId("run-tests")).toBe(false);
	});

	test("leaves short values alone", () => {
		expect(looksLikeGeneratedId("worker")).toBe(false);
		expect(looksLikeGeneratedId("Uscg")).toBe(false);
	});
});

describe("formatAgentIdForDisplay", () => {
	test("truncates a nanoid and marks the elision", () => {
		const shown = formatAgentIdForDisplay(NANOID);
		expect(shown).toBe("UscgG1vL…");
		expect(shown.length).toBeLessThan(NANOID.length);
	});

	test("returns aliases verbatim", () => {
		expect(formatAgentIdForDisplay("map-the-providers")).toBe("map-the-providers");
	});

	test("handles empty and missing values without producing an ellipsis", () => {
		expect(formatAgentIdForDisplay("")).toBe("");
		expect(formatAgentIdForDisplay(undefined)).toBe("");
		expect(formatAgentIdForDisplay(null)).toBe("");
		expect(formatAgentIdForDisplay("   ")).toBe("");
	});
});

describe("agentTargetDisplay", () => {
	test("prefers the server-resolved label over the raw selector", () => {
		expect(agentTargetDisplay("map-the-providers", NANOID)).toBe("map-the-providers");
	});

	test("shortens the selector when no label was persisted (legacy rows)", () => {
		expect(agentTargetDisplay(undefined, NANOID)).toBe("UscgG1vL…");
	});

	test("keeps an alias selector intact when no label was persisted", () => {
		expect(agentTargetDisplay(undefined, "run-tests")).toBe("run-tests");
	});

	test("ignores a blank label rather than rendering nothing", () => {
		expect(agentTargetDisplay("  ", "run-tests")).toBe("run-tests");
	});
});
