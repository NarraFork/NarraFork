import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { type ComposerDocument, composerDocumentText } from "@shared/composer-document";
import type { SavedRecording } from "@shared/request-recording";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance, type TFunction } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { useNarratorCommands } from "../../../hooks/useCommands";
import { api, type BufferMessageSummary } from "../../../lib/api";
import type { CommandItem } from "../composer/CommandPopover";
import { getComposerAssetId, loadDraftImageAttachments } from "../composer/draft-image-attachments";
import type { NarratorComposerHandle } from "../composer/NarratorComposer";
import {
	snapshotComposerFiles,
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
		localStorage: { getItem: () => null },
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
		captureAttachmentSelection: mock(() => {}),
		captureAttachmentInsertion: mock(() => undefined),
		insertAcceptedFiles: mock(() => false),
		getDocument: () => undefined,
		hasMissingAssets: () => false,
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
		handleDraftMeta: mock(() => {}),
	};
	options = {
		narratorId: "n",
		composerRef: { current: composer },
		attachedImages: [],
		attachedTextFiles: [],
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

describe("structured send snapshots", () => {
	function richDraft() {
		const images = [
			new File(["first"], "same.png", { type: "image/png" }),
			new File(["second"], "same.png", { type: "image/png" }),
		];
		const textFiles = [new File(["log"], "a.log", { type: "text/plain" })];
		const assets = [images[1], textFiles[0], images[0]].map((file) => ({
			id: getComposerAssetId(file),
			kind: file.type === "image/png" ? ("image" as const) : ("textFile" as const),
			name: file.name,
			size: file.size,
			mimeType: file.type,
		}));
		const doc: ComposerDocument = {
			version: 1,
			assets,
			paragraphs: [
				{
					children: [
						{ type: "text", text: "  before " },
						{ type: "attachment", id: "image-node", assetId: assets[0].id },
						{ type: "quote", id: "quote", label: "quote", text: "quoted text" },
						{ type: "attachment", id: "text-node", assetId: assets[1].id },
						{ type: "fileReference", id: "file-node", reference },
						{ type: "attachment", id: "other-image", assetId: assets[2].id },
						{ type: "text", text: " after  " },
					],
				},
			],
		};
		const projection = composerDocumentText(doc);
		Object.assign(options.composerRef.current ?? {}, {
			getDocument: () => doc,
			getText: () => projection.text,
			getFileReferences: () => projection.fileReferences,
		});
		return { doc, projection, images, textFiles };
	}
	test.each([
		"busy",
		"idle",
		"compacting",
	] as const)("%s sends the exact projection and manifest-ordered resources", async (state) => {
		const { doc, projection, images, textFiles } = richDraft();
		await render({
			isActive: state === "busy",
			showCompactQueueChoice: state === "compacting",
			attachedImages: images,
			attachedTextFiles: textFiles,
		});
		await act(async () => actions.handleSend());
		expect(send.mock.calls[0]?.[1]).toBe(projection.text);
		expect(send.mock.calls[0]?.[2]).toEqual([images[1], images[0]]);
		expect(send.mock.calls[0]?.[3]).toEqual(textFiles);
		expect(send.mock.calls[0]?.[7]).toEqual(projection.fileReferences);
		expect(send.mock.calls[0]?.[10]).toEqual({ composerDocument: doc });
		expect(options.composerRef.current?.noteSent).toHaveBeenCalledWith(
			projection.text,
			projection.fileReferences,
			doc,
		);
	});
	test.each([
		"busy",
		"idle",
		"compacting",
	] as const)("%s preserves the identical mixed document after cancellation", async (state) => {
		const { doc, projection, images, textFiles } = richDraft();
		send.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
		await render({
			isActive: state === "busy",
			showCompactQueueChoice: state === "compacting",
			attachedImages: images,
			attachedTextFiles: textFiles,
		});
		await act(async () => actions.handleSend());
		expect(options.composerRef.current?.getDocument?.()).toBe(doc);
		expect(options.composerRef.current?.getText()).toBe(projection.text);
		expect(options.composerRef.current?.getFileReferences()).toEqual(projection.fileReferences);
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.attachedImages).toEqual(images);
		expect(options.attachedTextFiles).toEqual(textFiles);
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(options.sendingRef.current).toBe(false);
	});
	test("advisory MIME changes do not falsely report missing resources", async () => {
		const { doc, images, textFiles } = richDraft();
		doc.assets[0].mimeType = "image/x-png";
		doc.assets[1].mimeType = "application/octet-stream";
		await render({ attachedImages: images, attachedTextFiles: textFiles });
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[2]).toEqual([images[1], images[0]]);
		expect(send.mock.calls[0]?.[3]).toEqual(textFiles);
	});
	test("snapshot still requires the matching resource identity, name, size and kind", () => {
		const { doc, images, textFiles } = richDraft();
		for (const change of [
			{ id: "missing" },
			{ name: "other.png" },
			{ size: 99 },
			{ kind: "textFile" as const },
		]) {
			const changed = { ...doc, assets: [{ ...doc.assets[0], ...change }, ...doc.assets.slice(1)] };
			expect(snapshotComposerFiles(changed, images, textFiles)).toBeUndefined();
		}
	});
	test("missing resources block sends without clearing the document", async () => {
		richDraft();
		await render();
		await act(async () => actions.handleSend());
		expect(send).not.toHaveBeenCalled();
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ message: "composerMissingAssets" }),
		);
	});
	test("editor missing-resource gate is also honored", async () => {
		Object.assign(options.composerRef.current ?? {}, { hasMissingAssets: () => true });
		await render();
		await act(async () => actions.handleSend());
		expect(send).not.toHaveBeenCalled();
	});
	test("forwarding preserves layout and never uploads the operator's staged files", async () => {
		const { doc, projection, images, textFiles } = richDraft();
		await render({
			attachedImages: images,
			attachedTextFiles: textFiles,
		});
		await act(async () => {
			actions.forwardTextToNarrator("forwarded");
			await Promise.resolve();
		});
		expect(send.mock.calls[0]?.[1]).toBe("forwarded");
		expect(send.mock.calls[0]?.[2]).toBeUndefined();
		expect(send.mock.calls[0]?.[3]).toBeUndefined();
		expect(send.mock.calls[0]?.[10]).toBeUndefined();
		expect(options.composerRef.current?.getText()).toBe(projection.text);
		expect(options.composerRef.current?.getDocument?.()).toBe(doc);
		expect(options.composerRef.current?.getFileReferences()).toEqual(projection.fileReferences);
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
	});
	test("pure-text /new projects a new document without retaining the command", async () => {
		const doc: ComposerDocument = {
			version: 1,
			assets: [],
			paragraphs: [{ children: [{ type: "text", text: "/new describe this  " }] }],
		};
		Object.assign(options.composerRef.current ?? {}, {
			getDocument: () => doc,
			getText: () => composerDocumentText(doc).text,
			getFileReferences: () => [],
		});
		await render({ isActive: false });
		await act(async () => actions.handleSend());
		expect(send.mock.calls[0]?.[0]).toBe("created");
		expect(send.mock.calls[0]?.[1]).toBe("describe this");
		const sentDocument = send.mock.calls[0]?.[10]?.composerDocument;
		if (!sentDocument) throw new Error("Missing new-session document");
		expect(composerDocumentText(sentDocument).text).toBe("describe this");
	});
	test.each([
		"direct",
		"forward",
	] as const)("%s waits until async attachment ingestion finishes", async (path) => {
		const ingestingRef = { current: true };
		await render({ ingestingRef });
		await act(async () => {
			if (path === "direct") await actions.handleSend();
			else actions.forwardTextToNarrator("forwarded");
		});
		expect(send).not.toHaveBeenCalled();
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ message: "composerAttachmentsProcessing" }),
		);
		ingestingRef.current = false;
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
	});
	for (const restoreFailed of [false, true]) {
		test.each([
			"direct",
			"send ref",
			"turn",
			"tool",
			"interrupt",
			"composer turn",
			"composer tool",
			"composer interrupt",
			"forward",
			"registered forward",
		] as const)(`%s preserves input and resources while attachment restoration ${restoreFailed ? "has failed" : "is pending"}`, async (path) => {
			const { doc, images, textFiles } = richDraft();
			const ingestingRef = { current: true };
			let registeredForward: ((text: string) => void) | undefined;
			await render({
				attachmentsHydrating: !restoreFailed,
				attachmentsRestoreFailed: restoreFailed,
				ingestingRef,
				attachedImages: images,
				attachedTextFiles: textFiles,
				registerSubmitToNarrator: (submit) => {
					registeredForward = submit;
					return undefined;
				},
			});
			const submit = async () => {
				switch (path) {
					case "direct":
						await actions.handleSend();
						break;
					case "send ref":
						await actions.handleSendRef.current();
						break;
					case "turn":
					case "tool":
					case "interrupt":
						await actions.handleSendWithModeRef.current(path);
						break;
					case "composer turn":
						actions.composerSendWithMode("turn");
						break;
					case "composer tool":
						actions.composerSendWithMode("tool");
						break;
					case "composer interrupt":
						actions.composerSendWithMode("interrupt");
						break;
					case "forward":
						actions.forwardTextToNarrator("forwarded");
						break;
					case "registered forward":
						expect(registeredForward).toBeDefined();
						registeredForward?.("forwarded");
						break;
				}
				await Promise.resolve();
			};
			await act(submit);
			expect(send).not.toHaveBeenCalled();
			expect(options.createNarrator.mutateAsync).not.toHaveBeenCalled();
			expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
			expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
			expect(options.composerRef.current?.clearTextAndDraft).not.toHaveBeenCalled();
			expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
			expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
			expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
			expect(options.composerRef.current?.getDocument()).toEqual(doc);
			expect(options.sendingRef.current).toBe(false);
			expect(actions.sendingState).toBeNull();
			expect(queue.map((message) => message.id)).toEqual(["existing"]);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenLastCalledWith(
				expect.objectContaining({
					...(!restoreFailed ? { color: "yellow" } : {}),
					message: restoreFailed ? "composerAttachmentsRestoreFailed" : "composerRestoringAssets",
				}),
			);
			ingestingRef.current = false;
			await render({ attachmentsHydrating: false, attachmentsRestoreFailed: false });
			await act(submit);
			expect(send).toHaveBeenCalledTimes(1);
			if (path === "forward" || path === "registered forward") {
				expect(send.mock.calls[0]?.[1]).toBe("forwarded");
				expect(send.mock.calls[0]?.[2]).toBeUndefined();
				expect(send.mock.calls[0]?.[3]).toBeUndefined();
			} else {
				expect(send.mock.calls[0]?.[2]).toEqual([images[1], images[0]]);
				expect(send.mock.calls[0]?.[3]).toEqual(textFiles);
				expect(send.mock.calls[0]?.[10]).toEqual({ composerDocument: doc });
			}
		});
	}
	test("old handles without getDocument remain supported", async () => {
		Reflect.deleteProperty(options.composerRef.current ?? {}, "getDocument");
		Reflect.deleteProperty(options.composerRef.current ?? {}, "hasMissingAssets");
		await render();
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
	});
});

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
			"interrupt",
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
			mode,
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
	])("idle subagent preserves urgent guidance intent (takenOver=%s)", async (isTakenOver) => {
		await render({ isActive: false, isSubagent: true, isTakenOver });
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[4]).toBe(true);
		expect(send.mock.calls[0]?.[8]).toBe(true);
		expect(send.mock.calls[0]?.[9]).toBe("interrupt");
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

	test("failed acceptance preserves the draft and attachments without retrying or stopping", async () => {
		const file = new File(["note"], "note.txt");
		send.mockRejectedValue(new Error("upload failed"));
		await render({ attachedTextFiles: [file] });
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(options.composerRef.current?.getText()).toBe("replace");
		expect(options.composerRef.current?.getFileReferences()).toEqual([reference]);
		expect(options.attachedTextFiles).toEqual([file]);
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
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
	])("subagent uses one durable urgent guidance request (takenOver=%s)", async (isTakenOver) => {
		await render({ isSubagent: true, isTakenOver });
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[4]).toBe(true);
		expect(send.mock.calls[0]?.[8]).toBe(true);
		expect(send.mock.calls[0]?.[9]).toBe("interrupt");
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
	});
});

describe("narrator retry without file rollback", () => {
	test.each([200, 503])("retry only calls the retry API (HTTP %s)", async (status) => {
		const retryFetch = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify(status === 200 ? { ok: true } : { error: "fixture retry failed" }),
				{ status, headers: { "content-type": "application/json" } },
			),
		);
		try {
			await render({ isActive: false, canRetryLastUserMessage: true });
			await act(async () => actions.handleRetry());
			// Observe the real API helper's entire HTTP surface, so any file preview,
			// plan-file lookup, apply or legacy rollback would be an extra request.
			expect(retryFetch).toHaveBeenCalledTimes(1);
			expect(retryFetch.mock.calls[0]).toEqual([
				"/api/narrators/n/retry",
				expect.objectContaining({ method: "POST" }),
			]);
			expect(send).not.toHaveBeenCalled();
			expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
			if (status === 200) expect(notify).not.toHaveBeenCalled();
			else
				expect(notify).toHaveBeenCalledWith({
					title: "Error",
					message: "fixture retry failed",
					color: "red",
				});
		} finally {
			retryFetch.mockRestore();
		}
	});
});

describe("modeltrace immediate control", () => {
	let start: ReturnType<typeof spyOn<typeof api, "startModelTrace">>;
	beforeEach(() => {
		start = spyOn(api, "startModelTrace").mockResolvedValue({ id: "trace-child" });
		const composer = options.composerRef.current as NarratorComposerHandle;
		composer.getText = () => " /modeltrace ";
		composer.getFileReferences = () => [];
	});
	afterEach(() => start.mockRestore());

	for (const state of ["working", "compacting", "idle"]) {
		for (const mode of ["turn", "tool", "interrupt"] as const) {
			test(`${state} ${mode} starts one child without sending or interrupting the parent`, async () => {
				const onStarted = mock(() => {});
				await render({
					isActive: state === "working",
					showCompactQueueChoice: state === "compacting",
					onModelTraceStarted: onStarted,
					attachedImages: [new File(["image"], "image.png")],
					attachedTextFiles: [new File(["notes"], "notes.txt")],
				});
				await act(async () => actions.handleSendWithModeRef.current(mode));
				expect(start.mock.calls).toEqual([["n"]]);
				expect(onStarted).toHaveBeenCalledWith("trace-child");
				expect(options.navigateToNarrator).not.toHaveBeenCalled();
				expect(send).not.toHaveBeenCalled();
				expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
				expect(options.setNarratorWorking).not.toHaveBeenCalled();
				expect(queue.map((message) => message.id)).toEqual(["existing"]);
				expect(options.attachedImages).toHaveLength(1);
				expect(options.attachedTextFiles).toHaveLength(1);
				expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
				expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
				expect(options.composerRef.current?.clearTextAndDraft).not.toHaveBeenCalled();
				expect(options.composerRef.current?.restoreInput).toHaveBeenCalledWith("", []);
				expect(options.composerRef.current?.noteSent).not.toHaveBeenCalled();
				expect(options.sendingRef.current).toBe(false);
			});
		}
	}

	test.each([
		"composer",
		"forward",
	] as const)("%s ignores a late modeltrace result after switching narrator", async (source) => {
		let finish!: (value: { id: string }) => void;
		start.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const onStarted = mock(() => {});
		await render({ onModelTraceStarted: onStarted });
		let pending: Promise<void> | undefined;
		await act(async () => {
			if (source === "composer") pending = actions.handleSend();
			else actions.forwardTextToNarrator("/modeltrace");
		});
		expect(start).toHaveBeenCalledTimes(1);
		await render({ narratorId: "other" });
		await act(async () => {
			finish({ id: "late-child" });
			await pending;
		});
		expect(onStarted).not.toHaveBeenCalled();
		expect(options.navigateToNarrator).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.composerRef.current?.clearTextAndDraft).not.toHaveBeenCalled();
		expect(options.sendingRef.current).toBe(false);
	});

	test("rich composer keeps attachment nodes and resources when removing only the command", async () => {
		const image = new File(["image"], "image.png", { type: "image/png" });
		const assetId = getComposerAssetId(image);
		const attachment = { type: "attachment" as const, id: "node", assetId };
		const doc: ComposerDocument = {
			version: 1,
			assets: [
				{ id: assetId, kind: "image", name: image.name, size: image.size, mimeType: image.type },
			],
			paragraphs: [{ children: [{ type: "text", text: "/MODELTRACE " }, attachment] }],
		};
		Object.assign(options.composerRef.current ?? {}, {
			getDocument: () => doc,
			getText: () => composerDocumentText(doc).text,
		});
		await render({ attachedImages: [image] });
		await act(async () => actions.handleSend());
		expect(start).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).toHaveBeenCalledWith("", [], {
			...doc,
			paragraphs: [{ children: [attachment] }],
		});
		expect(options.composerRef.current?.clearTextAndDraft).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
	});

	test("without callback navigates to the child", async () => {
		await render();
		await act(async () => actions.handleSend());
		expect(options.navigateToNarrator).toHaveBeenCalledWith("trace-child");
	});

	test("arguments are rejected without any parent send or trace request", async () => {
		await render();
		(options.composerRef.current as NarratorComposerHandle).getText = () => "/modeltrace extra";
		await act(async () => actions.handleSend());
		expect(start).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "modelTraceUsage" }));
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
	});

	test("file references are rejected and preserved", async () => {
		(options.composerRef.current as NarratorComposerHandle).getFileReferences = () => [reference];
		await render();
		await act(async () => actions.handleSend());
		expect(start).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
	});

	test("failure preserves the draft and does not retry", async () => {
		start.mockRejectedValue(new Error("trace failed"));
		await render();
		await act(async () => actions.handleSend());
		expect(start).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
		expect(options.navigateToNarrator).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.sendingRef.current).toBe(false);
	});

	test("pending request suppresses duplicate sends and preserves a newer draft", async () => {
		const pending = Promise.withResolvers<{ id: string }>();
		start.mockReturnValue(pending.promise);
		await render();
		let first: Promise<void>;
		await act(async () => {
			first = actions.handleSend();
			await actions.handleSend();
		});
		expect(start).toHaveBeenCalledTimes(1);
		(options.composerRef.current as NarratorComposerHandle).getText = () => "new draft";
		await act(async () => {
			pending.resolve({ id: "trace-child" });
			await first;
		});
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
	});

	test.each([
		"/modeltrace",
		"/modeltrace extra",
	])("forwarded %s never reaches the parent or alters its draft", async (text) => {
		const onStarted = mock(() => {});
		await render({ onModelTraceStarted: onStarted });
		await act(async () => actions.forwardTextToNarrator(text));
		expect(start).toHaveBeenCalledTimes(text === "/modeltrace" ? 1 : 0);
		expect(onStarted).toHaveBeenCalledTimes(text === "/modeltrace" ? 1 : 0);
		expect(send).not.toHaveBeenCalled();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
	});
});

describe("save_dump command discovery", () => {
	test.each([
		"en",
		"zh-CN",
	])("offers one localized immediate command while preserving public command and skill entries in %s", async (language) => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(["narrator-commands", "n"], {
			commands: [
				{ name: "save_dump", prompt: "old implementation", source: "builtin" },
				{ name: "modeltrace", prompt: "old implementation", source: "builtin" },
				{
					name: "existing",
					prompt: "existing prompt",
					source: "project",
					runBashFirst: true,
					bashCommand: "git status --short",
				},
			],
			skills: [
				{ name: "visible", source: "project", description: "Visible skill" },
				{ name: "blocked", source: "project", description: "Blocked skill", blocked: true },
			],
		});
		const i18n = createInstance();
		await i18n.init({ lng: language, resources: {} });
		let commands: CommandItem[] = [];
		function CommandProbe() {
			commands = useNarratorCommands("n").data ?? [];
			return null;
		}
		try {
			await act(async () => {
				root.render(
					<I18nextProvider i18n={i18n}>
						<QueryClientProvider client={client}>
							<CommandProbe />
						</QueryClientProvider>
					</I18nextProvider>,
				);
			});
			const traces = commands.filter((command) => command.name === "modeltrace");
			expect(traces).toHaveLength(1);
			expect(traces[0]).toMatchObject({
				name: "modeltrace",
				source: "builtin",
				prompt: "",
				type: "command",
			});
			expect(traces[0].description).toBe(
				language === "en"
					? "Trace the model's current task in a one-turn child session without interrupting it"
					: "在单轮子会话中追踪模型当前任务，不中断原会话",
			);
			const saves = commands.filter((command) => command.name === "save_dump");
			expect(saves).toHaveLength(1);
			expect(saves[0]).toMatchObject({
				name: "save_dump",
				source: "builtin",
				prompt: "",
				type: "command",
			});
			expect(saves[0].description).toBe(
				language === "en"
					? "Save recent request and response recordings immediately without interrupting the session"
					: "立即保存近期请求与响应录制，不中断会话",
			);
			expect(commands.find((command) => command.name === "existing")).toMatchObject({
				prompt: "existing prompt",
				source: "project",
				runBashFirst: true,
				bashCommand: "git status --short",
			});
			expect(commands.find((command) => command.name === "visible")).toMatchObject({
				type: "skill",
			});
			expect(commands.some((command) => command.name === "blocked")).toBeFalse();
			for (const name of ["new", "fork", "compact", "load skill blocked", "unload skill visible"])
				expect(commands.some((command) => command.name === name)).toBeTrue();
		} finally {
			await act(async () => root.render(null));
			client.clear();
		}
	});
});

describe("save_dump immediate control", () => {
	const recording: SavedRecording = {
		id: "save-1",
		narratorId: "n",
		createdAt: "2026-10-07T00:00:00Z",
		requestIds: ["req-1"],
		apiRequestIds: ["upstream-1"],
		requestCount: 1,
		bytes: 1234,
		partial: true,
		truncated: false,
	};
	let save: ReturnType<typeof spyOn<typeof api, "saveRequestRecording">>;
	beforeEach(() => {
		save = spyOn(api, "saveRequestRecording").mockResolvedValue(recording);
	});
	afterEach(() => save.mockRestore());
	const modes: Array<"turn" | "tool" | "interrupt"> = ["turn", "tool", "interrupt"];
	const commands = ["/save_dump", "/SAVE_DUMP", "/SaVe_DuMp"];
	const commandModes = commands.flatMap((command) => modes.map((mode) => ({ command, mode })));
	const activeCommandModes = (["working", "compacting"] as const).flatMap((state) =>
		commandModes.map((entry) => ({ ...entry, state })),
	);
	for (const state of ["working", "compacting", "idle"] as const) {
		test.each(
			commandModes,
		)(`${state} $command $mode saves directly and preserves staged attachments`, async ({
			command,
			mode,
		}) => {
			const image = new File(["image"], "image.png", { type: "image/png" });
			const textFile = new File(["note"], "note.txt");
			const onSaved = mock(() => {});
			await render({
				isActive: state === "working",
				showCompactQueueChoice: state === "compacting",
				attachedImages: [image],
				attachedTextFiles: [textFile],
				onRequestRecordingSaved: onSaved,
			});
			const composer = options.composerRef.current as NarratorComposerHandle;
			composer.getText = () => ` ${command} `;
			composer.getFileReferences = () => [];
			await act(async () => {
				await actions.handleSendWithModeRef.current(mode);
			});
			expect(save).toHaveBeenCalledTimes(1);
			expect(save.mock.calls[0]).toEqual(["n", expect.any(AbortSignal)]);
			expect(send).not.toHaveBeenCalled();
			expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
			expect(options.setNarratorWorking).not.toHaveBeenCalled();
			expect(options.reconcileBufferedMessages).not.toHaveBeenCalled();
			expect(queue.map((message) => message.id)).toEqual(["existing"]);
			expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
			expect(composer.clearTextAndDraft).toHaveBeenCalledTimes(1);
			expect(composer.noteSent).not.toHaveBeenCalled();
			expect(onSaved).toHaveBeenCalledWith(recording);
			expect(options.sendingRef.current).toBe(false);
		});
	}
	test.each(modes)("failure in %s mode leaves draft and attachments untouched", async (mode) => {
		save.mockRejectedValue(new Error("recording unavailable"));
		const textFile = new File(["note"], "note.txt");
		await render({ attachedTextFiles: [textFile], showCompactQueueChoice: true });
		const composer = options.composerRef.current as NarratorComposerHandle;
		composer.getText = () => "/save_dump";
		composer.getFileReferences = () => [];
		await act(async () => {
			await actions.handleSendWithModeRef.current(mode);
		});
		expect(composer.clearTextAndDraft).not.toHaveBeenCalled();
		expect(composer.hideTextForSend).not.toHaveBeenCalled();
		expect(composer.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(composer.restoreInput).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(["existing"]);
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ message: "recording unavailable", color: "red" }),
		);
		expect(options.sendingRef.current).toBe(false);
	});
	test.each(
		commands,
	)("pending %s suppresses duplicates and leaves newer input untouched", async (command) => {
		const pending = Promise.withResolvers<SavedRecording>();
		save.mockReturnValue(pending.promise);
		await render();
		let text = command;
		const composer = options.composerRef.current as NarratorComposerHandle;
		composer.getText = () => text;
		composer.getFileReferences = () => [];
		let saving: Promise<void> | void;
		await act(async () => {
			saving = actions.handleSendWithModeRef.current("turn");
			await actions.handleSendWithModeRef.current("interrupt");
		});
		expect(save).toHaveBeenCalledTimes(1);
		expect(actions.sendingState).toEqual({ attachmentCount: 0, progress: null, canCancel: false });
		expect(composer.clearTextAndDraft).not.toHaveBeenCalled();
		text = "newer draft";
		await act(async () => {
			pending.resolve(recording);
			await saving;
		});
		expect(composer.clearTextAndDraft).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
	test.each(
		activeCommandModes,
	)("$state $command $mode preserves inline references and staged files", async ({
		command,
		mode,
		state,
	}) => {
		const image = new File(["image"], "image.png", { type: "image/png" });
		const textFile = new File(["note"], "note.txt");
		await render({
			isActive: state === "working",
			showCompactQueueChoice: state === "compacting",
			attachedImages: [image],
			attachedTextFiles: [textFile],
		});
		const composer = options.composerRef.current as NarratorComposerHandle;
		composer.getText = () => `${command} #file:a.ts`;
		composer.getFileReferences = () => [{ ...reference, inputRange: [11, 21] }];
		await act(async () => actions.handleSendWithModeRef.current(mode));
		expect(save).toHaveBeenCalledTimes(1);
		expect(composer.restoreInput).toHaveBeenCalledWith("#file:a.ts", [
			{ ...reference, inputRange: [0, 10] },
		]);
		expect(composer.clearTextAndDraft).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(["existing"]);
	});
	test.each(
		commands,
	)("forwarded %s bypasses queue and never edits the current draft", async (command) => {
		const onSaved = mock(() => {});
		await render({ onRequestRecordingSaved: onSaved });
		await act(async () => actions.forwardTextToNarrator(command));
		expect(save).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(onSaved).toHaveBeenCalledWith(recording);
	});
	for (const state of ["working", "compacting"] as const) {
		test.each(
			commandModes,
		)(`${state} $command $mode rejects arguments without losing attachments`, async ({
			command,
			mode,
		}) => {
			await render({
				isActive: state === "working",
				showCompactQueueChoice: state === "compacting",
				attachedImages: [new File(["image"], "image.png")],
				attachedTextFiles: [new File(["note"], "note.txt")],
			});
			const composer = options.composerRef.current as NarratorComposerHandle;
			composer.getText = () => `${command} extra #file:a.ts`;
			composer.getFileReferences = () => [{ ...reference, inputRange: [17, 27] }];
			await act(async () => actions.handleSendWithModeRef.current(mode));
			expect(save).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
			expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
			expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
			expect(composer.clearTextAndDraft).not.toHaveBeenCalled();
			expect(composer.restoreInput).not.toHaveBeenCalled();
			expect(queue.map((message) => message.id)).toEqual(["existing"]);
			expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "saveDump.usage" }));
		});
	}
	test.each(
		commands,
	)("forwarded %s rejects arguments without touching the composer", async (command) => {
		await render();
		await act(async () => actions.forwardTextToNarrator(`${command} extra`));
		expect(save).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(queue.map((message) => message.id)).toEqual(["existing"]);
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "saveDump.usage" }));
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

describe("new narrator attachments", () => {
	function attachments(kind: "image" | "text file" | "mixed") {
		const attachedImages =
			kind === "text file" ? [] : [new File(["image"], "screenshot.png", { type: "image/png" })];
		const attachedTextFiles = kind === "image" ? [] : [new File(["note"], "note.txt")];
		return {
			attachedImages,
			attachedTextFiles,
		};
	}

	async function renderCommand(command: string, overrides: Partial<UseNarratorSendOptions> = {}) {
		const composer = options.composerRef.current as NarratorComposerHandle;
		composer.getText = () => command;
		composer.getFileReferences = () => [];
		await render({ isActive: false, ...overrides });
	}

	test.each([
		"image",
		"text file",
	] as const)("should send %s-only content as the first message when idle /new has no text", async (kind) => {
		const files = attachments(kind);
		await renderCommand("/new", files);
		await act(async () => actions.handleSend());
		expect(options.createNarrator.mutateAsync).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]).toEqual([
			"created",
			"",
			files.attachedImages.length ? files.attachedImages : undefined,
			files.attachedTextFiles.length ? files.attachedTextFiles : undefined,
			undefined,
			expect.any(Function),
			expect.any(AbortSignal),
		]);
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
		expect(options.clearAttachedFilesAndDraft).toHaveBeenCalledTimes(1);
		expect(options.navigateToNarrator).toHaveBeenCalledWith("created");
		expect(notify).not.toHaveBeenCalled();
		expect(options.sendingRef.current).toBe(false);
	});

	test("should wait for attachment acceptance before clearing input or navigating", async () => {
		const pending = Promise.withResolvers<{ id: string }>();
		send.mockReturnValue(pending.promise);
		const files = attachments("mixed");
		await renderCommand("/new   ", files);
		let sending: Promise<void> | undefined;
		try {
			await act(async () => {
				sending = actions.handleSend();
				await Promise.resolve();
			});
			expect(send).toHaveBeenCalledTimes(1);
			expect(send.mock.calls[0]?.slice(0, 4)).toEqual([
				"created",
				"",
				files.attachedImages,
				files.attachedTextFiles,
			]);
			expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
			expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
			expect(options.navigateToNarrator).not.toHaveBeenCalled();
			expect(options.sendingRef.current).toBe(true);
			await act(async () => actions.handleSend());
			expect(options.createNarrator.mutateAsync).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => {
				pending.resolve({ id: "first-message" });
				await sending;
			});
		}
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
		expect(options.clearAttachedFilesAndDraft).toHaveBeenCalledTimes(1);
		expect(options.navigateToNarrator).toHaveBeenCalledWith("created");
		expect(options.sendingRef.current).toBe(false);
	});

	test.each([
		"image",
		"text file",
	] as const)("should keep %s attachments with the trimmed initial text when idle /new has text", async (kind) => {
		const files = attachments(kind);
		await renderCommand("/new  describe these files  ", files);
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.slice(0, 4)).toEqual([
			"created",
			"describe these files",
			files.attachedImages.length ? files.attachedImages : undefined,
			files.attachedTextFiles.length ? files.attachedTextFiles : undefined,
		]);
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
		expect(options.clearAttachedFilesAndDraft).toHaveBeenCalledTimes(1);
		expect(options.navigateToNarrator).toHaveBeenCalledWith("created");
	});

	test("should only create a narrator when idle /new has neither text nor attachments", async () => {
		await renderCommand("/new");
		await act(async () => actions.handleSend());
		expect(options.createNarrator.mutateAsync).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
		expect(options.clearAttachedFilesAndDraft).toHaveBeenCalledTimes(1);
		expect(options.navigateToNarrator).toHaveBeenCalledWith("created");
	});

	test.each([
		"create",
		"send",
	] as const)("should preserve the command and both attachment types when %s fails", async (failure) => {
		const files = attachments("mixed");
		const create = mock(async () => {
			if (failure === "create") throw new Error("fixture create failed");
			return { id: "created" };
		});
		if (failure === "send") send.mockRejectedValue(new Error("fixture send failed"));
		await renderCommand("/new", { ...files, createNarrator: { mutateAsync: create } });
		await act(async () => actions.handleSend());
		expect(create).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(failure === "send" ? 1 : 0);
		expect(options.composerRef.current?.getText()).toBe("/new");
		expect(options.attachedImages).toEqual(files.attachedImages);
		expect(options.attachedTextFiles).toEqual(files.attachedTextFiles);
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(options.navigateToNarrator).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "sendFailed",
				message: `fixture ${failure} failed`,
				color: "red",
			}),
		);
		expect(options.sendingRef.current).toBe(false);
	});

	test.each([
		"turn",
		"tool",
		"interrupt",
	] as const)("should queue /new with its attachments without spawning when active in %s mode", async (mode) => {
		const files = attachments("mixed");
		await renderCommand("/new", { ...files, isActive: true });
		await act(async () => actions.handleSendWithModeRef.current(mode));
		expect(options.createNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(options.interruptNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.slice(0, 5)).toEqual([
			"n",
			"/new",
			files.attachedImages,
			files.attachedTextFiles,
			undefined,
		]);
		expect(send.mock.calls[0]?.[8]).toBeUndefined();
		expect(send.mock.calls[0]?.[9]).toBe("turn");
		expect(options.clearAttachedFilesAndDraft).toHaveBeenCalledTimes(1);
	});

	test.each([
		false,
		true,
	])("should reject /new file references while retaining the input (active=%s)", async (isActive) => {
		await renderCommand("/new", { ...attachments("mixed"), isActive });
		const composer = options.composerRef.current as NarratorComposerHandle;
		composer.getFileReferences = () => [reference];
		await act(async () => actions.handleSend());
		expect(options.createNarrator.mutateAsync).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(composer.hideTextForSend).not.toHaveBeenCalled();
		expect(composer.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(options.navigateToNarrator).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ message: "fileReferences.newSessionFirst", color: "red" }),
		);
		expect(options.sendingRef.current).toBe(false);
	});
});

describe("send ownership across narrator switches", () => {
	function deferred<T>() {
		let resolve!: (value: T) => void;
		let reject!: (reason: unknown) => void;
		const promise = new Promise<T>((ok, fail) => {
			resolve = ok;
			reject = fail;
		});
		return { promise, resolve, reject };
	}

	test.each([
		"busy",
		"idle",
		"compacting",
	] as const)("%s cancels on switching, retains files, and ignores late failure while B sends", async (state) => {
		const first = deferred<{ buffered: boolean; id: string }>();
		const second = deferred<{ buffered: boolean; id: string }>();
		send.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
		const image = new File(["image"], "same.png", { type: "image/png" });
		const log = new File(["log"], "same.png", { type: "text/plain" });
		const owner = `switch-${state}`;
		await render({
			currentUser: { id: owner },
			isActive: state === "busy",
			showCompactQueueChoice: state === "compacting",
			attachedImages: [image],
			attachedTextFiles: [log],
		});
		let firstSend!: Promise<void>;
		await act(async () => {
			firstSend = actions.handleSend();
		});
		const firstSignal = send.mock.calls[0]?.[6];
		const firstProgress = send.mock.calls[0]?.[5];
		expect(firstSignal?.aborted).toBe(false);
		const composer = options.composerRef.current;
		if (!composer) throw new Error("composer was not mounted");
		const nextComposer = {
			...composer,
			restoreInput: mock(() => {}),
			commitDraftAfterSend: mock(() => {}),
		};
		// Real panels can reuse the ref object while swapping the composer handle.
		options.composerRef.current = nextComposer;
		await render({ narratorId: "other", attachedImages: [], attachedTextFiles: [] });
		expect(firstSignal?.aborted).toBe(true);
		expect(actions.isSending).toBe(false);
		expect(options.sendingRef.current).toBe(false);
		const recovered = await loadDraftImageAttachments(owner, "n");
		expect(recovered.images[0]).toBe(image);
		expect(recovered.textFiles[0]).toBe(log);
		let secondSend!: Promise<void>;
		await act(async () => {
			secondSend = actions.handleSend();
		});
		const secondSignal = send.mock.calls[1]?.[6];
		await act(async () => {
			firstProgress?.(0.9);
			first.reject(new DOMException("Cancelled", "AbortError"));
			await firstSend;
		});
		expect(actions.isSending).toBe(true);
		expect(actions.sendingState?.progress).toBe(0);
		expect(options.sendingRef.current).toBe(true);
		expect(secondSignal?.aborted).toBe(false);
		expect(nextComposer.restoreInput).not.toHaveBeenCalled();
		expect(nextComposer.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		await act(async () => {
			second.resolve({ buffered: true, id: "second" });
			await secondSend;
		});
		expect(actions.isSending).toBe(false);
	});

	test.each([
		"switch-back",
		"remount",
		"account",
	] as const)("%s does not revive the previous request when it succeeds late", async (change) => {
		const request = deferred<{ buffered: boolean; id: string }>();
		send.mockImplementationOnce(() => request.promise);
		await render({ currentUser: { id: "owner" } });
		let pending!: Promise<void>;
		await act(async () => {
			pending = actions.handleSend();
		});
		const signal = send.mock.calls[0]?.[6];
		if (change === "switch-back") {
			await render({ narratorId: "other" });
			await render({ narratorId: "n" });
		} else if (change === "remount") {
			await act(async () => root.render(null));
			await render({ sendingRef: { current: false } });
		} else {
			await render({ currentUser: { id: "another-user" } });
		}
		expect(signal?.aborted).toBe(true);
		await act(async () => {
			request.resolve({ buffered: true, id: "stale" });
			await pending;
		});
		expect(queue.map((entry) => entry.id)).toEqual(["existing"]);
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(options.reconcileBufferedMessages).not.toHaveBeenCalled();
		expect(options.setNarratorWorking).not.toHaveBeenCalled();
		expect(actions.sendingState).toBeNull();
		expect(notify).not.toHaveBeenCalled();
	});

	test("unmount aborts the transport and retains Files without waiting for rejection", async () => {
		const request = deferred<{ buffered: boolean; id: string }>();
		send.mockImplementationOnce(() => request.promise);
		const file = new File(["contents"], "log.txt", { type: "text/plain" });
		await render({ currentUser: { id: "unmount-owner" }, attachedTextFiles: [file] });
		let pending!: Promise<void>;
		await act(async () => {
			pending = actions.handleSend();
		});
		const signal = send.mock.calls[0]?.[6];
		await act(async () => root.render(null));
		expect(signal?.aborted).toBe(true);
		expect((await loadDraftImageAttachments("unmount-owner", "n")).textFiles[0]).toBe(file);
		await act(async () => {
			request.reject(new Error("late transport failure"));
			await pending;
		});
		expect(notify).not.toHaveBeenCalled();
	});

	test("a late /new creation cannot start an upload or navigate after switching", async () => {
		const created = deferred<{ id: string }>();
		await render({
			isActive: false,
			createNarrator: { mutateAsync: mock(() => created.promise) },
		});
		Object.assign(options.composerRef.current ?? {}, {
			getText: () => "/new hello",
			getFileReferences: () => [],
		});
		let pending!: Promise<void>;
		await act(async () => {
			pending = actions.handleSend();
		});
		await render({ narratorId: "other" });
		await act(async () => {
			created.resolve({ id: "created" });
			await pending;
		});
		expect(send).not.toHaveBeenCalled();
		expect(options.navigateToNarrator).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
	});
});

describe("mounted composer visibility during uploads", () => {
	test.each([
		"hidden-tab",
		"workspace-preview",
	] as const)("%s cancels even though the send hook stays mounted and preserves the full draft", async (host) => {
		let finish!: (value: { buffered: boolean; id: string }) => void;
		send.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const file = new File(["contents"], "log.txt", { type: "text/plain" });
		await render({ currentUser: { id: host }, attachedTextFiles: [file] });
		const composer = options.composerRef.current;
		let pending!: Promise<void>;
		await act(async () => {
			pending = actions.handleSend();
		});
		const signal = send.mock.calls[0]?.[6];
		expect(composer?.getText()).toBe("replace");
		expect(options.attachedTextFiles).toEqual([file]);
		expect(composer?.hideTextForSend).not.toHaveBeenCalled();
		// Director previews remove only the composer, not the panel/send hook.
		if (host === "workspace-preview") options.composerRef.current = null;
		await render({ composerVisible: false });
		expect(signal?.aborted).toBe(true);
		expect(actions.isSending).toBe(false);
		expect(options.sendingRef.current).toBe(false);
		expect((await loadDraftImageAttachments(host, "n")).textFiles[0]).toBe(file);
		await act(async () => actions.handleSend());
		expect(send).toHaveBeenCalledTimes(1);
		options.composerRef.current = composer;
		await render({ composerVisible: true });
		await act(async () => {
			finish({ buffered: true, id: "stale" });
			await pending;
		});
		expect(composer?.getText()).toBe("replace");
		expect(composer?.hideTextForSend).not.toHaveBeenCalled();
		expect(composer?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(queue.map((entry) => entry.id)).toEqual(["existing"]);
	});

	test.each([
		"busy",
		"idle",
		"compacting",
	] as const)("%s keeps recovery input intact until acceptance, then clears it exactly once", async (state) => {
		let finish!: (value: { buffered: boolean; id: string }) => void;
		send.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const file = new File(["contents"], "log.txt", { type: "text/plain" });
		await render({
			attachedTextFiles: [file],
			isActive: state === "busy",
			showCompactQueueChoice: state === "compacting",
		});
		let pending!: Promise<void>;
		await act(async () => {
			pending = actions.handleSend();
		});
		expect(actions.isSending).toBe(true);
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		await act(async () => {
			finish({ buffered: true, id: "accepted" });
			await pending;
		});
		expect(options.composerRef.current?.hideTextForSend).toHaveBeenCalledTimes(1);
		expect(options.composerRef.current?.commitDraftAfterSend).toHaveBeenCalledTimes(1);
		expect(options.clearAttachedFilesAndDraft).toHaveBeenCalledTimes(1);
		expect(actions.isSending).toBe(false);
	});

	test("a failed upload never restores its old snapshot over a synchronized newer draft", async () => {
		let fail!: (reason: unknown) => void;
		send.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		let text = "original";
		Object.assign(options.composerRef.current ?? {}, { getText: () => text });
		await render();
		let pending!: Promise<void>;
		await act(async () => {
			pending = actions.handleSend();
		});
		text = "newer synchronized draft";
		await act(async () => {
			fail(new Error("upload failed"));
			await pending;
		});
		expect(options.composerRef.current?.getText()).toBe(text);
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
	});
});

describe("forwarding never borrows the composer draft", () => {
	test.each([
		"success",
		"failure",
		"switch",
		"hidden",
		"initially-hidden",
	] as const)("%s leaves the draft untouched both while pending and after settlement", async (outcome) => {
		let finish!: (value: { buffered: boolean; id: string }) => void;
		let fail!: (reason: unknown) => void;
		send.mockImplementationOnce(
			() =>
				new Promise((resolve, reject) => {
					finish = resolve;
					fail = reject;
				}),
		);
		const file = new File(["contents"], "log.txt", { type: "text/plain" });
		await render({
			attachedTextFiles: [file],
			composerVisible: outcome !== "initially-hidden",
		});
		await act(async () => actions.forwardTextToNarrator("forwarded text"));
		expect(send.mock.calls[0]?.[1]).toBe("forwarded text");
		expect(send.mock.calls[0]?.[2]).toBeUndefined();
		expect(send.mock.calls[0]?.[3]).toBeUndefined();
		expect(send.mock.calls[0]?.[7]).toEqual([]);
		expect(actions.isSending).toBe(true);
		expect(options.composerRef.current?.getText()).toBe("replace");
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		// Model a remote edit arriving while the independent forward is pending.
		Object.assign(options.composerRef.current ?? {}, { getText: () => "new remote draft" });
		if (outcome === "switch") await render({ narratorId: "other" });
		if (outcome === "hidden") await render({ composerVisible: false });
		if (outcome === "switch" || outcome === "hidden")
			expect(send.mock.calls[0]?.[6]?.aborted).toBe(true);
		await act(async () => {
			if (outcome === "failure") fail(new Error("forward failed"));
			else finish({ buffered: true, id: "forwarded" });
			await Promise.resolve();
		});
		expect(options.composerRef.current?.getText()).toBe("new remote draft");
		expect(options.composerRef.current?.restoreInput).not.toHaveBeenCalled();
		expect(options.composerRef.current?.hideTextForSend).not.toHaveBeenCalled();
		expect(options.composerRef.current?.commitDraftAfterSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(actions.isSending).toBe(false);
		expect(options.sendingRef.current).toBe(false);
	});
});
