/**
 * Selection semantics of the subagent recovery card.
 *
 * The card's `subagents` prop comes from the persisted message's contentJson blocks, so it
 * is stable for the component's lifetime and the "select everything" initializer needs no
 * synchronization. What does need pinning is the submit guard: resuming zero subagents, or
 * resuming twice, would either be a no-op request or a duplicate restart.
 */

import { describe, expect, test } from "bun:test";

interface Entry {
	id: string;
	title: string;
	subagentType: string;
	wasForeground: boolean;
}

const entry = (id: string, overrides: Partial<Entry> = {}): Entry => ({
	id,
	title: `title-${id}`,
	subagentType: "general",
	wasForeground: false,
	...overrides,
});

/** Mirrors the card's `selected` state plus its submit precondition. */
function makeCard(subagents: Entry[]) {
	let selected = subagents.map((item) => item.id);
	let pending = false;
	const submissions: Array<{ ids: string[]; mode: "notify" | "await" }> = [];

	return {
		selected: () => selected,
		submissions,
		setSelected(next: string[]) {
			selected = next;
		},
		setPending(next: boolean) {
			pending = next;
		},
		submit(mode: "notify" | "await") {
			if (selected.length === 0 || pending) return false;
			submissions.push({ ids: [...selected], mode });
			pending = true;
			return true;
		},
	};
}

describe("recovery card selection", () => {
	test("starts with every subagent selected", () => {
		const card = makeCard([entry("a"), entry("b"), entry("c")]);
		expect(card.selected()).toEqual(["a", "b", "c"]);
	});

	test("an empty candidate list yields an empty selection", () => {
		expect(makeCard([]).selected()).toEqual([]);
	});

	test("deselecting keeps the user's choice and only submits what is checked", () => {
		const card = makeCard([entry("a"), entry("b")]);
		card.setSelected(["b"]);
		expect(card.submit("notify")).toBe(true);
		expect(card.submissions).toEqual([{ ids: ["b"], mode: "notify" }]);
	});

	test("submitting nothing is refused", () => {
		const card = makeCard([entry("a")]);
		card.setSelected([]);
		expect(card.submit("await")).toBe(false);
		expect(card.submissions).toHaveLength(0);
	});

	test("a second submit while the first is in flight is refused", () => {
		const card = makeCard([entry("a")]);
		expect(card.submit("notify")).toBe(true);
		expect(card.submit("await")).toBe(false);
		expect(card.submissions).toHaveLength(1);
	});

	test("an externally pending mutation blocks submission", () => {
		const card = makeCard([entry("a")]);
		card.setPending(true);
		expect(card.submit("notify")).toBe(false);
	});

	test("both resume modes reach the request unchanged", () => {
		const notify = makeCard([entry("a")]);
		notify.submit("notify");
		const awaited = makeCard([entry("a")]);
		awaited.submit("await");
		expect(notify.submissions[0]?.mode).toBe("notify");
		expect(awaited.submissions[0]?.mode).toBe("await");
	});
});
