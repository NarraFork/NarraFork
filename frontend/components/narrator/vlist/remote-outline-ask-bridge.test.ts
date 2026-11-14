import { expect, test } from "bun:test";
import { useOutlineAskSlots } from "./remote-outline-ask-bridge";

test("remote Outline Ask never inspects rows or mounts a form, even when explicitly enabled", () => {
	const options = {
		enabled: true,
		get renderItems(): readonly unknown[] {
			throw new Error("unbridged row traversal");
		},
		get tools(): ReadonlyMap<string, unknown> {
			throw new Error("unbridged question lookup");
		},
	};
	expect(useOutlineAskSlots(options).size).toBe(0);
});

test("remote Outline Ask preserves a stable empty slot map across changes", () => {
	const first = useOutlineAskSlots({ renderItems: [], tools: new Map(), enabled: false });
	const second = useOutlineAskSlots({
		renderItems: [{ spec: { kind: "tool-call" } }],
		tools: new Map([["tool", { outlineAsk: { questionRootIds: ["root"] } }]]),
		enabled: true,
	});
	expect(second).toBe(first);
	expect(second.size).toBe(0);
});
