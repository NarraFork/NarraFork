import { describe, expect, test } from "bun:test";
import { CRUMB_ENDS, planCrumbs } from "./outline-crumbs";

const path = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`);

describe("planCrumbs", () => {
	test("a short path shows every ancestor and folds nothing", () => {
		for (const n of [0, 1, 2, 3]) {
			expect(planCrumbs(path(n))).toEqual({ head: path(n), hidden: [], tail: [] });
		}
	});

	test("a deep path keeps its two ends and folds the middle, in order", () => {
		expect(planCrumbs(path(4))).toEqual({ head: ["a1"], hidden: ["a2", "a3"], tail: ["a4"] });
		expect(planCrumbs(path(9))).toEqual({
			head: ["a1"],
			hidden: ["a2", "a3", "a4", "a5", "a6", "a7", "a8"],
			tail: ["a9"],
		});
	});

	test("however deep, at most the two ends are shown beside the fold", () => {
		for (const n of [4, 12, 200]) {
			const plan = planCrumbs(path(n));
			expect(plan.head.length + plan.tail.length).toBe(CRUMB_ENDS.head + CRUMB_ENDS.tail);
			// Nothing is lost or repeated.
			expect([...plan.head, ...plan.hidden, ...plan.tail]).toEqual(path(n));
		}
	});

	test("a fold never stands for a single crumb", () => {
		// Three ancestors with one end each would hide exactly one: shown instead.
		expect(planCrumbs(path(3)).hidden).toEqual([]);
		expect(planCrumbs(path(5), { head: 2, tail: 2 }).hidden).toEqual([]);
		expect(planCrumbs(path(6), { head: 2, tail: 2 })).toEqual({
			head: ["a1", "a2"],
			hidden: ["a3", "a4"],
			tail: ["a5", "a6"],
		});
	});
});
