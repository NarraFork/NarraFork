import { describe, expect, it } from "bun:test";
import { AskInPassingDraftStore } from "./vlist-ask-in-passing-state";

describe("AskInPassingDraftStore", () => {
	it("keeps drafts and focus across row unsubscribe and paged-window absence", () => {
		const store = new AskInPassingDraftStore();
		const unsubscribe = store.subscribe(() => {});
		store.setValue("m", "unfinished question");
		store.requestFocus("m");
		unsubscribe();
		store.reconcile([]);
		store.reconcile([{ id: "other", contentJson: [] }]);
		expect(store.get("m")).toEqual({
			value: "unfinished question",
			phase: "editing",
			focusRequested: true,
		});
	});

	for (const first of ["submitting", "cancelling"] as const) {
		it(`${first} synchronously excludes both competing operations`, () => {
			const store = new AskInPassingDraftStore();
			store.setValue("m", " question ");
			expect(store.begin("m", first)?.value).toBe(" question ");
			expect(store.begin("m", "submitting")).toBeNull();
			expect(store.begin("m", "cancelling")).toBeNull();
			store.setValue("m", "must not overwrite busy draft");
			store.fail("m");
			expect(store.get("m")).toEqual({
				value: " question ",
				phase: "editing",
				focusRequested: false,
			});
			expect(store.begin("m", first)).not.toBeNull();
		});
	}

	it("rejects whitespace submission but permits cancellation without a draft", () => {
		const store = new AskInPassingDraftStore();
		store.setValue("m", "  \n ");
		expect(store.begin("m", "submitting")).toBeNull();
		expect(store.begin("empty", "cancelling")).not.toBeNull();
	});

	it("consumes a focus request only once, including repeated effect execution", () => {
		const store = new AskInPassingDraftStore();
		store.requestFocus("m");
		expect(store.consumeFocus("m")).toBe(true);
		expect(store.consumeFocus("m")).toBe(false);
		store.requestFocus("m");
		expect(store.consumeFocus("m")).toBe(false);
	});

	it("explicit resolution or deletion wins over a late failed request", () => {
		for (const terminal of ["resolved", "deleted"]) {
			const store = new AskInPassingDraftStore();
			store.setValue("m", "question");
			store.begin("m", "submitting");
			if (terminal === "deleted") store.forget("m");
			else
				store.reconcile([
					{ id: "m", contentJson: [{ type: "ask_in_passing", status: "resolved" }] },
				]);
			store.fail("m");
			expect(store.get("m")).toEqual({ value: "", phase: "editing", focusRequested: false });
		}
	});

	it("ignores unrelated, pending and malformed canonical data", () => {
		const store = new AskInPassingDraftStore();
		store.setValue("m", "question");
		store.reconcile([
			{
				id: "m",
				contentJson: [
					null,
					{},
					{ type: "other", status: "resolved" },
					{ type: "ask_in_passing", status: "pending" },
				],
			},
			{ id: 1 },
			{ id: "m", contentJson: "invalid" },
		]);
		expect(store.get("m").value).toBe("question");
	});
});
