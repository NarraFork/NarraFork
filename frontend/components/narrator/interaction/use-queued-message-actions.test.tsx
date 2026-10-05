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
	const mode = spyOn(api, "setBufferedMessageMode").mockResolvedValue({
		ok: true,
		delivered: true,
	});
	const reorder = spyOn(api, "reorderBufferedMessages").mockResolvedValue({ ok: true });
	let accepted: boolean | undefined;
	await act(async () => {
		accepted = await actions.handleChangeMode("a", "tool");
	});
	expect(accepted).toBe(true);
	expect(mode).toHaveBeenCalledWith("n", "a", "tool");
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
	await act(async () => actions.handleMoveQueued("b", -1));
	expect(reorder).toHaveBeenCalledWith("n", ["b", "a"]);
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

test("urgent dispatch hides ordinary rows, requires delivery ACK and suppresses stale snapshots", async () => {
	const receipt = Promise.withResolvers<{ ok: true; delivered: boolean }>();
	spyOn(api, "setBufferedMessageMode").mockReturnValue(receipt.promise);
	const message = {
		...queue[0],
		images: [{ imageId: "img", filename: "photo.png", mediaType: "image/png" }],
		textFiles: [{ index: 0, filename: "notes.txt", size: 10 }],
	};
	options = { ...options, queuedMessages: [message, ...queue.slice(1)] };
	await act(async () => root.render(<Probe />));
	let result: Promise<boolean> | undefined;
	await act(async () => {
		result = actions.handleChangeMode("a", "interrupt");
	});
	expect(actions.visibleQueuedMessages.map((m) => m.id)).toEqual(["guide", "b"]);
	expect(actions.urgentDispatches).toEqual([{ message, status: "sending" }]);
	await act(async () => {
		receipt.resolve({ ok: true, delivered: true });
		expect(await result).toBe(true);
	});
	expect(queue.map((m) => m.id)).toEqual(["guide", "b"]);
	expect(actions.urgentDispatches).toEqual([]);
	// Old buffer_set packets must not resurrect a confirmed delivery.
	await act(async () => root.render(<Probe />));
	expect(actions.visibleQueuedMessages.some((m) => m.id === "a")).toBe(false);
	expect(actions.urgentDispatches).toEqual([]);
});

test("legacy ok and timeout retain payload for retry rather than claim delivery", async () => {
	const mode = spyOn(api, "setBufferedMessageMode").mockResolvedValue({ ok: true });
	await act(async () => {
		expect(await actions.handleChangeMode("a", "interrupt")).toBe(false);
	});
	expect(queue.map((m) => m.id)).toContain("a");
	expect(actions.urgentDispatches[0].status).toBe("failed");
	mode.mockRejectedValueOnce(new Error("Timed out"));
	await act(async () => {
		expect(await actions.handleChangeMode("a", "interrupt")).toBe(false);
	});
	expect(actions.urgentDispatches[0].error).toBe("Timed out");
	mode.mockResolvedValueOnce({ ok: true, delivered: true });
	await act(async () => {
		expect(await actions.handleChangeMode("a", "interrupt")).toBe(true);
	});
	expect(actions.urgentDispatches).toEqual([]);
});

test("failed urgent admission is explicitly retried before another interrupt", async () => {
	options = { ...options, queuedMessages: [{ ...entry("a", "interrupt"), state: "failed" }] };
	await act(async () => root.render(<Probe />));
	const retry = spyOn(api, "retryBufferedMessage").mockResolvedValue({ ok: true, resumed: false });
	const mode = spyOn(api, "setBufferedMessageMode").mockImplementation(async () => {
		expect(retry).toHaveBeenCalledWith("n", "a");
		return { ok: true, delivered: true };
	});
	await act(async () => {
		expect(await actions.handleChangeMode("a", "interrupt")).toBe(true);
	});
	expect(mode).toHaveBeenCalledTimes(1);
});

test("late ACK cannot mutate another scope; unconfirmed failures never return to ordinary queue", async () => {
	const receipt = Promise.withResolvers<{ ok: true; delivered: boolean }>();
	spyOn(api, "setBufferedMessageMode").mockReturnValue(receipt.promise);
	let result: Promise<boolean> | undefined;
	await act(async () => {
		result = actions.handleChangeMode("a", "interrupt");
	});
	options = { ...options, narratorId: "other", queuedMessages: [entry("a")] };
	await act(async () => root.render(<Probe />));
	expect(actions.urgentDispatches).toEqual([]);
	await act(async () => {
		receipt.resolve({ ok: true, delivered: true });
		expect(await result).toBe(false);
	});
	expect(queue.map((m) => m.id)).toContain("a");
	expect(options.reconcileBufferedMessages).not.toHaveBeenCalled();
	const rejected = Promise.withResolvers<{ ok: true }>();
	spyOn(api, "setBufferedMessageMode").mockReturnValue(rejected.promise);
	await act(async () => {
		result = actions.handleChangeMode("a", "interrupt");
	});
	options = { ...options, queuedMessages: [] };
	await act(async () => root.render(<Probe />));
	await act(async () => {
		rejected.reject(new Error("Already consumed"));
		expect(await result).toBe(false);
	});
	expect(actions.urgentDispatches).toEqual([]);
	expect(actions.visibleQueuedMessages).toEqual([]);
	options = { ...options, queuedMessages: [entry("a", "interrupt")] };
	await act(async () => root.render(<Probe />));
	expect(actions.urgentDispatches[0].status).toBe("failed");
	expect(actions.visibleQueuedMessages).toEqual([]);
});

for (const status of [409, 504]) {
	test(`claimed row absent during ${status} failure returns as failed and can restore then dispatch`, async () => {
		const message: BufferMessageSummary = {
			...entry("a"),
			images: [{ imageId: "img", filename: "photo.png", mediaType: "image/png" }],
			textFiles: [{ index: 0, filename: "notes.txt", size: 10 }],
		};
		queue = [message];
		options = { ...options, queuedMessages: queue };
		await act(async () => root.render(<Probe />));
		const receipt = Promise.withResolvers<{ ok: true; delivered: boolean }>();
		const mode = spyOn(api, "setBufferedMessageMode").mockReturnValueOnce(receipt.promise);
		let result: Promise<boolean> | undefined;
		await act(async () => {
			result = actions.handleChangeMode("a", "interrupt");
		});
		// buffer_consumed is emitted at claim, before materialization is durable.
		queue = [];
		options = { ...options, queuedMessages: queue };
		await act(async () => root.render(<Probe />));
		expect(actions.urgentDispatches[0].status).toBe("sending");
		await act(async () => {
			receipt.reject(new Error(`${status}: materialization failed`));
			expect(await result).toBe(false);
		});
		expect(actions.urgentDispatches).toEqual([]);
		const restored: BufferMessageSummary = {
			...message,
			queueMode: "interrupt",
			state: "failed",
			error: "Materialization rolled back",
		};
		queue = [restored];
		options = { ...options, queuedMessages: queue };
		await act(async () => root.render(<Probe />));
		expect(queue).toEqual([restored]);
		expect(actions.visibleQueuedMessages).toEqual([]);
		expect(actions.urgentDispatches[0].status).toBe("failed");
		expect(actions.urgentDispatches[0].message).toBe(restored);
		expect(actions.urgentDispatches[0].message.images).toEqual(message.images);
		const retry = spyOn(api, "retryBufferedMessage").mockResolvedValue({
			ok: true,
			resumed: false,
		});
		mode.mockImplementationOnce(async () => {
			expect(retry).toHaveBeenCalledWith("n", "a");
			return { ok: true, delivered: true };
		});
		await act(async () => {
			expect(await actions.handleChangeMode("a", "interrupt")).toBe(true);
		});
		expect(queue).toEqual([]);
		expect(actions.urgentDispatches).toEqual([]);
		// Only the confirmed receipt now blocks a stale failed snapshot.
		options = { ...options, queuedMessages: [restored] };
		await act(async () => root.render(<Probe />));
		expect(actions.visibleQueuedMessages).toEqual([]);
		expect(actions.urgentDispatches).toEqual([]);
	});
}

test("ordinary movement and clear exclude a sending urgent message", async () => {
	const receipt = Promise.withResolvers<{ ok: true; delivered: boolean }>();
	spyOn(api, "setBufferedMessageMode").mockReturnValue(receipt.promise);
	const reorder = spyOn(api, "reorderBufferedMessages").mockResolvedValue({ ok: true });
	const remove = spyOn(api, "removeBufferedMessage").mockResolvedValue({ ok: true });
	const guidance = entry("guide", "tool");
	queue = [entry("a"), guidance, entry("pending"), entry("b")];
	options = { ...options, queuedMessages: queue };
	await act(async () => root.render(<Probe />));
	let result: Promise<boolean> | undefined;
	await act(async () => {
		result = actions.handleChangeMode("pending", "interrupt");
	});
	await act(async () => actions.handleMoveQueued("b", -1));
	expect(reorder).toHaveBeenCalledWith("n", ["b", "a"]);
	expect(queue.map((m) => m.id)).toEqual(["b", "guide", "pending", "a"]);
	expect(queue.find((message) => message.id === "guide")).toBe(guidance);
	expect(queue.find((message) => message.id === "pending")?.queueMode).toBeUndefined();
	await act(async () => actions.handleCancelAllQueued());
	expect(queue.map((m) => m.id)).toEqual(["pending"]);
	expect(remove.mock.calls).toEqual([
		["n", "a"],
		["n", "guide"],
		["n", "b"],
	]);
	expect(options.cancelBuffer).not.toHaveBeenCalled();
	await act(async () => {
		receipt.resolve({ ok: true, delivered: true });
		expect(await result).toBe(true);
	});
});

test("dispatch records remain bounded at 64", async () => {
	spyOn(api, "setBufferedMessageMode").mockResolvedValue({ ok: true, delivered: true });
	for (let index = 0; index < 70; index++) {
		options = { ...options, queuedMessages: [entry(String(index))] };
		await act(async () => root.render(<Probe />));
		await act(async () => {
			expect(await actions.handleChangeMode(String(index), "interrupt")).toBe(true);
		});
	}
	options = { ...options, queuedMessages: Array.from({ length: 70 }, (_, i) => entry(String(i))) };
	await act(async () => root.render(<Probe />));
	expect(actions.visibleQueuedMessages).toHaveLength(6);
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
