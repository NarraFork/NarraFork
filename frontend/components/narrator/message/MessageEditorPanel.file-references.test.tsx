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
import { EditingMessageCtx, type EditingMessageState } from "../EditingMessageCtx";
import { QueuedAttachmentPreview, QueuedMessageRow } from "../QueuedMessageRow";
import type { QueuedEditPayload } from "../queued-attachment-edit";
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
							{child}
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
						priorityLabel="Priority"
						priorityNextRequestLabel="Next"
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
			priorityLabel="Priority"
			priorityNextRequestLabel="Next"
			{...overrides}
		/>
	);
}

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
		const cancel = document.querySelector('button[title="Cancel"]');
		if (!cancel) throw new Error("Cancel button missing");
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
				priorityLabel="Priority"
				priorityNextRequestLabel="Next"
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
