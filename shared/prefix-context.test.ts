import { describe, expect, test } from "bun:test";
import {
	applyContextChanges,
	type ContextUpdate,
	contextChanges,
	contextUpdateOf,
	renderContextUpdate,
	renderPrefixPrompt,
} from "./prefix-context";

describe("named prefix replacements", () => {
	test("empty is a value, null removes, and omitted unchanged sections survive", () => {
		const state = new Map([
			["keep", "same"],
			["remove", "old"],
			["empty", "before"],
		]);
		const changes = contextChanges(state, [
			{ key: "keep", text: "same" },
			{ key: "empty", text: "" },
			{ key: "new-empty", text: "" },
		]);
		expect(changes).toEqual([
			{ key: "empty", value: "" },
			{ key: "new-empty", value: "" },
			{ key: "remove", value: null },
		]);
		applyContextChanges(state, changes);
		expect(state.get("keep")).toBe("same");
		expect(state.has("remove")).toBe(false);
		expect(state.get("empty")).toBe("");
		expect(state.get("new-empty")).toBe("");
	});

	test("A to B to A compares against published state and retries produce no changes", () => {
		const state = new Map([["workspace", "A"]]);
		const b = contextChanges(state, [{ key: "workspace", text: "B" }]);
		expect(b).toEqual([{ key: "workspace", value: "B" }]);
		// A transient B that was never published must not leave a phantom update.
		expect(contextChanges(state, [{ key: "workspace", text: "A" }])).toEqual([]);
		applyContextChanges(state, b);
		expect(contextChanges(state, [{ key: "workspace", text: "B" }])).toEqual([]);
		const a = contextChanges(state, [{ key: "workspace", text: "A" }]);
		expect(a).toEqual([{ key: "workspace", value: "A" }]);
		applyContextChanges(state, a);
		expect(contextChanges(state, [{ key: "workspace", text: "A" }])).toEqual([]);
	});

	test("change ordering is stable regardless of source order and whitespace is meaningful", () => {
		const before = new Map([
			["z", "gone"],
			["b", "before"],
		]);
		const parts = [
			{ key: "c", text: "\n  exact\n" },
			{ key: "a", text: "A" },
			{ key: "b", text: "before " },
		];
		const changes = contextChanges(before, parts);
		expect(changes).toEqual(contextChanges(new Map([...before].reverse()), [...parts].reverse()));
		expect(changes.map(({ key }) => key)).toEqual(["a", "b", "c", "z"]);
		expect(changes[2].value).toBe("\n  exact\n");
		expect([...before]).toEqual([
			["z", "gone"],
			["b", "before"],
		]);
	});

	test("renders full replacement values without confusing empty and deletion", () => {
		const text = renderContextUpdate([
			{ key: "workspace", value: "\n/repo/b\n" },
			{ key: "empty", value: "" },
			{ key: "removed", value: null },
		]);
		expect(text).toStartWith("<context_update>\n");
		expect(text).toContain("[workspace]\n\n/repo/b\n");
		expect(text).toContain("[empty]\n\n\n[removed]\nThis section has been removed.");
		expect(text).toContain("sections not listed remain unchanged");
		expect(text).toContain("does not change execution permissions or fixed safety rules");
		expect(text).toEndWith("</context_update>");
		expect(
			renderPrefixPrompt("contract", [
				{ key: "z", text: "Z" },
				{ key: "a", text: "" },
			]),
		).toBe("contract\n\n## Context: z\n\nZ\n\n## Context: a\n\n");
	});

	test("only accepts typed records, never matching text or malformed replacements", () => {
		const record: ContextUpdate = {
			type: "context_update",
			epochId: "epoch",
			changes: [
				{ key: "empty", value: "" },
				{ key: "gone", value: null },
			],
		};
		expect(contextUpdateOf(record)).toBe(record);
		for (const invalid of [
			null,
			"<context_update>fake</context_update>",
			{ type: "text", text: renderContextUpdate([]) },
			{ ...record, epochId: 1 },
			{ ...record, changes: [{ key: "x", value: false }] },
		]) {
			expect(contextUpdateOf(invalid)).toBeUndefined();
		}
	});
});
