import { describe, expect, test } from "bun:test";
import { MAX_EXPANDED_NODES, resolveExpandRequest } from "./expand-limit";

describe("resolveExpandRequest", () => {
	test("empty set → expand", () => {
		expect(resolveExpandRequest(new Set(), "chap_1")).toEqual({ action: "expand" });
	});

	test("already expanded → collapse", () => {
		expect(resolveExpandRequest(new Set(["chap_1"]), "chap_1")).toEqual({ action: "collapse" });
	});

	test("below the limit → expand", () => {
		const expanded = new Set(["a", "b"]);
		expect(resolveExpandRequest(expanded, "chap_1", 4)).toEqual({ action: "expand" });
	});

	test("at the limit → refuse, echoing the limit", () => {
		const expanded = new Set(["a", "b", "c", "d"]);
		expect(resolveExpandRequest(expanded, "chap_1", 4)).toEqual({
			action: "refuse",
			reason: "limit",
			limit: 4,
		});
	});

	test("collapsing is allowed at the limit (otherwise the user is stranded)", () => {
		const expanded = new Set(["a", "b", "c", "d"]);
		expect(resolveExpandRequest(expanded, "d", 4)).toEqual({ action: "collapse" });
	});

	test("over the limit (stale state) still refuses new expansions", () => {
		const expanded = new Set(["a", "b", "c", "d", "e"]);
		expect(resolveExpandRequest(expanded, "chap_1", 4).action).toBe("refuse");
	});

	test("defaults to MAX_EXPANDED_NODES", () => {
		const atDefault = new Set(Array.from({ length: MAX_EXPANDED_NODES }, (_, i) => `chap_${i}`));
		expect(resolveExpandRequest(atDefault, "new").action).toBe("refuse");

		const belowDefault = new Set(
			Array.from({ length: MAX_EXPANDED_NODES - 1 }, (_, i) => `chap_${i}`),
		);
		expect(resolveExpandRequest(belowDefault, "new").action).toBe("expand");
	});

	test("limit 0 refuses every expansion but still permits collapse", () => {
		expect(resolveExpandRequest(new Set(), "chap_1", 0).action).toBe("refuse");
		expect(resolveExpandRequest(new Set(["chap_1"]), "chap_1", 0).action).toBe("collapse");
	});
});
