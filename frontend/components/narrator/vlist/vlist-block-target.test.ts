/** vlist-block-target.test.ts — unit tests for resolveVListBlockTarget. */

import { describe, expect, it } from "bun:test";
import type { VListElementKind } from "@shared/pretext-layout/element-kinds";
import { resolveVListBlockTarget, toolUseIdFromBlockId } from "./vlist-block-target";

const MSG = "abc123def456";

function target(kind: VListElementKind, key: string, ids: string[] = [MSG]) {
	return resolveVListBlockTarget(kind, key, ids);
}

describe("resolveVListBlockTarget", () => {
	it("maps markdown to msg-{id}-{blockIndex}", () => {
		expect(target("markdown", `${MSG}-b3`)).toEqual({
			blockId: `msg-${MSG}-3`,
			messageId: MSG,
			blockIndex: 3,
		});
	});

	it("maps reasoning and reasoning-steps to the run-start block index", () => {
		expect(target("reasoning", `${MSG}-b1`)).toEqual({
			blockId: `msg-${MSG}-1`,
			messageId: MSG,
			blockIndex: 1,
		});
		expect(target("reasoning-steps", `${MSG}-b1`)).toEqual({
			blockId: `msg-${MSG}-1`,
			messageId: MSG,
			blockIndex: 1,
		});
	});

	it("maps web-search and media", () => {
		expect(target("web-search", `${MSG}-b5`)).toEqual({
			blockId: `msg-${MSG}-5`,
			messageId: MSG,
			blockIndex: 5,
		});
		expect(target("media", `${MSG}-b2`)?.blockId).toBe(`msg-${MSG}-2`);
	});

	it("maps user message-bubble to block index 0", () => {
		expect(target("message-bubble", `${MSG}-bubble`)).toEqual({
			blockId: `msg-${MSG}-0`,
			messageId: MSG,
			blockIndex: 0,
		});
	});

	it("maps tool-call to tc-{toolUseId} with blockIndex -1", () => {
		expect(target("tool-call", "tool-tu_789")).toEqual({
			blockId: "tc-tu_789",
			messageId: MSG,
			blockIndex: -1,
		});
	});

	it("maps subagent-card to sa-{toolUseId}", () => {
		expect(target("subagent-card", "tool-tu_999")).toEqual({
			blockId: "sa-tu_999",
			messageId: MSG,
			blockIndex: -1,
		});
	});

	it("handles nanoid message ids containing dashes (uses sourceMessageIds, not key parse)", () => {
		const dashed = "V1StGXR8_Z5jdHi6B-myT";
		expect(target("markdown", `${dashed}-b7`, [dashed])).toEqual({
			blockId: `msg-${dashed}-7`,
			messageId: dashed,
			blockIndex: 7,
		});
	});

	it("returns null for aggregate kinds", () => {
		expect(target("tool-run-summary", "toolrun-summary-tool-tu_1", ["m1", "m2"])).toBeNull();
		expect(target("tool-run-count", "toolrun-count-tool-tu_1", ["m1"])).toBeNull();
		expect(target("activity-trace", "activity-m1-0", ["m1", "m2"])).toBeNull();
	});

	it("returns null for non-interactive chrome kinds", () => {
		expect(target("prune-divider", "prune", [])).toBeNull();
		expect(target("tool-call-group", "g1")).toBeNull();
		expect(target("reasoning-count", `${MSG}-b1`)).toBeNull();
		expect(target("ask-user-question", `${MSG}-auq`)).toBeNull();
		expect(target("inline-permission", `${MSG}-perm`)).toBeNull();
	});

	it("returns null when the block index suffix is missing or malformed", () => {
		expect(target("markdown", `${MSG}-noindex`)).toBeNull();
		expect(target("markdown", `${MSG}-b`)).toBeNull();
	});

	it("returns null for a tool card whose key lacks the tool- prefix", () => {
		expect(target("tool-call", "weird-key")).toBeNull();
	});

	it("returns null when there is no source message id", () => {
		expect(target("markdown", `${MSG}-b1`, [])).toBeNull();
	});

	it("maps system card kinds via their block index suffix", () => {
		expect(target("system-text", `${MSG}-b4`)?.blockId).toBe(`msg-${MSG}-4`);
		expect(target("knowledge-hint", `${MSG}-b6`)?.blockId).toBe(`msg-${MSG}-6`);
		expect(target("plan-card", `${MSG}-b0`)?.blockId).toBe(`msg-${MSG}-0`);
		expect(target("ask-in-passing", `${MSG}-b8`)?.blockId).toBe(`msg-${MSG}-8`);
		expect(target("system-simple", `${MSG}-b2`)?.blockId).toBe(`msg-${MSG}-2`);
	});
});

describe("toolUseIdFromBlockId", () => {
	it("unwraps both tool blockId prefixes", () => {
		expect(toolUseIdFromBlockId("tc-tu_1")).toBe("tu_1");
		expect(toolUseIdFromBlockId("sa-tu_1")).toBe("tu_1");
	});

	it("round-trips the blockId a tool row resolves to", () => {
		const tool = target("tool-call", "tool-tu_42");
		const subagent = target("subagent-card", "tool-tu_42");
		expect(toolUseIdFromBlockId(tool?.blockId ?? "")).toBe("tu_42");
		expect(toolUseIdFromBlockId(subagent?.blockId ?? "")).toBe("tu_42");
	});

	it("returns undefined for content-block ids and empty ids", () => {
		expect(toolUseIdFromBlockId(`msg-${MSG}-3`)).toBeUndefined();
		expect(toolUseIdFromBlockId("tc-")).toBeUndefined();
		expect(toolUseIdFromBlockId("")).toBeUndefined();
	});
});
