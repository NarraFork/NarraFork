import { describe, expect, test } from "bun:test";
import {
	clampReasoningEffort,
	REASONING_EFFORT_RANK,
	type ReasoningEffort,
} from "../../shared/reasoning-effort";

describe("clampReasoningEffort", () => {
	test("returns desired unchanged when supported", () => {
		expect(clampReasoningEffort("high", ["low", "medium", "high", "xhigh"])).toBe("high");
	});

	test("returns desired unchanged when supported list is empty", () => {
		expect(clampReasoningEffort("max", [])).toBe("max");
	});

	test("clamps a too-high desired down to the highest available tier", () => {
		// Codex models without a max tier: max → xhigh.
		expect(clampReasoningEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
	});

	test("clamps a too-low desired up to the lowest available tier", () => {
		// mini model starts at medium: low → medium.
		expect(clampReasoningEffort("low", ["medium", "high"])).toBe("medium");
	});

	test("Anthropic has no xhigh — tie prefers the higher tier (max)", () => {
		// xhigh (rank 4) is equidistant from high (rank 3) and max (rank 5).
		// The 就近、并列偏高 rule sends it to max.
		expect(clampReasoningEffort("xhigh", ["low", "medium", "high", "max"])).toBe("max");
	});

	test("picks the strictly nearest tier when not a tie", () => {
		// medium (rank 2) nearest to high (rank 3, dist 1) over max (rank 5, dist 3).
		expect(clampReasoningEffort("medium", ["high", "max"])).toBe("high");
	});

	test("DeepSeek two-tier: low → high, xhigh → max", () => {
		expect(clampReasoningEffort("low", ["high", "max"])).toBe("high");
		expect(clampReasoningEffort("xhigh", ["high", "max"])).toBe("max");
	});

	test("rank order is strictly ascending", () => {
		const order: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
		for (let i = 1; i < order.length; i++) {
			expect(REASONING_EFFORT_RANK[order[i]]).toBeGreaterThan(REASONING_EFFORT_RANK[order[i - 1]]);
		}
	});
});
