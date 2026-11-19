import { describe, expect, test } from "bun:test";
import {
	REASONING_TRANSLATION_VISIBILITY_LIMITS,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";
import { NarratorWSManager } from "./narrator-ws-manager";

const target: ReasoningTranslationVisibilityTarget = {
	ownerNarratorId: "owner",
	messageId: "message",
	blockId: "block",
	elementId: "element",
};
function socket() {
	const manager = new NarratorWSManager();
	const sent: Record<string, unknown>[] = [];
	const internal = manager as unknown as {
		ws: { readyState: number; send(payload: string): void };
		_restoreSubscriptions(): void;
	};
	internal.ws = { readyState: WebSocket.OPEN, send: (payload) => sent.push(JSON.parse(payload)) };
	return { manager, internal, sent };
}
const flush = async () => {
	await Promise.resolve();
};

describe("reasoning visibility transport", () => {
	test("unavailable geometry revokes demand without interrupting socket restoration", async () => {
		const { manager, internal, sent } = socket();
		let available = true;
		const holder = manager.registerReasoningTranslationVisibility("viewer", "panel", () => {
			if (!available) throw new Error("geometry unavailable");
			return [target];
		});
		await flush();
		available = false;
		holder.update();
		await flush();
		expect(sent.at(-1)?.targets).toEqual([]);
		sent.length = 0;
		expect(() => internal._restoreSubscriptions()).not.toThrow();
		expect(sent).toEqual([]);
	});

	test("history subscriptions and cache restoration never create model demand", async () => {
		const { manager, internal, sent } = socket();
		manager.subscribe(["viewer"], { kind: "messages" });
		await flush();
		internal._restoreSubscriptions();
		expect(sent.some((frame) => frame.type === "subscribe")).toBe(true);
		expect(sent.some((frame) => frame.type === "reasoning_translation_visibility")).toBe(false);
	});

	test("holder updates are coalesced and token deltas do not repeat target identities", async () => {
		const { manager, sent } = socket();
		const holder = manager.registerReasoningTranslationVisibility("viewer", "panel", () => [
			target,
		]);
		holder.update();
		holder.update();
		await flush();
		expect(sent).toEqual([
			{
				type: "reasoning_translation_visibility",
				narratorId: "viewer",
				visibilityId: "panel",
				revision: 1,
				targets: [target],
				groups: [],
			},
		]);
		holder.update();
		await flush();
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toHaveProperty("locale");
		holder.dispose();
		expect(sent.at(-1)?.targets).toEqual([]);
	});

	test("empty target readers do not request translation on first mount or reconnect", async () => {
		const { manager, internal, sent } = socket();
		manager.registerReasoningTranslationVisibility("viewer", "panel", () => []);
		await flush();
		internal._restoreSubscriptions();
		expect(sent).toEqual([]);
	});

	test("reconnect reads current visibility rather than a retained target snapshot", async () => {
		const { manager, internal, sent } = socket();
		let visible = true;
		manager.registerReasoningTranslationVisibility("viewer", "panel", () =>
			visible ? [target] : [],
		);
		await flush();
		expect(sent).toHaveLength(1);
		sent.length = 0;
		visible = false;
		internal._restoreSubscriptions();
		expect(sent).toEqual([]);
		visible = true;
		internal._restoreSubscriptions();
		expect(sent).toHaveLength(1);
	});

	test("releasing one holder leaves another holder's demand intact", async () => {
		const { manager, internal, sent } = socket();
		const first = manager.registerReasoningTranslationVisibility("viewer", "first", () => [target]);
		manager.registerReasoningTranslationVisibility("viewer", "second", () => [target]);
		await flush();
		first.dispose();
		expect(sent.at(-1)).toMatchObject({ visibilityId: "first", targets: [] });
		sent.length = 0;
		internal._restoreSubscriptions();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ visibilityId: "second", targets: [target] });
	});

	test("unmount before a queued update sends no activation", async () => {
		const { manager, sent } = socket();
		const holder = manager.registerReasoningTranslationVisibility("viewer", "panel", () => [
			target,
		]);
		holder.dispose();
		await flush();
		expect(sent).toEqual([]);
	});

	test("per-frame targets stay within the shared protocol budget", async () => {
		const { manager, sent } = socket();
		const targets = Array.from({ length: 100 }, (_, index) => ({
			...target,
			elementId: `element-${index}`,
		}));
		manager.registerReasoningTranslationVisibility("viewer", "panel", () => targets);
		await flush();
		expect(sent[0]?.targets).toHaveLength(REASONING_TRANSLATION_VISIBILITY_LIMITS.targets);
		expect(targets).toHaveLength(100);
	});
});
