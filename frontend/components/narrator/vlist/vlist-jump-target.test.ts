/**
 * vlist-jump-target.test.ts — Pins the id-resolution order for a jump.
 *
 * A jump target can be a `msg-` DOM id, a bare message id, or a tool use id (a
 * tool-only assistant turn renders no `msg-` node). Getting this order wrong is
 * invisible in the common case and breaks exactly the hard one — a search hit on
 * a tool call in history the list has not loaded — so each interpretation is
 * pinned here rather than left to the shell's integration path.
 */

import { describe, expect, it } from "bun:test";
import { jumpTargetMessageId, resolveJumpTargetSeq } from "./vlist-jump-target";

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
