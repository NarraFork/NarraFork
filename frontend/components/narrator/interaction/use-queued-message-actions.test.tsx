import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type BufferMessageSummary } from "../../../lib/api";
import { ApiError } from "../../../lib/api/client";
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
	spyOn(api, "beginBufferedMessageEdit").mockImplementation(async (_narrator, _message, token) => ({
		ok: true,
		token,
		expiresAt: Date.now() + 120_000,
		leaseMs: 120_000,
		contentRevision: 0,
	}));
	spyOn(api, "renewBufferedMessageEdit").mockImplementation(async (_narrator, _message, token) => ({
		ok: true,
		token,
		expiresAt: Date.now() + 120_000,
		leaseMs: 120_000,
		contentRevision: 0,
	}));
	spyOn(api, "releaseBufferedMessageEdit").mockResolvedValue({ ok: true });
	spyOn(api, "clearBufferedMessages").mockResolvedValue({ ok: true });
	spyOn(api, "getBufferedMessages").mockImplementation(async () => queue);
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
	await act(async () => actions.handleStartEditQueued(message));
	let result: Promise<boolean> | undefined;
	await act(async () => {
		result = actions.handleSaveEditQueued(message, "edited draft", {
			keepImageIds: [],
			keepTextFiles: [],
			newImages: [],
			newTextFiles: [],
		});
	});
	// Keep the accepted row untouched; the editor owns the unsaved draft.
	expect(queue[0].text).toBe(message.text);
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
	await act(async () => actions.handleStartEditQueued(message));
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

test("structured edit forwards the exact document and explicit empty keep lists; ok:false retains the draft", async () => {
	const update = spyOn(api, "updateBufferedMessage").mockResolvedValue({ ok: false });
	await act(async () => actions.handleStartEditQueued(queue[0]));
	const document = {
		version: 1 as const,
		paragraphs: [{ children: [{ type: "text" as const, text: " mixed body " }] }],
		assets: [],
	};
	const payload = {
		keepImageIds: [],
		keepTextFiles: [],
		newImages: [],
		newTextFiles: [],
		fileReferences: [],
		composerDocument: document,
	};
	await act(async () => {
		expect(await actions.handleSaveEditQueued(queue[0], " mixed body ", payload)).toBe(false);
	});
	expect(update).toHaveBeenCalledWith("n", "a", " mixed body ", payload, expect.any(String));
	expect(actions.editingQueuedId).toBe("a");
	expect(actions.queuedEditProtected).toBe(true);
	expect(update.mock.calls[0][3]?.composerDocument).toBe(document);
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

const editPayload = { keepImageIds: [], keepTextFiles: [], newImages: [], newTextFiles: [] };
const leaseResponse = (token: string, contentRevision = 0) => ({
	ok: true as const,
	token,
	expiresAt: Date.now() + 120_000,
	leaseMs: 120_000,
	contentRevision,
});

test("LAN HTTP without randomUUID uses getRandomValues for a UUIDv4 edit token", async () => {
	const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
	const entropy = mock((bytes: Uint8Array) => getRandomValues(bytes));
	originals.set("crypto", Object.getOwnPropertyDescriptor(globalThis, "crypto"));
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: { getRandomValues: entropy },
	});
	await act(async () => actions.handleStartEditQueued(queue[0]));
	const token = spyOn(api, "beginBufferedMessageEdit").mock.calls[0][2];
	expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	expect(entropy).toHaveBeenCalledTimes(1);
	expect(actions.editingQueuedId).toBe("a");
});

test.each([
	"acquiring",
	"active",
])("%s edit blocks mutations of every queue row, including urgent admission", async (phase) => {
	const admission = Promise.withResolvers<ReturnType<typeof leaseResponse>>();
	const begin = spyOn(api, "beginBufferedMessageEdit").mockReturnValue(admission.promise);
	const mode = spyOn(api, "setBufferedMessageMode").mockResolvedValue({
		ok: true,
		delivered: true,
	});
	const retry = spyOn(api, "retryBufferedMessage").mockResolvedValue({ ok: true, resumed: false });
	const remove = spyOn(api, "removeBufferedMessage").mockResolvedValue({ ok: true });
	const reorder = spyOn(api, "reorderBufferedMessages").mockResolvedValue({ ok: true });
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = actions.handleStartEditQueued(queue[0]);
	});
	if (phase === "active")
		await act(async () => {
			admission.resolve(leaseResponse(begin.mock.calls[0][2]));
			await pending;
		});
	const before = queue;
	await act(async () => {
		expect(await actions.handleChangeMode("b", "interrupt")).toBe(false);
		actions.handleRemoveQueued("b");
		await expect(actions.handleRetryQueued("b")).rejects.toThrow("queuedEditPaused");
		actions.handleMoveQueued("b", -1);
		actions.handleDragEndQueued({ active: { id: "b" }, over: { id: "a" } } as Parameters<
			typeof actions.handleDragEndQueued
		>[0]);
		await actions.handleCancelAllQueued();
	});
	expect(queue).toBe(before);
	expect(actions.queueMutationsDisabled).toBe(true);
	expect(actions.urgentDispatches).toEqual([]);
	for (const operation of [mode, retry, remove, reorder, api.clearBufferedMessages])
		expect(operation).not.toHaveBeenCalled();
	if (phase === "acquiring")
		await act(async () => {
			admission.resolve(leaseResponse(begin.mock.calls[0][2]));
			await pending;
		});
});

test("mixed clear waits for each delete ACK, preserves urgent rows, and reconciles once", async () => {
	queue = [...queue, entry("urgent", "interrupt")];
	options = { ...options, queuedMessages: queue };
	await act(async () => root.render(<Probe />));
	const first = Promise.withResolvers<void>();
	let inflight = 0;
	let maximum = 0;
	const remove = spyOn(api, "removeBufferedMessage").mockImplementation(async (_n, id) => {
		inflight++;
		maximum = Math.max(maximum, inflight);
		try {
			if (id === "a") await first.promise;
			return { ok: true };
		} finally {
			inflight--;
		}
	});
	let clearing: Promise<void> | undefined;
	await act(async () => {
		clearing = actions.handleCancelAllQueued();
	});
	expect(remove.mock.calls.map((call) => call[1])).toEqual(["a"]);
	expect(queue.map((message) => message.id)).toEqual(["a", "guide", "b", "urgent"]);
	await act(async () => actions.handleCancelAllQueued());
	expect(remove).toHaveBeenCalledTimes(1);
	await act(async () => {
		first.resolve();
		await clearing;
	});
	expect(remove.mock.calls.map((call) => call[1])).toEqual(["a", "guide", "b"]);
	expect(maximum).toBe(1);
	expect(queue.map((message) => message.id)).toEqual(["urgent"]);
	expect(api.clearBufferedMessages).not.toHaveBeenCalled();
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
});

test.each([
	"reject",
	"ok:false",
])("mixed clear %s retains failed/unattempted rows and reports failure", async (failure) => {
	queue = [...queue, entry("urgent", "interrupt")];
	options = { ...options, queuedMessages: queue };
	await act(async () => root.render(<Probe />));
	const remove = spyOn(api, "removeBufferedMessage")
		.mockResolvedValueOnce({ ok: true })
		.mockImplementationOnce(async () => {
			if (failure === "reject") throw new Error("mutation denied");
			return { ok: false };
		});
	await act(async () => actions.handleCancelAllQueued());
	expect(remove.mock.calls.map((call) => call[1])).toEqual(["a", "guide"]);
	expect(queue.map((message) => message.id)).toEqual(["guide", "b", "urgent"]);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ color: "red", title: "queuedRemoveFailed" }),
	);
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
});

test("ordinary clear stays a single request and failure does not hide unacknowledged rows", async () => {
	const clear = spyOn(api, "clearBufferedMessages").mockRejectedValue(new Error("clear denied"));
	const remove = spyOn(api, "removeBufferedMessage").mockResolvedValue({ ok: true });
	const before = queue;
	await act(async () => actions.handleCancelAllQueued());
	expect(clear).toHaveBeenCalledTimes(1);
	expect(remove).not.toHaveBeenCalled();
	expect(queue).toBe(before);
	expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "clear denied" }),
	);
});

for (const [status, code, refused] of [
	[409, "BUFFER_EDIT_CONFLICT", true],
	[409, "UNKNOWN", false],
	[504, "BUFFER_EDIT_CONFLICT", false],
] as const) {
	test(`urgent ${status}/${code} only rolls back a definite edit conflict`, async () => {
		spyOn(api, "setBufferedMessageMode").mockRejectedValue(
			new ApiError("protected by another client", status, { code }),
		);
		await act(async () => {
			expect(await actions.handleChangeMode("a", "interrupt")).toBe(false);
		});
		expect(actions.visibleQueuedMessages.some((message) => message.id === "a")).toBe(refused);
		expect(actions.urgentDispatches).toHaveLength(refused ? 0 : 1);
		if (!refused) expect(actions.urgentDispatches[0].status).toBe("failed");
		expect(queue[0].queueMode).toBeUndefined();
	});
}

test.each([
	"reacquire",
	"save",
	"renew",
])("BUFFER_EDIT_STALE during %s latches the original draft revision until explicit exit", async (trigger) => {
	const tick = captureRenewal();
	const begin = spyOn(api, "beginBufferedMessageEdit").mockImplementation(async (_n, _m, token) =>
		leaseResponse(token, 7),
	);
	const renew = spyOn(api, "renewBufferedMessageEdit").mockRejectedValue(new Error("lease lost"));
	const update = spyOn(api, "updateBufferedMessage").mockResolvedValue({ ok: true });
	await act(async () => actions.handleStartEditQueued(queue[0]));
	expect(begin.mock.calls[0][3]).toBeUndefined();
	const stale = new ApiError("content changed", 409, { code: "BUFFER_EDIT_STALE" });
	if (trigger === "reacquire") {
		await act(async () => tick());
		begin.mockRejectedValueOnce(stale);
		await act(async () => actions.handleStartEditQueued(queue[0]));
		expect(begin.mock.calls[1][3]).toBe(7);
	} else if (trigger === "save") {
		update.mockRejectedValueOnce(stale);
		await act(async () => {
			expect(await actions.handleSaveEditQueued(queue[0], "my draft", editPayload)).toBe(false);
		});
	} else {
		renew.mockRejectedValueOnce(stale);
		await act(async () => tick());
	}
	expect(actions.editingQueuedId).toBe("a");
	expect(actions.queuedEditProtected).toBe(false);
	expect(actions.queuedEditStale).toBe(true);
	expect(actions.queuedEditError).toBe("queuedEditStale");
	const begins = begin.mock.calls.length;
	const saves = update.mock.calls.length;
	await act(async () => {
		await actions.handleStartEditQueued(queue[0]);
		expect(await actions.handleSaveEditQueued(queue[0], "cannot overwrite", editPayload)).toBe(
			false,
		);
	});
	expect(begin).toHaveBeenCalledTimes(begins);
	expect(update).toHaveBeenCalledTimes(saves);
	await act(async () => actions.handleCancelEditQueued());
	begin.mockImplementation(async (_n, _m, token) => leaseResponse(token, 8));
	await act(async () => actions.handleStartEditQueued(queue[0]));
	expect(begin.mock.calls.at(-1)?.[3]).toBeUndefined();
	expect(actions.queuedEditProtected).toBe(true);
	expect(actions.queuedEditStale).toBe(false);
});

test("a mismatched successful reacquire response cannot replace the original revision baseline", async () => {
	const tick = captureRenewal();
	const begin = spyOn(api, "beginBufferedMessageEdit").mockImplementation(async (_n, _m, token) =>
		leaseResponse(token, 7),
	);
	spyOn(api, "renewBufferedMessageEdit").mockRejectedValue(new Error("lease lost"));
	await act(async () => actions.handleStartEditQueued(queue[0]));
	await act(async () => tick());
	begin.mockImplementationOnce(async (_n, _m, token) => leaseResponse(token, 8));
	await act(async () => actions.handleStartEditQueued(queue[0]));
	expect(begin.mock.calls[1][3]).toBe(7);
	expect(actions.queuedEditStale).toBe(true);
	expect(actions.queuedEditProtected).toBe(false);
	expect(api.getBufferedMessages).toHaveBeenCalledTimes(1);
});

test("edit waits for server protection and fresh row, and duplicate clicks share one token", async () => {
	const admission = Promise.withResolvers<ReturnType<typeof leaseResponse>>();
	const begin = spyOn(api, "beginBufferedMessageEdit").mockReturnValue(admission.promise);
	const snapshot = Promise.withResolvers<BufferMessageSummary[]>();
	spyOn(api, "getBufferedMessages").mockReturnValue(snapshot.promise);
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = actions.handleStartEditQueued(queue[0]);
		void actions.handleStartEditQueued(queue[0]);
	});
	expect(begin).toHaveBeenCalledTimes(1);
	expect(actions.editingQueuedId).toBeNull();
	expect(actions.startingQueuedId).toBe("a");
	const token = begin.mock.calls[0][2];
	expect(token).toMatch(/^[0-9a-f-]{36}$/);
	await act(async () => admission.resolve(leaseResponse(token)));
	expect(actions.editingQueuedId).toBeNull();
	await act(async () => {
		snapshot.resolve([{ ...entry("a"), text: "latest accepted text" }]);
		await pending;
	});
	expect(actions.editingQueuedId).toBe("a");
	expect(actions.queuedEditProtected).toBe(true);
	expect(queue[0].text).toBe("latest accepted text");
});

test("rapid A-B-A switching releases late admission before opening only the latest editor", async () => {
	const admission = Promise.withResolvers<ReturnType<typeof leaseResponse>>();
	const begin = spyOn(api, "beginBufferedMessageEdit")
		.mockReturnValueOnce(admission.promise)
		.mockImplementation(async (_n, _m, token) => leaseResponse(token));
	let latest: Promise<void> | undefined;
	await act(async () => {
		void actions.handleStartEditQueued(queue[0]);
	});
	await act(async () => {
		void actions.handleStartEditQueued(queue[2]);
		latest = actions.handleStartEditQueued(queue[0]);
	});
	expect(begin).toHaveBeenCalledTimes(1);
	await act(async () => {
		admission.resolve(leaseResponse(begin.mock.calls[0][2]));
		await latest;
	});
	expect(begin.mock.calls.map((args) => args[1])).toEqual(["a", "a"]);
	expect(begin.mock.calls[0][2]).not.toBe(begin.mock.calls[1][2]);
	expect(api.releaseBufferedMessageEdit).toHaveBeenCalledWith("n", "a", begin.mock.calls[0][2]);
	expect(actions.editingQueuedId).toBe("a");
});

test("late acquisition after unmount releases its original scope and never opens an editor", async () => {
	const admission = Promise.withResolvers<ReturnType<typeof leaseResponse>>();
	const begin = spyOn(api, "beginBufferedMessageEdit").mockReturnValue(admission.promise);
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = actions.handleStartEditQueued(queue[0]);
	});
	await act(async () => root.unmount());
	await act(async () => {
		admission.resolve(leaseResponse(begin.mock.calls[0][2]));
		await pending;
		await Promise.resolve();
	});
	expect(api.releaseBufferedMessageEdit).toHaveBeenCalledWith("n", "a", begin.mock.calls[0][2]);
	expect(api.getBufferedMessages).not.toHaveBeenCalled();
});

test("cancel releases a granted lease without waiting for a stalled fresh snapshot", async () => {
	const snapshot = Promise.withResolvers<BufferMessageSummary[]>();
	const get = spyOn(api, "getBufferedMessages").mockReturnValue(snapshot.promise);
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = actions.handleStartEditQueued(queue[0]);
	});
	expect(get).toHaveBeenCalledTimes(1);
	await act(async () => actions.handleCancelEditQueued());
	expect(get.mock.calls[0][1]?.aborted).toBe(true);
	expect(api.releaseBufferedMessageEdit).toHaveBeenCalledTimes(1);
	await act(async () => {
		snapshot.resolve(queue);
		await pending;
	});
	expect(actions.editingQueuedId).toBeNull();
	expect(actions.queuedEditLockedId).toBeUndefined();
});

test("narrator switch releases the old token and late results cannot overwrite the new editor", async () => {
	const admission = Promise.withResolvers<ReturnType<typeof leaseResponse>>();
	const begin = spyOn(api, "beginBufferedMessageEdit")
		.mockReturnValueOnce(admission.promise)
		.mockImplementation(async (_n, _m, token) => leaseResponse(token));
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = actions.handleStartEditQueued(queue[0]);
	});
	options = { ...options, narratorId: "other" };
	await act(async () => root.render(<Probe />));
	await act(async () => actions.handleStartEditQueued(queue[2]));
	await act(async () => {
		admission.resolve(leaseResponse(begin.mock.calls[0][2]));
		await pending;
	});
	expect(api.releaseBufferedMessageEdit).toHaveBeenCalledWith("n", "a", begin.mock.calls[0][2]);
	expect(actions.editingQueuedId).toBe("b");
	expect(actions.queuedEditProtected).toBe(true);
});

test("same-tick cancel followed by reopening waits for the cancelled token to release", async () => {
	const admission = Promise.withResolvers<ReturnType<typeof leaseResponse>>();
	const released = Promise.withResolvers<{ ok: true }>();
	const begin = spyOn(api, "beginBufferedMessageEdit")
		.mockReturnValueOnce(admission.promise)
		.mockImplementation(async (_n, _m, token) => leaseResponse(token));
	spyOn(api, "releaseBufferedMessageEdit")
		.mockReturnValueOnce(released.promise)
		.mockResolvedValue({ ok: true });
	let reopening: Promise<void> | undefined;
	await act(async () => {
		void actions.handleStartEditQueued(queue[0]);
	});
	await act(async () => {
		actions.handleCancelEditQueued();
		reopening = actions.handleStartEditQueued(queue[0]);
	});
	await act(async () => {
		admission.resolve(leaseResponse(begin.mock.calls[0][2]));
	});
	expect(begin).toHaveBeenCalledTimes(1);
	expect(actions.editingQueuedId).toBeNull();
	await act(async () => {
		released.resolve({ ok: true });
		await reopening;
	});
	expect(begin).toHaveBeenCalledTimes(2);
	expect(actions.editingQueuedId).toBe("a");
});

test("uncertain begin retries with the same token, not a new lease", async () => {
	const begin = spyOn(api, "beginBufferedMessageEdit")
		.mockRejectedValueOnce(new Error("network lost"))
		.mockImplementation(async (_n, _m, token) => leaseResponse(token));
	await act(async () => actions.handleStartEditQueued(queue[0]));
	expect(actions.editingQueuedId).toBeNull();
	await act(async () => actions.handleStartEditQueued(queue[0]));
	expect(begin.mock.calls[0][2]).toBe(begin.mock.calls[1][2]);
	expect(actions.editingQueuedId).toBe("a");
});

test("save failure keeps lease/editor and blocks cancel, switching, clear and edited-row delete while saving", async () => {
	await act(async () => actions.handleStartEditQueued(queue[0]));
	const save = Promise.withResolvers<{ ok: boolean }>();
	const update = spyOn(api, "updateBufferedMessage").mockReturnValue(save.promise);
	const remove = spyOn(api, "removeBufferedMessage").mockResolvedValue({ ok: true });
	let pending: Promise<boolean> | undefined;
	await act(async () => {
		pending = actions.handleSaveEditQueued(queue[0], "unsaved", editPayload);
		actions.handleCancelEditQueued();
		void actions.handleStartEditQueued(queue[2]);
		actions.handleRemoveQueued("a");
		actions.handleCancelAllQueued();
	});
	expect(actions.editingQueuedId).toBe("a");
	expect(remove).not.toHaveBeenCalled();
	expect(options.cancelBuffer).not.toHaveBeenCalled();
	expect(api.beginBufferedMessageEdit).toHaveBeenCalledTimes(1);
	expect(update).toHaveBeenCalledWith("n", "a", "unsaved", editPayload, expect.any(String));
	await act(async () => {
		save.reject(new Error("upload failed"));
		expect(await pending).toBe(false);
	});
	expect(actions.editingQueuedId).toBe("a");
	expect(actions.queuedEditProtected).toBe(true);
	expect(api.releaseBufferedMessageEdit).not.toHaveBeenCalled();
});

test.each([
	"retry",
	"cancel",
])("synchronous save errors release the busy ref so users can %s", async (next) => {
	await act(async () => actions.handleStartEditQueued(queue[0]));
	const update = spyOn(api, "updateBufferedMessage")
		.mockImplementationOnce(() => {
			throw new Error("synchronous validation failure");
		})
		.mockResolvedValue({ ok: true });
	await act(async () => {
		expect(await actions.handleSaveEditQueued(queue[0], "draft", editPayload)).toBe(false);
	});
	expect(actions.editingQueuedId).toBe("a");
	if (next === "retry") {
		await act(async () => {
			expect(await actions.handleSaveEditQueued(queue[0], "fixed", editPayload)).toBe(true);
		});
		expect(update).toHaveBeenCalledTimes(2);
	} else {
		await act(async () => actions.handleCancelEditQueued());
	}
	expect(actions.editingQueuedId).toBeNull();
	expect(actions.queuedEditLockedId).toBeUndefined();
	expect(api.releaseBufferedMessageEdit).toHaveBeenCalledTimes(1);
});

test("synchronous begin errors do not strand the acquisition ref", async () => {
	const begin = spyOn(api, "beginBufferedMessageEdit")
		.mockImplementationOnce(() => {
			throw new Error("synchronous begin failure");
		})
		.mockImplementation(async (_n, _m, token) => leaseResponse(token));
	await act(async () => actions.handleStartEditQueued(queue[0]));
	await act(async () => actions.handleStartEditQueued(queue[0]));
	expect(begin).toHaveBeenCalledTimes(2);
	expect(begin.mock.calls[0][2]).toBe(begin.mock.calls[1][2]);
	expect(actions.editingQueuedId).toBe("a");
});

test("synchronous renewal errors allow reacquisition and subsequent renewals", async () => {
	const tick = captureRenewal();
	const renew = spyOn(api, "renewBufferedMessageEdit")
		.mockImplementationOnce(() => {
			throw new Error("synchronous renewal failure");
		})
		.mockImplementation(async (_n, _m, token) => leaseResponse(token));
	await act(async () => actions.handleStartEditQueued(queue[0]));
	await act(async () => tick());
	expect(actions.queuedEditProtected).toBe(false);
	await act(async () => actions.handleStartEditQueued(queue[0]));
	await act(async () => tick());
	expect(renew).toHaveBeenCalledTimes(2);
	expect(actions.queuedEditProtected).toBe(true);
});

function captureRenewal() {
	let callback: (() => void) | undefined;
	spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, delay?: number) => {
		if (delay === 20_000) callback = handler;
		return 1;
	}) as typeof setInterval);
	return () => {
		if (!callback) throw new Error("renewal timer missing");
		callback();
	};
}

test("lost renewal retains the editor after WS consumption, blocks saving and reacquires with the same token", async () => {
	const tick = captureRenewal();
	const renew = spyOn(api, "renewBufferedMessageEdit").mockRejectedValue(
		new Error("lease missing"),
	);
	const update = spyOn(api, "updateBufferedMessage").mockResolvedValue({ ok: true });
	await act(async () => actions.handleStartEditQueued(queue[0]));
	const token = spyOn(api, "beginBufferedMessageEdit").mock.calls[0][2];
	await act(async () => tick());
	expect(renew).toHaveBeenCalledWith("n", "a", token);
	expect(actions.queuedEditProtected).toBe(false);
	expect(actions.queuedEditError).toContain("queuedEditProtectionLost");
	queue = [];
	options = { ...options, queuedMessages: queue };
	await act(async () => root.render(<Probe />));
	expect(actions.visibleQueuedMessages.map((row) => row.id)).toEqual(["a"]);
	await act(async () => {
		expect(await actions.handleSaveEditQueued(entry("a"), "retained draft", editPayload)).toBe(
			false,
		);
	});
	expect(update).not.toHaveBeenCalled();
	await act(async () => actions.handleStartEditQueued(entry("a")));
	expect(api.beginBufferedMessageEdit).toHaveBeenLastCalledWith("n", "a", token, 0);
	expect(actions.editingQueuedId).toBe("a");
	expect(actions.queuedEditProtected).toBe(true);
	expect(api.getBufferedMessages).toHaveBeenCalledTimes(1);
});

test("expired protection fails closed even when a renewal response is delayed", async () => {
	const tick = captureRenewal();
	const renewal = Promise.withResolvers<ReturnType<typeof leaseResponse>>();
	spyOn(api, "renewBufferedMessageEdit").mockReturnValue(renewal.promise);
	const update = spyOn(api, "updateBufferedMessage").mockResolvedValue({ ok: true });
	await act(async () => actions.handleStartEditQueued(queue[0]));
	await act(async () => tick());
	const now = Date.now();
	spyOn(Date, "now").mockReturnValue(now + 121_000);
	await act(async () => {
		expect(await actions.handleSaveEditQueued(queue[0], "expired", editPayload)).toBe(false);
	});
	expect(update).not.toHaveBeenCalled();
	await act(async () => {
		const token = spyOn(api, "beginBufferedMessageEdit").mock.calls[0][2];
		renewal.resolve(leaseResponse(token));
	});
	expect(actions.queuedEditProtected).toBe(false);
	expect(actions.editingQueuedId).toBe("a");
});

test("failed release prevents another admission and switching can retry safely", async () => {
	await act(async () => actions.handleStartEditQueued(queue[0]));
	const release = spyOn(api, "releaseBufferedMessageEdit")
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ ok: true });
	await act(async () => actions.handleStartEditQueued(queue[2]));
	expect(api.beginBufferedMessageEdit).toHaveBeenCalledTimes(1);
	expect(actions.editingQueuedId).toBeNull();
	expect(actions.queuedEditError).toContain("queuedEditReleaseFailed");
	await act(async () => actions.handleStartEditQueued(queue[2]));
	expect(release).toHaveBeenCalledTimes(2);
	expect(actions.editingQueuedId).toBe("b");
});
