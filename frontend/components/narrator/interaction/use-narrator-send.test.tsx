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
import { getComposerAssetId } from "../composer/draft-image-attachments";
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
	] as const)("%s restores the identical mixed document after cancellation", async (state) => {
		const { doc, projection, images, textFiles } = richDraft();
		send.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
		await render({
			isActive: state === "busy",
			showCompactQueueChoice: state === "compacting",
			attachedImages: images,
			attachedTextFiles: textFiles,
		});
		await act(async () => actions.handleSend());
		expect(options.composerRef.current?.restoreInput).toHaveBeenCalledWith(
			projection.text,
			projection.fileReferences,
			doc,
		);
		expect(options.updateAttachedImages).toHaveBeenCalledWith([images[1], images[0]]);
		expect(options.updateAttachedTextFiles).toHaveBeenCalledWith(textFiles);
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
			attachedImagesRef: { current: images },
			attachedTextFilesRef: { current: textFiles },
		});
		await act(async () => {
			actions.forwardTextToNarrator("forwarded");
			await Promise.resolve();
		});
		expect(send.mock.calls[0]?.[1]).toBe("forwarded");
		expect(send.mock.calls[0]?.[2]).toBeUndefined();
		expect(send.mock.calls[0]?.[3]).toBeUndefined();
		expect(send.mock.calls[0]?.[10]).toBeUndefined();
		expect(options.composerRef.current?.restoreInput).toHaveBeenLastCalledWith(
			projection.text,
			projection.fileReferences,
			doc,
		);
		expect(options.updateAttachedImages).toHaveBeenLastCalledWith(images);
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
				attachedImagesRef: { current: images },
				attachedTextFilesRef: { current: textFiles },
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
			expect(options.hideAttachedFilesForSend).not.toHaveBeenCalled();
			expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
			expect(options.updateAttachedImages).not.toHaveBeenCalled();
			expect(options.updateAttachedTextFiles).not.toHaveBeenCalled();
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

describe("save_dump command discovery", () => {
	test.each([
		"en",
		"zh-CN",
	])("offers one localized immediate command while preserving public command and skill entries in %s", async (language) => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(["narrator-commands", "n"], {
			commands: [
				{ name: "save_dump", prompt: "old implementation", source: "builtin" },
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
				attachedImagesRef: { current: [image] },
				attachedTextFilesRef: { current: [textFile] },
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
			expect(options.hideAttachedFilesForSend).not.toHaveBeenCalled();
			expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
			expect(options.updateAttachedImages).not.toHaveBeenCalled();
			expect(options.updateAttachedTextFiles).not.toHaveBeenCalled();
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
		expect(options.hideAttachedFilesForSend).not.toHaveBeenCalled();
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
		expect(options.hideAttachedFilesForSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(options.updateAttachedImages).not.toHaveBeenCalled();
		expect(options.updateAttachedTextFiles).not.toHaveBeenCalled();
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
		expect(options.updateAttachedImages).not.toHaveBeenCalled();
		expect(options.updateAttachedTextFiles).not.toHaveBeenCalled();
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
			expect(options.hideAttachedFilesForSend).not.toHaveBeenCalled();
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

describe("new narrator attachments", () => {
	function attachments(kind: "image" | "text file" | "mixed") {
		const attachedImages =
			kind === "text file" ? [] : [new File(["image"], "screenshot.png", { type: "image/png" })];
		const attachedTextFiles = kind === "image" ? [] : [new File(["note"], "note.txt")];
		return {
			attachedImages,
			attachedTextFiles,
			attachedImagesRef: { current: attachedImages },
			attachedTextFilesRef: { current: attachedTextFiles },
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
	] as const)("should restore the command and both attachment types when %s fails", async (failure) => {
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
		expect(options.composerRef.current?.restoreInput).toHaveBeenCalledWith("/new", []);
		expect(options.updateAttachedImages).toHaveBeenCalledWith(files.attachedImages);
		expect(options.updateAttachedTextFiles).toHaveBeenCalledWith(files.attachedTextFiles);
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
		expect(options.hideAttachedFilesForSend).not.toHaveBeenCalled();
		expect(options.clearAttachedFilesAndDraft).not.toHaveBeenCalled();
		expect(options.navigateToNarrator).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ message: "fileReferences.newSessionFirst", color: "red" }),
		);
		expect(options.sendingRef.current).toBe(false);
	});
});
