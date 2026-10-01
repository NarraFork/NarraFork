import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type BufferMessageSummary } from "../../../lib/api";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";
import {
	type UseNarratorSendOptions,
	type UseNarratorSendResult,
	useNarratorSend,
} from "./use-narrator-send";

let root: Root;
let actions: UseNarratorSendResult;
let options: UseNarratorSendOptions;
let queue: BufferMessageSummary[];
let send: ReturnType<typeof spyOn<typeof api, "sendNarratorMessage">>;
let notify: ReturnType<typeof spyOn<typeof notifications, "show">>;
const originals = new Map<string, PropertyDescriptor | undefined>();
const reference = { id: "ref", deviceId: "remote", path: "/work/a.ts", label: "a.ts" };

function Probe(props: UseNarratorSendOptions) {
	actions = useNarratorSend(props);
	return null;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	queue = [
		{ id: "existing", text: "older input", bufferedAt: "2026-01-01T00:00:00Z", imageCount: 0 },
	];
	send = spyOn(api, "sendNarratorMessage").mockResolvedValue({ buffered: true, id: "replacement" });
	notify = spyOn(notifications, "show").mockReturnValue("notification");
	const composer: NarratorComposerHandle = {
		getText: () => "replace",
		getFileReferences: () => [reference],
		isTextEmpty: () => false,
		ownsTextarea: () => false,
		focus: mock(() => {}),
		setText: mock(() => {}),
		setFileReferences: mock(() => {}),
		restoreInput: mock(() => {}),
		addFileReference: mock(() => {}),
		appendText: mock(() => {}),
		clearTextAndDraft: mock(() => {}),
		hideTextForSend: mock(() => {}),
		commitDraftAfterSend: mock(() => {}),
		noteSent: mock(() => {}),
		handleDraftChanged: mock(() => {}),
	};
	options = {
		narratorId: "n",
		composerRef: { current: composer },
		attachedImages: [],
		attachedTextFiles: [],
		attachedImagesRef: { current: [] },
		attachedTextFilesRef: { current: [] },
		updateAttachedImages: mock(() => {}),
		updateAttachedTextFiles: mock(() => {}),
		hideAttachedFilesForSend: mock(() => {}),
		clearAttachedFilesAndDraft: mock(() => {}),
		sendingRef: { current: false },
		setQueuedMessages: (update) => {
			queue = typeof update === "function" ? update(queue) : update;
		},
		reconcileBufferedMessages: mock(() => {}),
		scrollToBottom: mock(() => {}),
		isActive: true,
		isSubagent: false,
		isTakenOver: false,
		showCompactQueueChoice: false,
		canRetryLastUserMessage: false,
		canContinueNarrator: false,
		fetchedNarrator: null,
		narrator: null,
		chapterWorktreePath: null,
		currentUser: null,
		enterQueueMode: "interrupt",
		ctrlEnterQueueMode: "tool",
		createNarrator: { mutateAsync: mock(async () => ({ id: "created" })) },
		interruptNarrator: { mutateAsync: mock(async () => ({ settled: true })) },
		registerSubmitToNarrator: undefined,
		setNarratorWorking: mock(() => {}),
		navigateToNarrator: mock(() => {}),
		normalizeBooleanOverride: () => "inherit",
		normalizeDangerReflectionOverride: () => "inherit",
		t: ((key: string) => key) as TFunction<"narrator">,
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	send.mockRestore();
	notify.mockRestore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(overrides: Partial<UseNarratorSendOptions> = {}) {
	options = { ...options, ...overrides };
	await act(async () => root.render(<Probe {...options} />));
}

describe("narrator interrupt send", () => {
	test("primary sends once without a separate stop and prepends the prioritized replacement", async () => {
		await render();
		await act(async () => actions.handleSend());
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]).toEqual([
			"n",
			"replace",
			undefined,
			undefined,
			true,
			expect.any(Function),
			expect.any(AbortSignal),
			[reference],
			true,
		]);
		expect(queue.map((message) => message.id)).toEqual(["replacement", "existing"]);
		expect(queue[0]).toMatchObject({ priority: true, fileReferences: [reference] });
		expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
	});

	test.each([
		"turn",
		"tool",
		"interrupt",
	] as const)("after stopping, idle primary preserves %s queue intent", async (mode) => {
		await render();
		// A stop leaves earlier buffered messages pending after status turns idle.
		await render({ isActive: false });
		await act(async () => {
			await actions.handleSendWithModeRef.current(mode);
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]).toEqual([
			"n",
			"replace",
			undefined,
			undefined,
			mode !== "turn",
			expect.any(Function),
			expect.any(AbortSignal),
			[reference],
			mode === "interrupt" ? true : undefined,
		]);
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(
			mode === "turn" ? ["existing", "replacement"] : ["replacement", "existing"],
		);
		expect(queue.find((message) => message.id === "replacement")?.priority).toBe(
			mode === "turn" ? undefined : true,
		);
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
		expect(options.clearAttachedFilesAndDraft).toHaveBeenCalledTimes(1);
		expect(options.reconcileBufferedMessages).toHaveBeenCalledTimes(1);
	});

	test.each([
		"turn",
		"tool",
		"interrupt",
	] as const)("idle compaction %s mode never hard-interrupts the compaction", async (mode) => {
		await render({ isActive: false, showCompactQueueChoice: true });
		await act(async () => {
			await actions.handleSendWithModeRef.current(mode);
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[4]).toBe(mode !== "turn");
		expect(send.mock.calls[0]?.[8]).toBeUndefined();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
	});

	test.each([
		false,
		true,
	])("idle subagent never carries hard-interrupt intent (takenOver=%s)", async (isTakenOver) => {
		await render({ isActive: false, isSubagent: true, isTakenOver });
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[4]).toBe(true);
		expect(send.mock.calls[0]?.[8]).toBeUndefined();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
	});

	test("a pending request prevents duplicate inserts until acceptance", async () => {
		const pending = Promise.withResolvers<{ buffered: boolean; id: string }>();
		send.mockReturnValue(pending.promise);
		await render();
		let sending: Promise<void> | void;
		await act(async () => {
			sending = actions.handleSendWithModeRef.current("interrupt");
			await actions.handleSendWithModeRef.current("interrupt");
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(["existing"]);
		await act(async () => {
			pending.resolve({ buffered: true, id: "replacement" });
			await sending;
		});
		expect(queue.map((message) => message.id)).toEqual(["replacement", "existing"]);
		expect(options.sendingRef.current).toBe(false);
	});

	test("failed acceptance restores the draft and attachments without retrying or stopping", async () => {
		const file = new File(["note"], "note.txt");
		send.mockRejectedValue(new Error("upload failed"));
		await render({ attachedTextFiles: [file] });
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).toHaveBeenCalledWith("replace", [reference]);
		expect(options.updateAttachedTextFiles).toHaveBeenCalledWith([file]);
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(["existing"]);
		expect(options.sendingRef.current).toBe(false);
	});

	test.each(["turn", "tool"] as const)("%s mode does not request an interrupt", async (mode) => {
		await render();
		await act(async () => {
			await actions.handleSendWithModeRef.current(mode);
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[4]).toBe(mode === "tool");
		expect(send.mock.calls[0]?.[8]).toBeUndefined();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(
			mode === "tool" ? ["replacement", "existing"] : ["existing", "replacement"],
		);
	});

	test.each([
		false,
		true,
	])("subagent preserves existing queue behavior (takenOver=%s)", async (isTakenOver) => {
		await render({ isSubagent: true, isTakenOver });
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[4]).toBe(true);
		expect(send.mock.calls[0]?.[8]).toBeUndefined();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
	});
});

describe("control slash commands", () => {
	test.each([
		"/fork",
		"/compact",
	] as const)("%s runs its handler immediately without sending or touching attachments", async (command) => {
		const file = new File(["note"], "note.txt");
		const onForkCommand = mock(() => {});
		const onCompactCommand = mock(() => {});
		await render({ attachedTextFiles: [file], onForkCommand, onCompactCommand });
		const composer = options.composerRef.current as NarratorComposerHandle;
		composer.getText = () => command;
		composer.getFileReferences = () => [];
		await act(async () => actions.handleSend());
		expect(send).not.toHaveBeenCalled();
		expect(onForkCommand).toHaveBeenCalledTimes(command === "/fork" ? 1 : 0);
		expect(onCompactCommand).toHaveBeenCalledTimes(command === "/compact" ? 1 : 0);
		expect(composer.hideTextForSend).toHaveBeenCalledTimes(1);
		expect(composer.commitDraftAfterSend).toHaveBeenCalledTimes(1);
		// Staged attachments survive a control command for the next message.
		expect(options.hideAttachedFilesForSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(["existing"]);
	});

	test.each([
		"/fork",
		"/compact",
	] as const)("%s rejects file references and keeps the draft", async (command) => {
		const onForkCommand = mock(() => {});
		const onCompactCommand = mock(() => {});
		await render({ onForkCommand, onCompactCommand });
		(options.composerRef.current as NarratorComposerHandle).getText = () => command;
		await act(async () => actions.handleSend());
		expect(onForkCommand).not.toHaveBeenCalled();
		expect(onCompactCommand).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "sendFailed",
				message: "fileReferences.controlCommand",
				color: "red",
			}),
		);
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.sendingRef.current).toBe(false);
	});

	test("a control command without a registered handler is a no-op", async () => {
		await render();
		(options.composerRef.current as NarratorComposerHandle).getText = () => "/compact";
		(options.composerRef.current as NarratorComposerHandle).getFileReferences = () => [];
		await act(async () => actions.handleSend());
		expect(send).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
	});
});
