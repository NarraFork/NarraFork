/**
 * vlist-jump-target.test.ts — Pins the id-resolution order for a jump.
 *
 * A jump target can be a `msg-` DOM id, a bare message id, or a tool use id (a
 * tool-only assistant turn renders no `msg-` node). Getting this order wrong is
 * invisible in the common case and breaks exactly the hard one — a search hit on
 * a tool call in history the list has not loaded — so each interpretation is
 * pinned here rather than left to the shell's integration path.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildPretextLayoutIndex } from "@shared/pretext-layout/index";
import {
	jumpTargetItemIndex,
	jumpTargetMessageId,
	jumpTargetScrollTop,
	mountedJumpTarget,
	resolveJumpTargetSeq,
} from "./vlist-jump-target";

// Minimal DOM surface: these tests need identity/scope, not browser layout.
function fakeRoot(entries: Record<string, unknown>): HTMLElement {
	return { querySelector: (selector: string) => entries[selector] ?? null } as HTMLElement;
}

describe("exact Send row navigation", () => {
	const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
	beforeAll(() => {
		// Fixtures use only CSS-safe ids; Bun has no browser CSS namespace.
		if (!originalCss) {
			Object.defineProperty(globalThis, "CSS", {
				configurable: true,
				value: { escape: (value: string) => value },
			});
		}
	});
	afterAll(() => {
		if (!originalCss) Reflect.deleteProperty(globalThis, "CSS");
	});

	it("uses the tool's own layout offset, not the first row of its message", () => {
		const index = buildPretextLayoutIndex({
			layoutRevision: "1",
			documentRevision: 1,
			lod: 5,
			widthBucket: 800,
			metrics: { topPadding: 0, itemGap: 4, bottomPadding: 0 },
			items: ["text", "tool-read-1", "tool-send-2"].map((itemKey) => ({
				itemKey,
				firstSeq: 10,
				lastSeq: 10,
				sourceMessageIds: ["assistant-message"],
				kind: "communication-bubble",
				height: 100,
			})),
		});
		expect(jumpTargetItemIndex(index, "send-2")).toBe(2);
		expect(jumpTargetItemIndex(index, "msg-send-2")).toBe(2);
		expect(jumpTargetItemIndex(index, "assistant-message")).toBe(0);
		expect(jumpTargetItemIndex(index, "missing")).toBeUndefined();
	});

	it("reveals and highlights the Send row before any message alias", () => {
		const row = {} as HTMLElement;
		const root = fakeRoot({
			'[data-nf-row-key="tool-send-2"]': row,
			'[id="msg-assistant-message"]': { closest: () => null },
		});
		expect(mountedJumpTarget(root, ["msg-assistant-message"], ["send-2"])).toBe(row);
	});

	it("does not select a matching row in another docked list", () => {
		const otherRow = {} as HTMLElement;
		const otherRoot = fakeRoot({ '[data-nf-row-key="tool-send-2"]': otherRow });
		expect(mountedJumpTarget(fakeRoot({}), [], ["send-2"])).toBeNull();
		expect(mountedJumpTarget(otherRoot, [], ["send-2"])).toBe(otherRow);
	});

	it("highlights the containing row instead of a zero-size message alias", () => {
		const row = {} as HTMLElement;
		const root = fakeRoot({ '[id="msg-owner"]': { closest: () => row } });
		expect(mountedJumpTarget(root, [], ["owner"])).toBe(row);
	});
});

describe("dock message jump wiring", () => {
	it("keeps the session identity stable and passes repeat requests into the existing list", async () => {
		const dock = await Bun.file(new URL("../dock/panels.tsx", import.meta.url)).text();
		const child = dock.slice(
			dock.indexOf("export function SubagentSessionPanelContent"),
			dock.indexOf("export function SubagentDockPanel"),
		);
		expect(child).toContain("key={subagentNarratorId}");
		expect(child).toContain("highlightRequestId={highlightRequestId}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: assert source text, not interpolation
		expect(child).not.toContain("`${subagentNarratorId}:${highlightRequestId}`");
		const panel = await Bun.file(new URL("../NarratorPanel.tsx", import.meta.url)).text();
		expect(panel).toContain("highlightRequestId={highlightRequestId}");
		const list = await Bun.file(new URL("./PretextExactMessageList.tsx", import.meta.url)).text();
		expect(list).toContain("JSON.stringify([narratorId, highlightMessageId, highlightRequestId])");
		expect(list).toContain(
			"[documentReady, highlightMessageId, highlightRequestId, narratorId, scrollToMessageTarget]",
		);
	});
});

describe("jumpTargetScrollTop", () => {
	function fixture(contentTop: number, height = 100, scale = 1) {
		const viewport = {
			scrollTop: 300,
			scrollHeight: 2000,
			clientHeight: 400,
			clientTop: 2,
			// Asymmetric borders plus a horizontal scrollbar are outside clientHeight.
			offsetHeight: 420,
			getBoundingClientRect: () => ({ top: 120, height: 420 * scale }),
		} as HTMLElement;
		const target = {
			getBoundingClientRect: () => ({
				top: 120 + (2 + contentTop - viewport.scrollTop) * scale,
				height: height * scale,
			}),
			scrollIntoView: () => {
				throw new Error("must not scroll ancestors");
			},
		} as unknown as HTMLElement;
		return { viewport, target };
	}

	it("centers using viewport-local coordinates, accounting for its border", () => {
		const { viewport, target } = fixture(800);
		expect(jumpTargetScrollTop(viewport, target)).toBe(650);
		expect(viewport.scrollTop).toBe(300);
	});

	it("repeated positioning stays at the same offset without a native reveal", () => {
		const { viewport, target } = fixture(800);
		viewport.scrollTop = jumpTargetScrollTop(viewport, target);
		for (let i = 0; i < 5; i++) {
			expect(jumpTargetScrollTop(viewport, target)).toBe(650);
		}
	});

	for (const scale of [0.5, 2]) {
		it(`centers and repeatedly locates in layout units at scale ${scale}`, () => {
			const { viewport, target } = fixture(800, 100, scale);
			for (let i = 0; i < 5; i++) {
				expect(jumpTargetScrollTop(viewport, target)).toBe(650);
				viewport.scrollTop = jumpTargetScrollTop(viewport, target);
			}
			for (const [top, height, expected] of [
				[0, 100, 0],
				[1950, 50, 1600],
				[800, 600, 900],
			]) {
				const scaled = fixture(top, height, scale);
				expect(jumpTargetScrollTop(scaled.viewport, scaled.target)).toBe(expected);
			}
		});
	}

	it("clamps targets at both ends and supports rows taller than the viewport", () => {
		for (const [top, height, expected] of [
			[0, 100, 0],
			[1950, 50, 1600],
			[800, 600, 900],
		]) {
			const { viewport, target } = fixture(top, height);
			expect(jumpTargetScrollTop(viewport, target)).toBe(expected);
		}
	});
});

describe("jumpTargetMessageId", () => {
	it("strips a msg- DOM id prefix and passes a raw id through", () => {
		expect(jumpTargetMessageId("msg-abc")).toBe("abc");
		expect(jumpTargetMessageId("abc")).toBe("abc");
	});
});

describe("resolveJumpTargetSeq", () => {
	const notFound = () => Promise.reject(new Error("not found"));

	it("resolves a message id directly", async () => {
		const result = await resolveJumpTargetSeq(["msg-m1"], {
			fetchMessageLocation: async (id) => {
				expect(id).toBe("m1");
				return { seq: 42, topLevelMessageId: "m1" };
			},
			fetchToolMessage: notFound,
		});
		expect(result).toEqual({ seq: 42, topLevelMessageId: "m1" });
	});

	it("reports the TOP-LEVEL message when the target is nested in a subagent tree", async () => {
		// The nested message has no layout item of its own; the ancestor is the row the
		// list can actually locate, so it must survive the resolution.
		const result = await resolveJumpTargetSeq(["child"], {
			fetchMessageLocation: async () => ({ seq: 7, topLevelMessageId: "parent" }),
			fetchToolMessage: notFound,
		});
		expect(result).toEqual({ seq: 7, topLevelMessageId: "parent" });
	});

	it("falls back to the tool call's owning message for a tool use id", async () => {
		const seen: string[] = [];
		const result = await resolveJumpTargetSeq(["tool-1"], {
			fetchMessageLocation: async (id) => {
				seen.push(id);
				if (id === "tool-1") throw new Error("not a message");
				return { seq: 11, topLevelMessageId: id };
			},
			fetchToolMessage: async (toolUseId) => {
				expect(toolUseId).toBe("tool-1");
				return { messageId: "owner" };
			},
		});
		expect(seen).toEqual(["tool-1", "owner"]);
		expect(result).toEqual({ seq: 11, topLevelMessageId: "owner" });
	});

	it("tries the next candidate when one id resolves as neither", async () => {
		const result = await resolveJumpTargetSeq(["junk", "msg-real"], {
			fetchMessageLocation: async (id) => {
				if (id !== "real") throw new Error("not a message");
				return { seq: 3 };
			},
			fetchToolMessage: notFound,
		});
		expect(result).toEqual({ seq: 3, topLevelMessageId: undefined });
	});

	it("does not re-query the same id when the tool detail points back at it", async () => {
		let messageCalls = 0;
		const result = await resolveJumpTargetSeq(["x"], {
			fetchMessageLocation: async () => {
				messageCalls++;
				throw new Error("not a message");
			},
			fetchToolMessage: async () => ({ messageId: "x" }),
		});
		expect(messageCalls).toBe(1);
		expect(result).toBeNull();
	});

	it("rejects a non-finite seq rather than jumping to NaN", async () => {
		const result = await resolveJumpTargetSeq(["m"], {
			fetchMessageLocation: async () => ({ seq: Number.NaN }),
			fetchToolMessage: notFound,
		});
		expect(result).toBeNull();
	});

	it("returns null when nothing resolves", async () => {
		expect(
			await resolveJumpTargetSeq(["a", "b"], {
				fetchMessageLocation: notFound,
				fetchToolMessage: notFound,
			}),
		).toBeNull();
	});
});
