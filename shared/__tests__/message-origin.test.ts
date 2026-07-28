/**
 * message-origin.test.ts — the origin label format shared by server and frontend.
 *
 * `originLabel` stores a stable machine token (`sourceKey` or `sourceKey:detail`)
 * rather than localized prose, because these rows outlive any one session's
 * locale. These tests pin that round-trip and the null-means-user compatibility
 * rule for rows written before the column existed.
 */

import { describe, expect, test } from "bun:test";
import {
	formatOriginLabel,
	isHumanOrigin,
	normalizeMessageOrigin,
	parseOriginLabel,
} from "../message-origin";

describe("normalizeMessageOrigin", () => {
	test("treats null/undefined as user (pre-column rows were all human)", () => {
		expect(normalizeMessageOrigin(null)).toBe("user");
		expect(normalizeMessageOrigin(undefined)).toBe("user");
	});

	test("passes through known values", () => {
		expect(normalizeMessageOrigin("system")).toBe("system");
		expect(normalizeMessageOrigin("assistant")).toBe("assistant");
		expect(normalizeMessageOrigin("user")).toBe("user");
	});

	test("falls back to user for unknown values rather than throwing", () => {
		expect(normalizeMessageOrigin("bogus")).toBe("user");
	});
});

describe("isHumanOrigin", () => {
	test("only user-authored content counts as human", () => {
		expect(isHumanOrigin(null)).toBe(true);
		expect(isHumanOrigin("user")).toBe(true);
		expect(isHumanOrigin("system")).toBe(false);
		expect(isHumanOrigin("assistant")).toBe(false);
	});
});

describe("formatOriginLabel / parseOriginLabel", () => {
	test("round-trips a bare source", () => {
		const label = formatOriginLabel("autoContinuation");
		expect(label).toBe("autoContinuation");
		expect(parseOriginLabel(label)).toEqual({
			source: "autoContinuation",
			detail: null,
			raw: "autoContinuation",
		});
	});

	test("round-trips a source with dynamic detail", () => {
		const label = formatOriginLabel("gateway", "telegram @foo");
		expect(label).toBe("gateway:telegram @foo");
		expect(parseOriginLabel(label)).toEqual({
			source: "gateway",
			detail: "telegram @foo",
			raw: "gateway:telegram @foo",
		});
	});

	test("keeps colons inside the detail (OAuth client ids, task names)", () => {
		const label = formatOriginLabel("oauth", "client:with:colons");
		expect(parseOriginLabel(label)).toEqual({
			source: "oauth",
			detail: "client:with:colons",
			raw: "oauth:client:with:colons",
		});
	});

	test("omits an empty detail instead of leaving a dangling separator", () => {
		expect(formatOriginLabel("review", "")).toBe("review");
		expect(formatOriginLabel("review", "   ")).toBe("review");
		expect(formatOriginLabel("review", null)).toBe("review");
	});

	test("returns null for an absent label", () => {
		expect(parseOriginLabel(null)).toBeNull();
		expect(parseOriginLabel(undefined)).toBeNull();
		expect(parseOriginLabel("")).toBeNull();
	});

	test("surfaces an unrecognized label as raw text instead of dropping it", () => {
		// Forward compatibility: a label written by a newer server must still show
		// something rather than silently rendering as an unattributed message.
		expect(parseOriginLabel("futureSource:detail")).toEqual({
			source: null,
			detail: null,
			raw: "futureSource:detail",
		});
	});
});
