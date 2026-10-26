import { expect, spyOn, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVListLivePatches } from "./useVListLivePatches";

function row(narratorId = "n1"): TreeMessage {
	return {
		id: "m1",
		narratorId,
		role: "assistant",
		parentToolUseId: null,
		contentText: null,
		toolCalls: [],
		createdAt: "2026-10-01T00:00:00Z",
		stateRevision: 0,
		blocks: [
			{
				id: "persistent-b",
				kind: "reasoning",
				subtype: null,
				phase: "done",
				revision: 2,
				wireId: null,
				attemptId: null,
				hasOriginal: false,
				named: true,
				elements: [
					{ type: "reasoning", id: "element", text: "abcdef", translationGeneration: "g" },
				],
			},
		],
	};
}

function patch(start: number, stateRevision: number) {
	return {
		type: "reasoning_translation_patch",
		narratorId: "n1",
		ownerNarratorId: "n1",
		messageId: "m1",
		blockId: "persistent-b",
		elementId: "element",
		blockRevision: 2,
		stateRevision,
		translationGeneration: "g",
		part: {
			id: `p${start}`,
			generation: "g",
			start,
			end: start + 3,
			sourceText: start === 0 ? "abc" : "def",
			translatedText: start === 0 ? "甲" : "乙",
		},
	};
}

test("completed-part WS queue survives late checkpoints and remains narrator scoped", async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	let nextRaf = 0;
	const frames = new Map<number, FrameRequestCallback>();
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextRaf, callback);
			return nextRaf;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
	};
	const previous = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const subscribe = spyOn(narratorWSManager, "subscribe").mockImplementation((ids, options) => ({
		_id: 9876,
		_narratorIds: ids,
		_kind: options?.kind ?? "messages",
	}));
	const unsubscribe = spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
	const connection = spyOn(narratorWSManager, "onConnectionChange").mockImplementation(
		() => () => {},
	);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let current: readonly TreeMessage[] = [];
	let replace = (_rows: readonly TreeMessage[]) => {};
	let applications = 0;
	function Harness({ narratorId, enabled = true }: { narratorId: string; enabled?: boolean }) {
		const [messages, setMessages] = useState<readonly TreeMessage[]>([]);
		current = messages;
		replace = setMessages;
		useVListLivePatches(narratorId, {
			enabled,
			isSubagent: false,
			messages,
			applyLivePatch: (livePatch) => {
				const result = livePatch(current);
				if (result.changed) {
					applications++;
					current = result.messages;
					setMessages(result.messages);
				}
				return result.changed;
			},
		});
		return null;
	}
	const raf = async () => {
		await act(async () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(performance.now());
		});
	};
	const frame = async (value: Record<string, unknown>) => {
		await act(async () => narratorWSManager.dispatchLocalFrame(value as never));
	};
	try {
		await act(async () => root.render(<Harness narratorId="n1" enabled={false} />));
		await act(async () => root.render(<Harness narratorId="n1" />));
		await raf();
		// Parts can arrive before the owning persisted row, in global-state reverse order.
		await frame(patch(3, 9));
		await frame(patch(0, 7));
		await raf();
		expect(current).toHaveLength(0);
		await act(async () => replace([row()]));
		await raf();
		expect(messageBody(current[0])[0].translationParts).toHaveLength(2);
		expect(current[0].stateRevision).toBe(9);
		expect(applications).toBe(1);
		// An already-started page/checkpoint is allowed to carry older state.
		await act(async () => replace([row()]));
		await raf();
		expect(messageBody(current[0])[0].translationParts).toHaveLength(2);
		const beforeDuplicate = applications;
		await frame(patch(0, 7));
		await raf();
		expect(applications).toBe(beforeDuplicate);
		await frame(patch(0, 7));
		await act(async () => {
			root.render(<Harness narratorId="n2" />);
			replace([row("n2")]);
		});
		await raf();
		expect(current[0].narratorId).toBe("n2");
		expect(messageBody(current[0])[0].translationParts).toBeUndefined();
		await frame(patch(3, 10));
		await raf();
		expect(messageBody(current[0])[0].translationParts).toBeUndefined();
	} finally {
		await act(async () => root.unmount());
		container.remove();
		subscribe.mockRestore();
		unsubscribe.mockRestore();
		connection.mockRestore();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
