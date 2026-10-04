import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type BufferMessageSummary } from "../../../lib/api";
import { moveQueuedTurn, queuedMessageMode } from "./queue-message-mode";
import {
	type UseQueuedMessageActionsOptions,
	useQueuedMessageActions,
} from "./use-queued-message-actions";

const entry = (id: string, queueMode?: "turn" | "tool" | "interrupt"): BufferMessageSummary => ({
	id,
	text: id,
	imageCount: 0,
	bufferedAt: "2026-01-01",
	queueMode,
});
let root: Root;
let actions: ReturnType<typeof useQueuedMessageActions>;
let options: UseQueuedMessageActionsOptions;
let queue: BufferMessageSummary[];
const originals = new Map<string, PropertyDescriptor | undefined>();
function Probe() {
	actions = useQueuedMessageActions(options);
	return null;
}
beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	spyOn(notifications, "show").mockReturnValue("notice");
	queue = [entry("a"), entry("guide", "tool"), entry("b")];
	options = {
		narratorId: "n",
		queuedMessages: queue,
		setQueuedMessages: (update) => {
			queue = typeof update === "function" ? update(queue) : update;
		},
		reconcileBufferedMessages: mock(() => {}),
		cancelBuffer: mock(() => {}),
		composerRef: {
			current: { restoreInput: mock(() => {}) } as unknown as NonNullable<
				UseQueuedMessageActionsOptions["composerRef"]["current"]
			>,
		},
		handleSendRef: { current: mock(() => {}) },
		handleSendWithModeRef: { current: mock(() => {}) },
		ctrlEnterQueueModeRef: { current: "tool" },
		t: (key) => key,
	};
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	mock.restore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
test("legacy mode fallback prefers explicit mode", () => {
	expect(queuedMessageMode({ ...entry("a"), priority: true })).toBe("tool");
	expect(queuedMessageMode({ ...entry("a", "turn"), priority: true })).toBe("turn");
});
test("ordinary movement preserves guidance and rejects guidance drags", () => {
	expect(moveQueuedTurn(queue, "a", "b").map((m) => m.id)).toEqual(["b", "guide", "a"]);
	expect(moveQueuedTurn(queue, "guide", "a")).toBe(queue);
});
test("remove and clear never restore input, even on removal failure", async () => {
	spyOn(api, "removeBufferedMessage").mockRejectedValue(new Error("gone"));
	await act(async () => actions.handleRemoveQueued("a"));
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
	await act(async () => actions.handleCancelAllQueued());
	expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
	expect(queue).toEqual([]);
});
test("expansion remains user controlled as queue shrinks and grows", async () => {
	await act(async () => actions.setQueueExpanded(false));
	options = { ...options, queuedMessages: [entry("urgent", "interrupt")] };
	await act(async () => root.render(<Probe />));
	expect(actions.queueExpanded).toBe(false);
	await act(async () => actions.setQueueExpanded(true));
	options = { ...options, queuedMessages: [] };
	await act(async () => root.render(<Probe />));
	expect(actions.queueExpanded).toBe(true);
});
test("mode switch and accessible movement call API and refresh authoritative state", async () => {
	const mode = spyOn(api, "setBufferedMessageMode").mockResolvedValue({ ok: true });
	const reorder = spyOn(api, "reorderBufferedMessages").mockResolvedValue({ ok: true });
	let accepted: boolean | undefined;
	await act(async () => {
		accepted = await actions.handleChangeMode("a", "interrupt");
	});
	expect(accepted).toBe(true);
	expect(mode).toHaveBeenCalledWith("n", "a", "interrupt");
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
	await act(async () => actions.handleMoveQueued("b", -1));
	expect(reorder).toHaveBeenCalledWith("n", ["b", "guide", "a"]);
});

test("rejected mode changes do not claim urgent delivery or lose queue data", async () => {
	spyOn(api, "setBufferedMessageMode").mockRejectedValue(new Error("Message was claimed"));
	const snapshot = queue;
	let accepted: boolean | undefined;
	await act(async () => {
		accepted = await actions.handleChangeMode("a", "interrupt");
	});
	expect(accepted).toBe(false);
	expect(queue).toBe(snapshot);
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ title: "queuedModeFailed" }),
	);
});

test("edit conflict after consumption refreshes state without resurrecting the message", async () => {
	let rejectEdit: ((error: Error) => void) | undefined;
	spyOn(api, "updateBufferedMessage").mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				rejectEdit = reject;
			}),
	);
	const message = queue[0];
	let result: Promise<boolean> | undefined;
	await act(async () => {
		result = actions.handleSaveEditQueued(message, "edited draft", {
			keepImageIds: [],
			keepTextFiles: [],
			newImages: [],
			newTextFiles: [],
		});
	});
	expect(queue[0].text).toBe("edited draft");
	expect(queue[0].bufferedAt).toBe(message.bufferedAt);
	// WS consumed this entry while the edit request was pending.
	queue = queue.filter((entry) => entry.id !== message.id);
	await act(async () => {
		rejectEdit?.(new Error("409: already claimed"));
		expect(await result).toBe(false);
	});
	expect(queue.some((entry) => entry.id === message.id)).toBe(false);
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
	expect(notifications.show).toHaveBeenCalledWith({
		color: "red",
		title: "editQueuedFailed",
		message: "409: already claimed",
	});
});

test("successful edit also refreshes attachments and preserves acceptance time", async () => {
	spyOn(api, "updateBufferedMessage").mockResolvedValue({ ok: true });
	const message = queue[0];
	await act(async () => {
		expect(
			await actions.handleSaveEditQueued(message, "edited", {
				keepImageIds: [],
				keepTextFiles: [],
				newImages: [],
				newTextFiles: [],
			}),
		).toBe(true);
	});
	expect(queue[0].bufferedAt).toBe(message.bufferedAt);
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
});

test("remove and reorder failures refresh authoritative state and notify", async () => {
	spyOn(api, "removeBufferedMessage").mockRejectedValue(new Error("remove rejected"));
	spyOn(api, "reorderBufferedMessages").mockRejectedValue(new Error("reorder rejected"));
	await act(async () => actions.handleRemoveQueued("a"));
	expect(notifications.show).toHaveBeenCalledWith({
		color: "red",
		title: "queuedRemoveFailed",
		message: "remove rejected",
	});
	await act(async () => actions.handleMoveQueued("b", -1));
	expect(notifications.show).toHaveBeenCalledWith({
		color: "red",
		title: "queuedReorderFailed",
		message: "reorder rejected",
	});
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(2);
});
