import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout } from "node:timers";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { FileReference } from "@shared/file-reference";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { api } from "../../../lib/api";
import en from "../../../locales/en/narrator.json";
import { ImageViewerContext } from "../../common/image-viewer-context";
import { QueuedAttachmentPreview, QueuedMessageRow } from "../interaction/QueuedMessageRow";
import {
	QueuedMessagesPanel,
	type QueuedMessagesPanelProps,
} from "../interaction/QueuedMessagesPanel";
import type { QueuedEditPayload } from "../interaction/queued-attachment-edit";
import { EditingMessageCtx, type EditingMessageState } from "./EditingMessageCtx";
import { MessageEditorPanel, type MessageEditorPanelProps } from "./MessageEditorPanel";

// Real React/Mantine components, no module mocks and no HTTP or service calls.
const i18n = i18next.createInstance();
let root: Root | undefined;
let host: HTMLElement | undefined;
let qc: QueryClient;
let registered: EditingMessageState | null;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const ownedTimeouts = new Map<number, ReturnType<typeof setNativeTimeout>>();

// Do not use global fake timers: other suites share this Bun process. Track only
// timers scheduled while this fixture owns window, including RAF's timeout shim.
function setOwnedTimeout(callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) {
	const timer = setNativeTimeout(() => {
		ownedTimeouts.delete(Number(timer));
		callback(...args);
	}, delay);
	ownedTimeouts.set(Number(timer), timer);
	return timer;
}
function clearOwnedTimeout(timer: ReturnType<typeof setNativeTimeout> | number | undefined) {
	if (timer !== undefined) ownedTimeouts.delete(Number(timer));
	clearNativeTimeout(timer);
}
function clearOwnedTimers() {
	for (const timer of ownedTimeouts.values()) clearNativeTimeout(timer);
	ownedTimeouts.clear();
}
function requestOwnedAnimationFrame(callback: FrameRequestCallback): number {
	return Number(setOwnedTimeout(() => callback(performance.now())));
}
const reference: FileReference = {
	id: "occurrence-a",
	deviceId: "RemoteCaseID",
	path: "/work/a.ts",
	label: "a.ts",
	selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
};
const secondReference: FileReference = {
	...reference,
	id: "occurrence-b",
	selection: { startLineNumber: 5, startColumn: 1, endLineNumber: 6, endColumn: 1 },
};

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
async function flush() {
	// The harness's own drain must not be counted among component-owned timers.
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setNativeTimeout(resolve, 0));
}
function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "fonts", {
		value: { addEventListener() {}, removeEventListener() {} },
	});
	const matchMedia = (media: string) => ({
		matches: media === "(prefers-reduced-motion: reduce)",
		media,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const overrides = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		Document: window.Document,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		Node: window.Node,
		Text: window.Text,
		ShadowRoot: window.ShadowRoot,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		setTimeout: setOwnedTimeout,
		clearTimeout: clearOwnedTimeout,
		requestAnimationFrame: requestOwnedAnimationFrame,
		cancelAnimationFrame: clearOwnedTimeout,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	// linkedom's window is a proxy over globalThis. Assigning window fields before
	// saving descriptors would make restoration retain this fixture's own shims.
	for (const [key, value] of Object.entries(overrides)) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
}
async function render(child: ReactNode) {
	await act(async () => {
		root?.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={qc}>
					{/* env=test skips Transition rendering, not its hook's timers. */}
					<MantineProvider env="test" theme={{ respectReducedMotion: true }}>
						<EditingMessageCtx.Provider
							value={{
								register: (state) => {
									registered = state;
								},
								unregister: () => {
									registered = null;
								},
							}}
						>
							<ImageViewerContext.Provider value={{ open: () => {} }}>
								{child}
							</ImageViewerContext.Provider>
						</EditingMessageCtx.Provider>
					</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
		await flush();
	});
}
function button(label: string) {
	const found = Array.from(document.querySelectorAll("button")).find(
		(item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
	);
	if (!found) throw new Error(`Button not found: ${label}`);
	return found;
}
async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true }));
		await flush();
	});
}
function editor(overrides: Partial<MessageEditorPanelProps> = {}) {
	return (
		<MessageEditorPanel
			messageRole="user"
			messageId="message"
			blocks={[
				{ type: "file_reference", reference, snapshotText: "must not reach edit payload" },
				{ type: "file_reference", reference: secondReference },
			]}
			initialText=""
			onClose={() => {}}
			{...overrides}
		/>
	);
}

beforeEach(async () => {
	installDom();
	if (!i18n.isInitialized)
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "narrator",
			resources: { en: { narrator: en } },
			react: { useSuspense: false },
		});
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
	});
	// The query is disabled without a narratorId; seed the no-op preview so the
	// submit tests cannot accidentally send a request or open a rollback dialog.
	qc.setQueryData(["narrators", "", "edit-regenerate-preview", "message"], {
		affectedFiles: [],
		deletedMessageCount: 0,
	});
	registered = null;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

async function cleanupDom() {
	try {
		await act(async () => {
			root?.unmount();
			root = undefined;
			qc.clear();
			clearOwnedTimers();
			// Flush passive effects while window still exists, not in the next suite.
			await flush();
		});
	} finally {
		// Catch follow-up timers/frames from unmount effects as well. Never clear
		// another suite's timers or leave a fake window behind to mask a leak.
		clearOwnedTimers();
		host?.remove();
		host = undefined;
		for (const [key, descriptor] of previousGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		previousGlobals.clear();
	}
}
afterEach(cleanupDom);

test("fixture teardown cancels owned window/global timers and RAF before restoring globals", async () => {
	const originalDescriptors = new Map(previousGlobals);
	const callback = mock(() => {});
	const globalTimer = setTimeout(callback, 25);
	const windowTimer = window.setTimeout(callback, 25);
	const frame = requestAnimationFrame(callback);
	for (const handle of [globalTimer, windowTimer, frame]) {
		expect(ownedTimeouts.has(Number(handle))).toBe(true);
	}
	await cleanupDom();
	// Outlive the scheduled callbacks without a fixture window. None may run or
	// dispatch React state while the next suite is importing its components.
	await new Promise<void>((resolve) => setNativeTimeout(resolve, 35));
	expect(callback).not.toHaveBeenCalled();
	expect(ownedTimeouts.size).toBe(0);
	for (const [key, descriptor] of originalDescriptors) {
		expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
	}
});

// linkedom has no native textarea editing/default actions. Deliver beforeinput
// through the DOM listener, then invoke React's installed change handler after
// applying the browser's value/selection mutation (not the pure helper).
function textareaProps() {
	const textarea = document.querySelector("textarea");
	if (!textarea) throw new Error("Textarea missing");
	const key = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
	if (!key) throw new Error("React textarea props missing");
	return {
		textarea,
		props: (textarea as unknown as Record<string, ComponentProps<"textarea">>)[key],
	};
}
async function editRange(
	start: number,
	end: number,
	replacement: string,
	inputType = "insertText",
) {
	await act(async () => {
		const { textarea, props } = textareaProps();
		textarea.selectionStart = start;
		textarea.selectionEnd = end;
		const event = new Event("beforeinput", { bubbles: true });
		Object.defineProperty(event, "inputType", { value: inputType });
		textarea.dispatchEvent(event);
		textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
		textarea.selectionStart = textarea.selectionEnd = start + replacement.length;
		props.onChange?.({ currentTarget: textarea } as Parameters<
			NonNullable<typeof props.onChange>
		>[0]);
		await flush();
	});
}
async function editorKey(key: string, ctrlKey = false, isComposing = false) {
	await act(async () => {
		const { textarea, props } = textareaProps();
		props.onKeyDown?.({
			currentTarget: textarea,
			key,
			ctrlKey,
			nativeEvent: { isComposing },
			preventDefault() {},
		} as Parameters<NonNullable<typeof props.onKeyDown>>[0]);
		await flush();
	});
}
const twinText = "#file:a.ts #file:a.ts ";
const twinReferences: FileReference[] = [
	{ id: "local-ref", deviceId: "local", path: "/work/a.ts", label: "a.ts", inputRange: [0, 10] },
	{ id: "remote-ref", deviceId: "remote", path: "/work/a.ts", label: "a.ts", inputRange: [11, 21] },
];

for (const mode of ["message", "queued"] as const) {
	describe(`${mode} real input-range identity`, () => {
		async function mount() {
			const payloads: FileReference[][] = [];
			const view = () =>
				mode === "message" ? (
					editor({
						initialText: twinText,
						blocks: twinReferences.map((reference) => ({ type: "file_reference", reference })),
						onEditAndRegenerate: async (_id, _text, _revert, opts) => {
							payloads.push(opts?.fileReferences ?? []);
							return false;
						},
					})
				) : (
					<QueuedMessageRow
						msg={{
							id: "queued",
							text: twinText,
							bufferedAt: "now",
							imageCount: 0,
							fileReferences: twinReferences,
						}}
						index={0}
						isEditing
						onStartEdit={() => {}}
						onCancelEdit={() => {}}
						onSaveEdit={async (_msg, _text, payload) => {
							payloads.push(payload.fileReferences);
							return false;
						}}
						onRemove={() => {}}
						onRetry={async () => ({ ok: true, resumed: false })}
						cancelBufferLabel="Cancel"
						editLabel="Edit"
						onChangeMode={async () => {}}
						onMove={() => {}}
					/>
				);
			await render(view());
			return { payloads, rerender: () => render(view()) };
		}
		for (const [replacement, inputType] of [
			["", "deleteContentBackward"],
			["x ", "insertText"],
			["pasted ", "insertFromPaste"],
		]) {
			test(`${inputType}: replacing first twin submits remote identity; undo restores both`, async () => {
				const { payloads, rerender } = await mount();
				await editRange(0, 11, replacement, inputType);
				await rerender(); // Queue broadcasts/parent rerenders must not reseed the draft.
				await editorKey("Enter");
				expect(payloads[0]).toEqual([
					{ ...twinReferences[1], inputRange: [replacement.length, replacement.length + 10] },
				]);
				await editorKey("z", true);
				expect(textareaProps().textarea.value).toBe(twinText);
				await editorKey("Enter");
				expect(payloads[1]).toEqual(twinReferences);
			});
		}
		for (const backward of [true, false]) {
			test(`collapsed ${backward ? "backward" : "forward"} deletion anchors at the actual caret`, async () => {
				const { payloads } = await mount();
				await act(async () => {
					const { textarea, props } = textareaProps();
					textarea.selectionStart = textarea.selectionEnd = backward ? 11 : 0;
					const event = new Event("beforeinput", { bubbles: true });
					Object.defineProperty(event, "inputType", {
						value: backward ? "deleteWordBackward" : "deleteWordForward",
					});
					textarea.dispatchEvent(event);
					textarea.value = twinText.slice(11);
					textarea.selectionStart = textarea.selectionEnd = 0;
					props.onChange?.({ currentTarget: textarea } as Parameters<
						NonNullable<typeof props.onChange>
					>[0]);
					await flush();
				});
				await editorKey("Enter");
				expect(payloads[0]).toEqual([{ ...twinReferences[1], inputRange: [0, 10] }]);
			});
		}
		test("plain paste selection fallback works without beforeinput", async () => {
			const { payloads } = await mount();
			await act(async () => {
				const { textarea, props } = textareaProps();
				textarea.selectionStart = 0;
				textarea.selectionEnd = 11;
				props.onPaste?.({
					currentTarget: textarea,
					clipboardData: { items: [] },
				} as unknown as Parameters<NonNullable<typeof props.onPaste>>[0]);
				textarea.value = `x ${twinText.slice(11)}`;
				textarea.selectionStart = textarea.selectionEnd = 2;
				props.onChange?.({ currentTarget: textarea } as Parameters<
					NonNullable<typeof props.onChange>
				>[0]);
				await flush();
			});
			await editorKey("Enter");
			expect(payloads[0]).toEqual([{ ...twinReferences[1], inputRange: [2, 12] }]);
		});
		test("IME cannot submit or consume undo while composing; replacement keeps remote identity", async () => {
			const { payloads } = await mount();
			await act(async () => {
				const { textarea, props } = textareaProps();
				textarea.selectionStart = 0;
				textarea.selectionEnd = 11;
				props.onCompositionStart?.({ currentTarget: textarea } as Parameters<
					NonNullable<typeof props.onCompositionStart>
				>[0]);
			});
			await editRange(0, 11, "你", "insertCompositionText");
			await editorKey("Enter");
			await editorKey("z", true);
			expect(payloads).toEqual([]);
			expect(textareaProps().textarea.value).toBe("你#file:a.ts ");
			await act(async () => {
				const { textarea, props } = textareaProps();
				props.onCompositionEnd?.({ currentTarget: textarea } as Parameters<
					NonNullable<typeof props.onCompositionEnd>
				>[0]);
			});
			await editorKey("Enter");
			expect(payloads[0].map((ref) => ref.id)).toEqual(["remote-ref"]);
			await editorKey("z", true);
			await editorKey("Enter");
			expect(payloads[1]).toEqual(twinReferences);
		});
	});
}

describe("message reference attachment editor", () => {
	test("pure refs display ranges and send metadata, not snapshot bytes; failed save retains draft", async () => {
		const close = mock(() => {});
		const save = mock(
			async (..._args: Parameters<NonNullable<MessageEditorPanelProps["onEditAndRegenerate"]>>) =>
				false,
		);
		await render(editor({ onEditAndRegenerate: save, onClose: close }));
		expect(document.body.textContent).toContain("#file:a.ts:2-2");
		expect(document.body.textContent).toContain("#file:a.ts:5-5");
		expect(button(en.editSubmit).disabled).toBe(false);
		expect(registered?.canSubmit).toBe(true);
		await click(button(en.editSubmit));
		expect(save.mock.calls[0][1]).toBe("");
		expect(save.mock.calls[0][3]?.fileReferences).toEqual([reference, secondReference]);
		expect(JSON.stringify(save.mock.calls[0][3])).not.toContain("snapshotText");
		expect(close).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("#file:a.ts:2-2");
	});

	test("removing one occurrence keeps the other selection, removing all disables pure-ref submit", async () => {
		const save = mock(
			async (..._args: Parameters<NonNullable<MessageEditorPanelProps["onEditAndRegenerate"]>>) =>
				false,
		);
		await render(editor({ onEditAndRegenerate: save }));
		await click(button(`${en.removeFile}: a.ts`));
		await click(button(en.editSubmit));
		expect(save.mock.calls[0][3]?.fileReferences).toEqual([secondReference]);
		await click(button(`${en.removeFile}: a.ts`));
		expect(button(en.editSubmit).disabled).toBe(true);
		expect(registered?.canSubmit).toBe(false);
	});

	test("removing all refs from a text message sends [] instead of restoring them", async () => {
		const save = mock(
			async (..._args: Parameters<NonNullable<MessageEditorPanelProps["onEditAndRegenerate"]>>) =>
				false,
		);
		await render(editor({ initialText: "keep text", onEditAndRegenerate: save }));
		await click(button(`${en.removeFile}: a.ts`));
		await click(button(`${en.removeFile}: a.ts`));
		await click(button(en.editSubmit));
		expect(save.mock.calls[0][3]?.fileReferences).toEqual([]);
	});
});

function queueRow(overrides: Partial<ComponentProps<typeof QueuedMessageRow>> = {}) {
	return (
		<QueuedMessageRow
			msg={{
				id: "queue-message",
				text: "Original input",
				bufferedAt: "now",
				imageCount: 0,
				state: "failed",
				error: "Provider refused request",
				fileReferences: [reference],
			}}
			index={0}
			isEditing={false}
			onStartEdit={() => {}}
			onCancelEdit={() => {}}
			onSaveEdit={async () => false}
			onRemove={() => {}}
			onRetry={(id) => api.retryBufferedMessage("target-narrator", id)}
			cancelBufferLabel="Cancel"
			editLabel="Edit"
			onChangeMode={async () => {}}
			onMove={() => {}}
			{...overrides}
		/>
	);
}

describe("visible queued message collaboration details", () => {
	const queued = {
		id: "queued-detail",
		text: "Queued body",
		state: "queued" as const,
		bufferedAt: "now",
		imageCount: 0,
		creator: { id: "teammate-id", username: "teammate", avatarColor: "#5c7cfa" },
	};

	test("a single sender remains visible for one message and several messages by the same sender", async () => {
		for (const count of [1, 2]) {
			await render(
				queuePanel({
					queuedMessages: Array.from({ length: count }, (_, index) => ({
						...queued,
						id: `detail-${index}`,
					})),
				}),
			);
			const senders = document.querySelectorAll("[data-queue-sender]");
			expect(senders).toHaveLength(count);
			for (const sender of senders) expect(sender.textContent).toContain("teammate");
		}
	});

	test("missing creator is explicit rather than silently attributed to the current user", async () => {
		await render(queueRow({ msg: { ...queued, creator: null } }));
		expect(document.querySelector("[data-queue-sender]")?.textContent).toContain(
			en.queuedSenderUnknown,
		);
	});

	test("all thumbnails, file names and references are visible without expanding attachments", async () => {
		await render(
			queueRow({
				msg: {
					...queued,
					imageCount: 4,
					images: Array.from({ length: 4 }, (_, index) => ({
						imageId: `image-${index}`,
						filename: `image-${index}.png`,
						mediaType: "image/png",
					})),
					textFiles: [
						{ index: 0, filename: "notes.txt", size: 12 },
						{ index: 1, filename: "report.md", size: 8 },
					],
					fileReferences: [reference],
				},
			}),
		);
		expect(document.querySelector("[data-queue-attachment-preview]")).not.toBeNull();
		expect(document.querySelectorAll("[data-queue-image]")).toHaveLength(4);
		expect(document.body.textContent).toContain("notes.txt");
		expect(document.body.textContent).toContain("report.md");
		expect(document.body.textContent).toContain("#file:a.ts:2-2");
	});

	test("remove is directly accessible and double-clicking it does not edit", async () => {
		const remove = mock((_id: string) => {});
		const edit = mock((_message: unknown) => {});
		await render(queueRow({ msg: queued, onRemove: remove, onStartEdit: edit }));
		const externalRemove = button("Cancel");
		await click(externalRemove);
		await act(async () => externalRemove.dispatchEvent(new Event("dblclick", { bubbles: true })));
		expect(remove).toHaveBeenCalledWith(queued.id);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(edit).not.toHaveBeenCalled();
	});

	test("double-clicking body or blank row space edits exactly once per gesture", async () => {
		const edit = mock((_message: unknown) => {});
		await render(queueRow({ msg: queued, onStartEdit: edit }));
		await act(async () =>
			button(en.queuedExpandText).dispatchEvent(new Event("dblclick", { bubbles: true })),
		);
		expect(edit).toHaveBeenCalledTimes(1);
		expect(edit).toHaveBeenCalledWith(queued);
		const row = document.querySelector("[data-queue-message-row]");
		if (!row) throw new Error("Queued row missing");
		await act(async () => row.dispatchEvent(new Event("dblclick", { bubbles: true })));
		expect(edit).toHaveBeenCalledTimes(2);
	});

	test("double-clicking attachments or urgent controls cannot start editing", async () => {
		const edit = mock((_message: unknown) => {});
		await render(queueRow({ msg: { ...queued, fileReferences: [reference] }, onStartEdit: edit }));
		const preview = document.querySelector("[data-queue-attachment-preview]");
		if (!preview) throw new Error("Attachment preview missing");
		await act(async () => {
			preview.dispatchEvent(new Event("dblclick", { bubbles: true }));
			button(en.queuedSendUrgently).dispatchEvent(new Event("dblclick", { bubbles: true }));
		});
		expect(edit).not.toHaveBeenCalled();
	});
});

describe("queued collaboration gesture and image integration", () => {
	test("double-click opens the real editor with sender, original text and attachments intact", async () => {
		const message = {
			id: "edit-by-double-click",
			text: "Original queued text",
			bufferedAt: "now",
			imageCount: 0,
			creator: { id: "peer", username: "peer" },
			fileReferences: [reference],
		};
		let editingQueuedId: string | null = null;
		const view = () =>
			queuePanel({
				queuedMessages: [message],
				editingQueuedId,
				handleStartEditQueued: (msg) => {
					editingQueuedId = msg.id;
				},
			});
		await render(view());
		await act(async () =>
			button(en.queuedExpandText).dispatchEvent(new Event("dblclick", { bubbles: true })),
		);
		expect<string | null>(editingQueuedId).toBe(message.id);
		await render(view());
		expect(textareaProps().textarea.value).toBe(message.text);
		expect(document.querySelector("[data-queue-sender]")?.textContent).toContain("peer");
		expect(document.body.textContent).toContain("#file:a.ts:2-2");
	});

	test("mode changes in flight block double-click editing and external removal", async () => {
		const pending = Promise.withResolvers<void>();
		const edit = mock((_message: unknown) => {});
		const remove = mock((_id: string) => {});
		await render(
			queueRow({
				msg: { id: "pending-mode", text: "Queued", bufferedAt: "now", imageCount: 0 },
				onChangeMode: () => pending.promise,
				onStartEdit: edit,
				onRemove: remove,
			}),
		);
		await click(button(en.queuedSwitchToGuidance));
		expect(button("Cancel").disabled).toBe(true);
		await act(async () =>
			button(en.queuedExpandText).dispatchEvent(new Event("dblclick", { bubbles: true })),
		);
		expect(edit).not.toHaveBeenCalled();
		await act(async () => {
			pending.resolve();
			await flush();
		});
		expect(button("Cancel").disabled).toBe(false);
		await act(async () =>
			button(en.queuedExpandText).dispatchEvent(new Event("dblclick", { bubbles: true })),
		);
		expect(edit).toHaveBeenCalledTimes(1);
	});

	test("image previews fetch immediately using explicit or legacy narrator ownership", async () => {
		const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => null },
		});
		const fetchImplementation: typeof fetch = Object.assign(
			async () => new Response(new Blob(["image bytes"], { type: "image/png" })),
			{ preconnect: globalThis.fetch.preconnect },
		);
		const fetchImage = spyOn(globalThis, "fetch").mockImplementation(fetchImplementation);
		try {
			await render(
				queuePanel({
					narratorId: "queue-owner",
					queuedMessages: [
						{
							id: "images",
							text: "Images",
							bufferedAt: "now",
							imageCount: 2,
							images: [
								{ imageId: "legacy", filename: "legacy.png", mediaType: "image/png" },
								{
									imageId: "modern",
									filename: "modern.png",
									mediaType: "image/png",
									uploadNarratorId: "upload-owner",
								},
							],
						},
					],
				}),
			);
			const requests = fetchImage.mock.calls
				.map(([url]) => String(url))
				.filter((url) => url.includes("/uploads/"));
			expect(requests).toEqual([
				"/api/uploads/queue-owner/legacy",
				"/api/uploads/upload-owner/modern",
			]);
			for (const filename of ["legacy.png", "modern.png"]) {
				const image = document.querySelector(`img[alt="${filename}"]`);
				expect(image).not.toBeNull();
				expect(image?.getAttribute("src")).toStartWith("blob:");
			}
		} finally {
			fetchImage.mockRestore();
			if (storage) Object.defineProperty(globalThis, "localStorage", storage);
			else Reflect.deleteProperty(globalThis, "localStorage");
		}
	});
});

describe("inline queued message mode actions", () => {
	const queued = {
		id: "queue-message",
		text: "Keep this input",
		bufferedAt: "now",
		imageCount: 0,
		state: "queued" as const,
		fileReferences: [reference],
	};

	test("switches between next step and guidance with one visible button", async () => {
		const change = mock(async (_id: string, _mode: "turn" | "tool" | "interrupt") => {});
		await render(queueRow({ msg: queued, onChangeMode: change }));
		await click(button(en.queuedSwitchToGuidance));
		expect(change.mock.calls).toEqual([[queued.id, "tool"]]);
		await render(queueRow({ msg: { ...queued, queueMode: "tool" }, onChangeMode: change }));
		await click(button(en.queuedSwitchToNextStep));
		expect(change.mock.calls).toEqual([
			[queued.id, "tool"],
			[queued.id, "turn"],
		]);
		expect(document.body.textContent).toContain(queued.text);
	});

	test("urgent is one-way and simultaneous clicks cannot submit twice", async () => {
		const pending = Promise.withResolvers<void>();
		const change = mock((_id: string, _mode: "turn" | "tool" | "interrupt") => pending.promise);
		await render(queueRow({ msg: queued, onChangeMode: change }));
		const urgent = button(en.queuedSendUrgently);
		const toggle = button(en.queuedSwitchToGuidance);
		await act(async () => {
			urgent.dispatchEvent(new Event("click", { bubbles: true }));
			urgent.dispatchEvent(new Event("click", { bubbles: true }));
			toggle.dispatchEvent(new Event("click", { bubbles: true }));
			await flush();
		});
		expect(change.mock.calls).toEqual([[queued.id, "interrupt"]]);
		expect(urgent.disabled).toBe(true);
		expect(toggle.disabled).toBe(true);
		await act(async () => {
			pending.resolve();
			await flush();
		});
		expect(button(en.queuedUrgentRequested).disabled).toBe(true);
		expect(document.querySelector(`button[aria-label="${en.queuedSwitchToGuidance}"]`)).toBeNull();
		expect(document.querySelector(`button[aria-label="${en.queuedSwitchToNextStep}"]`)).toBeNull();
		expect(change).toHaveBeenCalledTimes(1);
	});

	test("already urgent rows have no switch-back action", async () => {
		const change = mock(async (_id: string, _mode: "turn" | "tool" | "interrupt") => {});
		await render(queueRow({ msg: { ...queued, queueMode: "interrupt" }, onChangeMode: change }));
		expect(button(en.queuedUrgentRequested).disabled).toBe(true);
		expect(document.querySelector(`button[aria-label="${en.queuedSwitchToNextStep}"]`)).toBeNull();
		expect(change).not.toHaveBeenCalled();
	});

	test("an unsuccessful urgent request releases buttons and retains content", async () => {
		const change = mock(async (_id: string, _mode: "turn" | "tool" | "interrupt") => false);
		await render(queueRow({ msg: queued, onChangeMode: change }));
		await click(button(en.queuedSendUrgently));
		expect(button(en.queuedSendUrgently).disabled).toBe(false);
		expect(button(en.queuedSwitchToGuidance).disabled).toBe(false);
		expect(document.body.textContent).toContain(queued.text);
		expect(document.body.textContent).toContain("#file:a.ts:2-2");
	});

	test("failed messages cannot urgently stop work before an explicit retry", async () => {
		const change = mock(async (_id: string, _mode: "turn" | "tool" | "interrupt") => {});
		await render(queueRow({ onChangeMode: change }));
		expect(button(en.queuedSendUrgently).disabled).toBe(true);
		expect(button(en.queuedSwitchToGuidance).disabled).toBe(false);
		await click(button(en.queuedSwitchToGuidance));
		expect(change.mock.calls).toEqual([["queue-message", "tool"]]);
	});
});
describe("failed queued message retry UI", () => {
	test("failed rows show full reason, input, attachments and explicit retry; queued/legacy rows do not", async () => {
		await render(queueRow());
		expect(document.body.textContent).toContain(en.queuedFailed);
		expect(document.body.textContent).toContain("Provider refused request");
		expect(document.body.textContent).toContain("Original input");
		expect(document.body.textContent).toContain("#file:a.ts:2-2");
		expect(button(en.queuedRetry).disabled).toBe(false);
		for (const state of ["queued", undefined] as const) {
			await render(
				queueRow({
					msg: {
						id: "queue-message",
						text: "Still queued",
						bufferedAt: "now",
						imageCount: 0,
						state,
					},
				}),
			);
			expect(document.body.textContent).toContain("Still queued");
			expect(document.body.textContent).not.toContain(en.queuedFailed);
			expect(document.body.textContent).not.toContain(en.queuedRetry);
		}
	});

	test("missing failure reason gets a visible fallback", async () => {
		await render(
			queueRow({
				msg: {
					id: "queue-message",
					text: "Input",
					bufferedAt: "now",
					imageCount: 0,
					state: "failed",
					error: null,
				},
			}),
		);
		expect(document.body.textContent).toContain(en.queuedFailureUnknown);
	});

	test("POST targets narrator/message once while pending, failure preserves data and resumed=false only says requeued", async () => {
		const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const notice = spyOn(notifications, "show").mockImplementation(() => "notice");
		const requests: { url: string; method: string | undefined }[] = [];
		let respond: ((response: Response) => void) | undefined;
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => null },
		});
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: (url: string, init: RequestInit) => {
				requests.push({ url, method: init.method });
				return new Promise<Response>((resolve) => {
					respond = resolve;
				});
			},
		});
		try {
			await render(queueRow());
			const retry = button(en.queuedRetry);
			await act(async () => {
				retry.dispatchEvent(new Event("click", { bubbles: true }));
				retry.dispatchEvent(new Event("click", { bubbles: true }));
				await flush();
			});
			expect(requests).toEqual([
				{ url: "/api/narrators/target-narrator/buffer/queue-message/retry", method: "POST" },
			]);
			expect(retry.disabled).toBe(true);
			await act(async () => {
				respond?.(Response.json({ error: "Retry network failure" }, { status: 503 }));
				await flush();
			});
			expect(retry.disabled).toBe(false);
			expect(document.body.textContent).toContain("Retry network failure");
			expect(document.body.textContent).toContain("Provider refused request");
			expect(document.body.textContent).toContain("Original input");
			expect(document.body.textContent).toContain("#file:a.ts:2-2");
			expect(notice).not.toHaveBeenCalled();
			await click(retry);
			expect(requests).toHaveLength(2);
			await act(async () => {
				respond?.(Response.json({ ok: true, resumed: false }));
				await flush();
			});
			expect(notice).toHaveBeenCalledWith({ color: "blue", message: "Message requeued." });
			expect(document.body.textContent).not.toContain("Retry network failure");
		} finally {
			notice.mockRestore();
			for (const [key, descriptor] of [
				["fetch", originalFetch],
				["localStorage", originalStorage],
			] as const) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});

	test("editing a failed row preserves its reason and draft on save failure without retrying", async () => {
		const retry = mock(async () => ({ ok: true as const, resumed: false }));
		const save = mock(async () => false);
		await render(queueRow({ isEditing: true, onRetry: retry, onSaveEdit: save }));
		await editRange(0, "Original input".length, "Changed draft");
		await editorKey("Enter");
		expect(save).toHaveBeenCalledTimes(1);
		expect(textareaProps().textarea.value).toBe("Changed draft");
		expect(document.body.textContent).toContain("Provider refused request");
		expect(retry).not.toHaveBeenCalled();
	});

	test("saving a failed edit does not retry; cancel still removes the same message", async () => {
		const retry = mock(async () => ({ ok: true as const, resumed: false }));
		const cancelEdit = mock(() => {});
		const remove = mock(() => {});
		await render(
			queueRow({
				isEditing: true,
				onRetry: retry,
				onSaveEdit: async () => true,
				onCancelEdit: cancelEdit,
			}),
		);
		await editorKey("Enter");
		expect(cancelEdit).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
		await render(queueRow({ onRetry: retry, onRemove: remove }));
		const menu = document.querySelector(`button[aria-label="${en.queuedActions}"]`);
		if (!menu) throw new Error("Queue menu button missing");
		await click(menu);
		const cancel = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
			(item) => item.textContent === "Cancel",
		);
		if (!cancel) throw new Error("Cancel menu item missing");
		await click(cancel);
		expect(remove).toHaveBeenCalledWith("queue-message");
		expect(retry).not.toHaveBeenCalled();
	});
});

describe("queued reference attachment editor", () => {
	test("collapsed preview shows reference-only attachments", async () => {
		await render(
			<QueuedAttachmentPreview images={[]} textFiles={[]} fileReferences={[reference]} />,
		);
		expect(document.body.textContent).toContain("#file:a.ts:2-2");
	});

	test("queued pure references retain metadata and support occurrence deletion", async () => {
		const payloads: QueuedEditPayload[] = [];
		const cancel = mock(() => {});
		await render(
			<QueuedMessageRow
				msg={{
					id: "queued",
					text: "",
					bufferedAt: "now",
					imageCount: 0,
					fileReferences: [reference, secondReference],
				}}
				index={0}
				isEditing
				onStartEdit={() => {}}
				onCancelEdit={cancel}
				onSaveEdit={async (_message, _text, payload) => {
					payloads.push(payload);
					return false;
				}}
				onRemove={() => {}}
				onRetry={async () => ({ ok: true, resumed: false })}
				cancelBufferLabel="Cancel"
				editLabel="Edit"
				onChangeMode={async () => {}}
				onMove={() => {}}
			/>,
		);
		await click(button(`${en.removeFile}: a.ts`));
		const save = document.querySelector("button .tabler-icon-check")?.closest("button");
		if (!save) throw new Error("Queued save button missing");
		expect(save.disabled).toBe(false);
		await click(save);
		expect(payloads[0].fileReferences).toEqual([secondReference]);
		expect(cancel).not.toHaveBeenCalled();
		await click(button(`${en.removeFile}: a.ts`));
		expect(save.disabled).toBe(true);
	});
});

function queuePanel(overrides: Partial<QueuedMessagesPanelProps> = {}) {
	return (
		<QueuedMessagesPanel
			queuedMessages={[]}
			queueExpanded
			editingQueuedId={null}
			setQueueExpanded={() => {}}
			handleDragEndQueued={() => {}}
			handleMoveQueued={() => {}}
			handleChangeMode={async () => {}}
			handleSaveEditQueued={async () => true}
			handleCancelEditQueued={() => {}}
			handleStartEditQueued={() => {}}
			handleRemoveQueued={() => {}}
			handleRetryQueued={async () => ({ ok: true, resumed: false })}
			handleCancelAllQueued={() => {}}
			{...overrides}
		/>
	);
}

describe("real queued panel composition", () => {
	for (const change of [
		"cancel head",
		"consume head",
		"split segment",
		"merge segments",
		"change edited mode",
		"move ordinary head",
		"drag ordinary head",
		"collapsed single grows while editing",
	] as const) {
		test(`unsaved body, new attachments and undo survive ${change}`, async () => {
			let messages: QueuedMessagesPanelProps["queuedMessages"] = [
				{ id: "head", text: "Head", queueMode: "turn", imageCount: 0, bufferedAt: "now" },
				{ id: "edited", text: "Original", queueMode: "turn", imageCount: 0, bufferedAt: "now" },
				{ id: "tail", text: "Tail", queueMode: "turn", imageCount: 0, bufferedAt: "now" },
			];
			if (change === "merge segments") messages[0].queueMode = "tool";
			const collapsedSingle = change === "collapsed single grows while editing";
			if (collapsedSingle) messages = [messages[1]];
			let editingQueuedId: string | null = "edited";
			const setQueueExpanded = mock((_expanded: boolean) => {});
			const save = mock(
				async (
					_msg: unknown,
					_text: string,
					_payload: Parameters<QueuedMessagesPanelProps["handleSaveEditQueued"]>[2],
				) => false,
			);
			const view = () =>
				queuePanel({
					queuedMessages: messages,
					editingQueuedId,
					queueExpanded: !collapsedSingle,
					setQueueExpanded,
					handleSaveEditQueued: save,
					handleRemoveQueued: (id) => {
						messages = messages.filter((message) => message.id !== id);
					},
					handleMoveQueued: (id, direction) => {
						const index = messages.findIndex((message) => message.id === id);
						const nextIndex = index + direction;
						if (index < 0 || nextIndex < 0 || nextIndex >= messages.length) return;
						messages = [...messages];
						[messages[index], messages[nextIndex]] = [messages[nextIndex], messages[index]];
					},
				});
			await render(view());
			await editRange(0, "Original".length, "Unsaved body");
			const image = new File(["gif"], "draft.gif", { type: "image/gif" });
			const textFile = new File(["draft content"], "draft.txt", { type: "text/plain" });
			await act(async () => {
				const { textarea, props } = textareaProps();
				props.onPaste?.({
					currentTarget: textarea,
					clipboardData: {
						items: [image, textFile].map((file) => ({
							kind: "file",
							type: file.type,
							getAsFile: () => file,
						})),
					},
					preventDefault() {},
				} as unknown as Parameters<NonNullable<typeof props.onPaste>>[0]);
				await flush();
			});
			const textareaBefore = textareaProps().textarea;
			if (change === "cancel head" || change === "move ordinary head") {
				const menu = document.querySelectorAll(`button[aria-label="${en.queuedActions}"]`)[1];
				if (!menu) throw new Error("Head row menu missing");
				await click(menu);
				const label = change === "cancel head" ? en.cancelBuffer : en.queuedMoveDown;
				const action = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
					(node) => node.textContent === label,
				);
				if (!action) throw new Error(`Head action missing: ${label}`);
				await click(action);
			} else if (collapsedSingle) {
				messages = [
					...messages,
					{ id: "new", text: "New arrival", queueMode: "turn", imageCount: 0, bufferedAt: "later" },
				];
			} else if (change === "consume head") {
				messages = messages.slice(1);
			} else if (change === "drag ordinary head") {
				// The parent applies a drag's resulting authoritative queue order.
				messages = [messages[1], messages[2], messages[0]];
			} else if (change === "change edited mode") {
				messages = messages.map((message) =>
					message.id === "edited" ? { ...message, queueMode: "interrupt" } : message,
				);
			} else {
				messages = messages.map((message) =>
					message.id === "head"
						? { ...message, queueMode: change === "split segment" ? "tool" : "turn" }
						: message,
				);
			}
			// A buffer_set also replaces summary objects; this must not re-seed drafts.
			messages = messages.map((message) => ({ ...message }));
			await render(view());
			expect(host?.querySelector("textarea")).not.toBeNull();
			expect(textareaProps().textarea.value).toBe("Unsaved body");
			expect(textareaProps().textarea).toBe(textareaBefore);
			expect(host?.querySelector('img[alt="draft.gif"]')).not.toBeNull();
			expect(host?.textContent).toContain("draft.txt");
			await editorKey("Enter");
			expect(save).toHaveBeenCalledTimes(1);
			expect(save.mock.calls[0][1]).toBe("Unsaved body");
			expect(save.mock.calls[0][2].newImages).toEqual([image]);
			expect(save.mock.calls[0][2].newTextFiles).toEqual([textFile]);
			await editorKey("z", true);
			expect(textareaProps().textarea.value).toBe("Original");
			if (collapsedSingle) {
				const toggle = host?.querySelector<HTMLButtonElement>("[data-queue-summary] button");
				if (!toggle) throw new Error("Queue visibility toggle missing");
				// Editing pins the list open and disables manual collapse until editing ends.
				expect(toggle.getAttribute("aria-expanded")).toBe("true");
				expect(toggle.disabled).toBe(true);
				await click(toggle);
				expect(setQueueExpanded).not.toHaveBeenCalled();
				expect(textareaProps().textarea).toBe(textareaBefore);
				editingQueuedId = null;
				await render(view());
				// Once editing ends, the unchanged user's collapsed preference takes effect.
				expect(host?.querySelector("textarea")).toBeNull();
				expect(toggle.getAttribute("aria-expanded")).toBe("false");
				expect(toggle.disabled).toBe(false);
				expect(host?.textContent).not.toContain("New arrival");
				expect(setQueueExpanded).not.toHaveBeenCalled();
			}
		});
	}
	test("two-line message preview expands by pointer and keyboard without losing text", async () => {
		const fullText = "First line\nSecond line\nThird line\nFourth line";
		await render(
			queueRow({ msg: { id: "long", text: fullText, imageCount: 0, bufferedAt: "now" } }),
		);
		const preview = document.querySelector<HTMLButtonElement>(
			`button[aria-label="${en.queuedExpandText}"]`,
		);
		if (!preview) throw new Error("Expandable message preview missing");
		expect(preview.getAttribute("aria-expanded")).toBe("false");
		expect(preview.getAttribute("data-line-clamp")).toBe("true");
		await click(preview);
		expect(preview.getAttribute("aria-expanded")).toBe("true");
		expect(preview.hasAttribute("data-line-clamp")).toBe(false);
		expect(preview.textContent).toBe(fullText);
		for (const key of ["Enter", " "]) {
			await act(async () => {
				const event = new Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(event, "key", { value: key });
				preview.dispatchEvent(event);
			});
			expect(preview.getAttribute("aria-expanded")).toBe(key === "Enter" ? "false" : "true");
		}
		expect(preview.getAttribute("aria-expanded")).toBe("true");
		expect(preview.getAttribute("aria-label")).toBe(en.queuedCollapseText);
	});

	test("guidance modes have distinct borders and labels; only ordinary edit has a drag handle", async () => {
		for (const [mode, color] of [
			["turn", "default-border"],
			["tool", "indigo-4"],
			["interrupt", "orange-5"],
		] as const) {
			const msg = { id: mode, queueMode: mode, text: "Message", imageCount: 0, bufferedAt: "now" };
			await render(queuePanel({ queuedMessages: [msg] }));
			const body = host?.querySelector(`[data-queue-mode="${mode}"]`);
			expect(body?.getAttribute("style")).toContain(`var(--mantine-color-${color})`);
			expect(host?.textContent).toContain(en[`queueMode_${mode}`]);
			await render(queueRow({ msg, isEditing: true }));
			expect(host?.querySelector("[data-queue-drag-handle]") !== null).toBe(mode === "turn");
		}
	});
	test("mixed guidance preserves FIFO and only consecutive modes share headings", async () => {
		const modes = ["tool", "interrupt", "tool", "tool", "turn"] as const;
		await render(
			queuePanel({
				queuedMessages: modes.map((queueMode, index) => ({
					id: `fifo-${index}`,
					text: `FIFO message ${index}`,
					queueMode,
					bufferedAt: "now",
					imageCount: 0,
				})),
			}),
		);
		const content = host?.textContent ?? "";
		for (let index = 0; index < modes.length - 1; index++) {
			expect(content.indexOf(`FIFO message ${index}`)).toBeLessThan(
				content.indexOf(`FIFO message ${index + 1}`),
			);
		}
		// Summary has aggregate counts, list headings represent four consecutive segments.
		const headings = Array.from(host?.querySelectorAll("p") ?? []).filter((node) =>
			[en.queueMode_tool, en.queueMode_interrupt, en.queueMode_turn].includes(
				node.textContent ?? "",
			),
		);
		expect(headings.map((node) => node.textContent)).toEqual([
			en.queueMode_tool,
			en.queueMode_interrupt,
			en.queueMode_tool,
			en.queueMode_turn,
		]);
	});

	test("single message has no duplicate summary and clear lives in its row menu", async () => {
		const clear = mock(() => {});
		await render(
			queuePanel({
				queueExpanded: false,
				handleCancelAllQueued: clear,
				queuedMessages: [
					{ id: "only", text: "Only message", queueMode: "tool", imageCount: 0, bufferedAt: "now" },
				],
			}),
		);
		expect(host?.querySelector("[data-queue-summary]")).toBeNull();
		expect(host?.textContent).toContain("Only message");
		expect((host?.textContent ?? "").split(en.queueMode_tool)).toHaveLength(2);
		const menu = document.querySelector(`button[aria-label="${en.queuedActions}"]`);
		if (!menu) throw new Error("Row menu missing");
		await click(menu);
		const clearItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
			(node) => node.textContent === en.clearAllQueued,
		);
		if (!clearItem) throw new Error("Single-row clear action missing");
		await click(clearItem);
		expect(clear).toHaveBeenCalledTimes(1);
	});
});
