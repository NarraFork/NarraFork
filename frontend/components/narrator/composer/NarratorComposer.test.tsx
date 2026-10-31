import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ImageViewerContext } from "@frontend/components/common/image-viewer-context";
import { ApiError, api } from "@frontend/lib/api";
import {
	resetPromptOptimizeTasksForTest,
	startPromptOptimizeTask,
} from "@frontend/lib/prompt-optimize-tasks";
import { flush, resetSessionStoreForTest, writeSession } from "@frontend/lib/session-store";
import { MantineProvider } from "@mantine/core";
import {
	type ComposerDocument,
	composerDocumentText,
	MAX_COMPOSER_DOCUMENT_TEXT,
	parseComposerDocument,
} from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor, JSONContent } from "@tiptap/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import narratorEn from "../../../locales/en/narrator.json";
import { joinQuotedComposerInput } from "./composer-quotes";
import { FileReferenceScopeProvider } from "./FileReferenceScope";
import { insertFileReference } from "./file-reference-input";
import {
	NarratorComposer,
	type NarratorComposerHandle,
	type NarratorRemoteDraft,
} from "./NarratorComposer";
import {
	getNarratorDraftStorageId,
	persistNarratorInputDraft,
	readNarratorInputDraft,
} from "./narrator-draft-storage";

const reference: FileReference = {
	id: "occurrence",
	deviceId: "RemoteABC",
	path: "/work/src/a.ts",
	label: "src/a.ts",
};
const initial: NarratorRemoteDraft = {
	hasDraft: false,
	text: "",
	fileReferences: [],
	revision: 1,
	sourceId: null,
	updatedAt: null,
	updatedBy: null,
};
let root: Root;
let host: HTMLElement;
let instance: i18n;
let qc: QueryClient;
let handle = createRef<NarratorComposerHandle>();
let sendingRef = { current: false };
let flags: boolean[];
let renders: number;
let testNarratorId = "n1";
let attachmentsHydrating: boolean;
let attachmentsRestoreFailed: boolean;
let retryAttachments = mock(() => {});
let documentAssetsChange = mock((_ids: readonly string[]) => {});
let getSpy: ReturnType<typeof spyOn<typeof api, "getNarratorDraft">>;
let panelSpy: ReturnType<typeof spyOn<typeof api, "getNarratorPanelState">>;
let updateSpy: ReturnType<typeof spyOn<typeof api, "updateNarratorDraft">>;
let mockServerRevision = 1;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function Harness() {
	renders++;
	return (
		<NarratorComposer
			ref={handle}
			narratorId={testNarratorId}
			sendingRef={sendingRef}
			permEnterActive={false}
			hasAttachments={false}
			attachmentsHydrating={attachmentsHydrating}
			attachmentsRestoreFailed={attachmentsRestoreFailed}
			onRetryAttachments={retryAttachments}
			onDocumentAssetsChange={documentAssetsChange}
			enterMode="turn"
			ctrlEnterMode="interrupt"
			onSendWithMode={() => {}}
			onTextFlagsChange={(value) => flags.push(value)}
			onPasteImages={() => {}}
		/>
	);
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "fonts", {
		configurable: true,
		value: { addEventListener() {}, removeEventListener() {} },
	});
	const selection = {
		rangeCount: 0,
		anchorNode: null,
		anchorOffset: 0,
		focusNode: null,
		focusOffset: 0,
		removeAllRanges() {
			this.rangeCount = 0;
		},
		addRange() {
			this.rangeCount = 1;
		},
		collapse() {},
		extend() {},
		getRangeAt() {
			return window.document.createRange();
		},
	};
	Object.defineProperty(window.document, "getSelection", {
		configurable: true,
		value: () => selection,
	});
	const stored = new Map<string, string>();
	const storage = {
		get length() {
			return stored.size;
		},
		clear() {
			stored.clear();
		},
		getItem: (key: string) => stored.get(key) ?? null,
		key: (i: number) => [...stored.keys()][i] ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => {
			stored.delete(key);
		},
	};
	for (const [key, value] of Object.entries({
		window,
		innerHeight: 800,
		innerWidth: 1200,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		sessionStorage: storage,
		localStorage: storage,
		getComputedStyle: (): Partial<CSSStyleDeclaration> => ({
			getPropertyValue: () => "0px",
			direction: "ltr",
			boxSizing: "border-box",
			borderBottomWidth: "0",
			borderTopWidth: "0",
			paddingBottom: "0",
			paddingTop: "0",
		}),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (): number => 1,
		cancelAnimationFrame: () => {},
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	resetSessionStoreForTest();
	// Drain query observer notifications inside act; no timer may outlive the DOM fixture.
	notifyManager.setScheduler(queueMicrotask);
	instance = i18next.createInstance();
	await instance.use(initReactI18next).init({
		lng: "en",
		resources: {
			en: {
				narrator: {
					attachments: narratorEn.attachments,
					draftReplacedByRemote: "replaced by remote",
					draftRestorePrevious: "restore original",
					draftStaleLocalSetAside: "stale local set aside",
					draftUseStaleLocal: "use stale local",
					draftDismissReplace: "dismiss",
				},
			},
		},
		react: { useSuspense: false },
	});
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
	});
	qc.setQueryData(["auth", "me"], { id: "u1" });
	qc.setQueryData(["named-narrators"], []);
	panelSpy = spyOn(api, "getNarratorPanelState").mockResolvedValue({
		permissions: [],
		buffer: [],
		draft: { hasDraft: false, revision: 1, updatedAt: null },
		hasMore: { permissions: false, buffer: false },
	});
	getSpy = spyOn(api, "getNarratorDraft").mockResolvedValue(initial);
	mockServerRevision = initial.revision;
	updateSpy = spyOn(api, "updateNarratorDraft").mockImplementation(
		async (_id, text, sourceId, fileReferences, composerDocument) => ({
			...initial,
			ok: true,
			traits: [],
			text,
			fileReferences,
			composerDocument,
			revision: ++mockServerRevision,
			sourceId: sourceId ?? null,
			hasDraft: !!text || !!fileReferences?.length || !!composerDocument?.assets.length,
		}),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	handle = createRef<NarratorComposerHandle>();
	sendingRef = { current: false };
	flags = [];
	renders = 0;
	testNarratorId = "n1";
	attachmentsHydrating = false;
	attachmentsRestoreFailed = false;
	retryAttachments = mock(() => {});
	documentAssetsChange = mock((_ids: readonly string[]) => {});
});

afterEach(async () => {
	await act(async () => root.unmount());
	// Tiptap releases its view on a zero-delay destroy timer; keep this fixture's DOM alive.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
	});
	host.remove();
	qc.clear();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	getSpy.mockRestore();
	panelSpy.mockRestore();
	updateSpy.mockRestore();
	resetSessionStoreForTest();
	resetPromptOptimizeTasksForTest();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<MantineProvider env="test">
					<I18nextProvider i18n={instance}>
						<FileReferenceScopeProvider
							value={{ narratorId: "n1", context: { deviceId: "RemoteABC", cwd: "/work" } }}
						>
							<ImageViewerContext.Provider value={{ open: () => {} }}>
								<Harness />
							</ImageViewerContext.Provider>
						</FileReferenceScopeProvider>
					</I18nextProvider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
}

function getEditor(): Editor {
	const element = host.querySelector<HTMLDivElement>(".ProseMirror") as
		| (HTMLDivElement & { editor?: Editor })
		| null;
	if (!element?.editor) throw new Error("Missing real composer editor");
	return element.editor;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function activateAttachment(name: string) {
	const button = host.querySelector<HTMLButtonElement>(
		`[data-composer-atom="attachment"] button[aria-label="${name}"]`,
	);
	expect(button).not.toBeNull();
	const event = new Event("click", { bubbles: true });
	Object.defineProperty(event, "detail", { value: 0 });
	await act(async () => button?.dispatchEvent(event));
}

async function clickButton(label: string) {
	const button = [...host.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === label,
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}

test("switching a mounted composer waits for the target narrator's draft before delivering", async () => {
	for (const [id, text] of [
		["n1", "first"],
		["n2", "second"],
	]) {
		persistNarratorInputDraft("u1", id, text, 1, "t1", [], { text, fileReferences: [] });
	}
	await render();
	expect(handle.current?.getText()).toBe("first");
	const document: ComposerDocument = {
		version: 1,
		paragraphs: [{ children: [{ type: "text", text: "second" }] }],
		assets: [],
	};
	await act(async () => {
		startPromptOptimizeTask({
			narratorId: "n2",
			text: "second",
			snapshot: { document, selection: { start: 0, end: 0 }, token: "pending" },
			style: "clarify",
			withContext: false,
			request: async () => ({ text: "SECOND" }),
		});
	});
	testNarratorId = "n2";
	await render();
	expect(handle.current?.getText()).toBe("SECOND");
	expect(readNarratorInputDraft("u1", "n1").text).toBe("first");
});
describe("composer local text attachment previews", () => {
	test("opens the cached File without changing the draft, attachment membership, or persistence", async () => {
		await render();
		const content = "<script>not executable</script>\nlocal text";
		const file = new File([content], "local.html", { type: "text/html" });
		await act(async () =>
			expect(
				handle.current?.insertAcceptedFiles(
					[file],
					handle.current.captureAttachmentInsertion("direct"),
				),
			).toBe(true),
		);
		const before = handle.current?.getDocument();
		const stored = readNarratorInputDraft("u1", "n1");
		documentAssetsChange.mockClear();
		updateSpy.mockClear();
		await activateAttachment(file.name);
		expect(document.querySelector("pre")?.textContent).toBe(content);
		expect(document.querySelector("script")).toBeNull();
		expect(handle.current?.getDocument()).toEqual(before);
		expect(readNarratorInputDraft("u1", "n1")).toEqual(stored);
		expect(documentAssetsChange).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
		expect(handle.current?.hasMissingAssets()).toBe(false);
	});

	test.each([
		"narrator",
		"user",
	] as const)("switching %s closes the preview and cannot revive a late read", async (owner) => {
		await render();
		const pending = deferred<ArrayBuffer>();
		const file = new File(["placeholder"], "private.txt");
		spyOn(file, "slice").mockReturnValue({ arrayBuffer: () => pending.promise } as Blob);
		await act(async () =>
			expect(
				handle.current?.insertAcceptedFiles(
					[file],
					handle.current.captureAttachmentInsertion("direct"),
				),
			).toBe(true),
		);
		await activateAttachment(file.name);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		if (owner === "narrator") testNarratorId = "n2";
		else qc.setQueryData(["auth", "me"], { id: "u2" });
		await render();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => pending.resolve(new TextEncoder().encode("private late content").buffer));
		expect(document.body.textContent).not.toContain("private late content");
		if (owner === "narrator") testNarratorId = "n1";
		else qc.setQueryData(["auth", "me"], { id: "u1" });
		await render();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});

describe("composer revision-only initial reconciliation", () => {
	for (const state of [
		{ text: "acknowledged text", fileReferences: [reference] },
		{ text: "", fileReferences: [reference] },
		{ text: "", fileReferences: [] },
	]) {
		test(`delayed metadata preserves the acknowledged marker for ${JSON.stringify(state)}`, async () => {
			const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
			panelSpy.mockReturnValue(pending.promise);
			persistNarratorInputDraft("u1", "n1", state.text, 7, "t7", state.fileReferences, state);
			const acknowledged = readNarratorInputDraft("u1", "n1");
			await render();
			expect(handle.current?.getText()).toBe(state.text);
			expect(handle.current?.getFileReferences()).toEqual(state.fileReferences);
			expect(readNarratorInputDraft("u1", "n1")).toEqual(acknowledged);
			expect(getSpy).not.toHaveBeenCalled();
			expect(updateSpy).not.toHaveBeenCalled();
			await act(async () =>
				pending.resolve({
					permissions: [],
					buffer: [],
					draft: {
						hasDraft: !!(state.text || state.fileReferences.length),
						revision: 7,
						updatedAt: "t7",
					},
					hasMore: { permissions: false, buffer: false },
				}),
			);
			expect(readNarratorInputDraft("u1", "n1")).toEqual(acknowledged);
			expect(getSpy).not.toHaveBeenCalled();
		});
	}

	for (const remote of [
		{
			...initial,
			hasDraft: true,
			text: "new elsewhere",
			fileReferences: [{ ...reference, id: "remote" }],
			revision: 8,
		},
		{ ...initial, revision: 8 },
	]) {
		test(`a quick switch during metadata loading adopts the newer remote ${remote.hasDraft ? "edit" : "clear"}`, async () => {
			const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
			panelSpy.mockReturnValueOnce(pending.promise);
			const state = { text: "old acknowledged", fileReferences: [reference] };
			persistNarratorInputDraft("u1", "n1", state.text, 7, "t7", state.fileReferences, state);
			await render();
			testNarratorId = "n2";
			await render();
			getSpy.mockClear();
			panelSpy.mockResolvedValue({
				permissions: [],
				buffer: [],
				draft: { hasDraft: remote.hasDraft, revision: 8, updatedAt: "t8" },
				hasMore: { permissions: false, buffer: false },
			});
			getSpy.mockResolvedValue({ ...remote, updatedAt: "t8" });
			testNarratorId = "n1";
			await render();
			expect(handle.current?.getText()).toBe(remote.text);
			expect(handle.current?.getFileReferences()).toEqual(remote.fileReferences);
			expect(host.textContent).not.toContain("replaced by remote");
			expect(getSpy).toHaveBeenCalledTimes(1);
			expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBe(8);
			expect(readNarratorInputDraft("u1", "n1").unsynced).toBeUndefined();
			await act(async () =>
				pending.resolve({
					permissions: [],
					buffer: [],
					draft: { hasDraft: true, revision: 7, updatedAt: "t7" },
					hasMore: { permissions: false, buffer: false },
				}),
			);
			expect(handle.current?.getText()).toBe(remote.text);
			expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBe(8);
			expect(updateSpy).not.toHaveBeenCalled();
		});
	}

	for (const edit of ["text", "references", "clear"] as const) {
		test(`a real ${edit} edit left unsynced yields to a newer remote and is offered back`, async () => {
			const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
			panelSpy.mockReturnValueOnce(pending.promise);
			const state = { text: "acknowledged", fileReferences: [reference] };
			persistNarratorInputDraft("u1", "n1", state.text, 7, "t7", state.fileReferences, state);
			await render();
			await act(async () => {
				if (edit === "text") handle.current?.setText("changed");
				else if (edit === "references")
					handle.current?.setFileReferences([{ ...reference, path: "/work/new.ts" }]);
				else handle.current?.clearTextAndDraft();
			});
			const edited = readNarratorInputDraft("u1", "n1");
			expect(edited.unsynced).toBe(true);
			expect(edited.syncedRevision).toBeUndefined();
			expect(updateSpy).not.toHaveBeenCalled();
			testNarratorId = "n2";
			await render();
			getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "remote newer", revision: 8 });
			testNarratorId = "n1";
			await render();
			// Revision 8 was written elsewhere after these edits: pushing them would replace it.
			expect(handle.current?.getText()).toBe("remote newer");
			expect(handle.current?.getFileReferences()).toEqual([]);
			expect(readNarratorInputDraft("u1", "n1")).toMatchObject({
				text: "remote newer",
				syncedRevision: 8,
			});
			expect(updateSpy).not.toHaveBeenCalled();
			expect(host.textContent).not.toContain("replaced by remote");
			if (edit === "clear") {
				// An empty stale copy has nothing worth offering back.
				expect(host.textContent).not.toContain("stale local set aside");
				return;
			}
			expect(host.textContent).toContain("stale local set aside");
			await clickButton("use stale local");
			expect(handle.current?.getText()).toBe(edited.text);
			expect(handle.current?.getFileReferences()).toEqual(edited.fileReferences ?? []);
			expect(host.textContent).not.toContain("stale local set aside");
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 820));
			});
			expect(updateSpy.mock.calls.at(-1)?.[1]).toBe(edited.text);
		});
	}

	for (const serverRevision of [1, null]) {
		test(`an unsynced clear with base ${serverRevision} stays dirty before metadata returns`, async () => {
			const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
			panelSpy.mockReturnValue(pending.promise);
			persistNarratorInputDraft("u1", "n1", "", serverRevision, null, [], {
				text: "cleared but not acknowledged",
				fileReferences: [reference],
			});
			await render();
			expect(readNarratorInputDraft("u1", "n1").unsynced).toBe(true);
			expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBeUndefined();
			expect(handle.current?.isTextEmpty()).toBe(true);
		});
	}

	for (const text of ["", "legacy unknown"]) {
		test(`an unknown local baseline ${JSON.stringify(text)} is never stamped acknowledged`, async () => {
			const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
			panelSpy.mockReturnValue(pending.promise);
			persistNarratorInputDraft("u1", "n1", text, 1, null);
			await render();
			expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBeUndefined();
			expect(handle.current?.getText()).toBe(text);
		});
	}
	for (const text of ["", "unknown restored text"]) {
		test(`editing then returning to an unknown ${JSON.stringify(text)} snapshot does not erase dirty state`, async () => {
			const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
			panelSpy.mockReturnValue(pending.promise);
			persistNarratorInputDraft("u1", "n1", text, null, null);
			await render();
			await act(async () => handle.current?.setText("actually edited"));
			expect(readNarratorInputDraft("u1", "n1").unsynced).toBe(true);
			await act(async () => handle.current?.setText(text));
			expect(readNarratorInputDraft("u1", "n1").unsynced).toBe(true);
			expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBeUndefined();
			getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "new remote", revision: 2 });
			await act(async () =>
				pending.resolve({
					permissions: [],
					buffer: [],
					draft: { hasDraft: true, revision: 2, updatedAt: null },
					hasMore: { permissions: false, buffer: false },
				}),
			);
			expect(handle.current?.getText()).toBe(text);
			expect(host.textContent).not.toContain("replaced by remote");
			expect(readNarratorInputDraft("u1", "n1").unsynced).toBe(true);
		});
	}

	for (const localKind of ["acknowledged", "unsynced clear", "new empty"] as const) {
		test(`WS during delayed metadata handles ${localKind} without assuming an empty sync baseline`, async () => {
			const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
			panelSpy.mockReturnValue(pending.promise);
			if (localKind === "acknowledged") {
				const state = { text: "ack", fileReferences: [reference] };
				persistNarratorInputDraft("u1", "n1", state.text, 1, null, state.fileReferences, state);
			} else if (localKind === "unsynced clear") {
				persistNarratorInputDraft("u1", "n1", "", 1, null, [], null);
			}
			await render();
			await act(async () =>
				handle.current?.handleDraftChanged({
					...initial,
					hasDraft: true,
					text: "new WS",
					fileReferences: [reference],
					revision: 2,
					sourceId: "other",
				}),
			);
			// A stale unsynced clear must not wipe the newer remote draft.
			expect(handle.current?.getText()).toBe("new WS");
			expect(handle.current?.getFileReferences()).toEqual([reference]);
			expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBe(2);
			expect(host.textContent).not.toContain("stale local set aside");
			// Only replacing shown content earns the restore offer.
			if (localKind === "acknowledged") expect(host.textContent).toContain("replaced by remote");
			else expect(host.textContent).not.toContain("replaced by remote");
			await act(async () =>
				pending.resolve({
					permissions: [],
					buffer: [],
					draft: { hasDraft: true, revision: 1, updatedAt: null },
					hasMore: { permissions: false, buffer: false },
				}),
			);
			expect(handle.current?.getText()).toBe("new WS");
			expect(getSpy).not.toHaveBeenCalled();
		});
	}

	test("restores an acknowledged local text/reference snapshot without fetching the body", async () => {
		const state = { text: "local acknowledged", fileReferences: [reference] };
		persistNarratorInputDraft("u1", "n1", state.text, 1, null, state.fileReferences, state);
		panelSpy.mockResolvedValue({
			permissions: [],
			buffer: [],
			draft: { hasDraft: true, revision: 1, updatedAt: null },
			hasMore: { permissions: false, buffer: false },
		});
		await render();
		expect(handle.current?.getText()).toBe(state.text);
		expect(handle.current?.getFileReferences()).toEqual(state.fileReferences);
		expect(getSpy).not.toHaveBeenCalled();
		expect(panelSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy).not.toHaveBeenCalled();
	});

	test("a dirty local revision baseline is not mistaken for a synchronized revision", async () => {
		persistNarratorInputDraft("u1", "n1", "dirty", 1, null, [reference], {
			text: "old",
			fileReferences: [],
		});
		getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "old" });
		await render();
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(handle.current?.getText()).toBe("dirty");
		expect(handle.current?.getFileReferences()).toEqual([reference]);
		expect(readNarratorInputDraft("u1", "n1").unsynced).toBe(true);
	});

	test("metadata arriving after typing preserves both new text and attachments", async () => {
		const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
		panelSpy.mockReturnValue(pending.promise);
		const state = { text: "synced", fileReferences: [reference] };
		persistNarratorInputDraft("u1", "n1", state.text, 1, null, state.fileReferences, state);
		await render();
		expect(handle.current?.getText()).toBe("synced");
		const newerRefs = [{ ...reference, id: "new", path: "/work/new.ts" }];
		await act(async () => handle.current?.restoreInput("typed during metadata", newerRefs));
		await act(async () =>
			pending.resolve({
				permissions: [],
				buffer: [],
				draft: { hasDraft: true, revision: 1, updatedAt: "t1" },
				hasMore: { permissions: false, buffer: false },
			}),
		);
		expect(handle.current?.getText()).toBe("typed during metadata");
		expect(handle.current?.getFileReferences()).toEqual(newerRefs);
		expect(getSpy).not.toHaveBeenCalled();
		expect(readNarratorInputDraft("u1", "n1").unsynced).toBe(true);
	});

	test("a newer server body sets unsynced stored edits aside instead of pushing them", async () => {
		persistNarratorInputDraft("u1", "n1", "dirty", 1, null, [reference], {
			text: "old",
			fileReferences: [],
		});
		getSpy.mockResolvedValue({
			...initial,
			hasDraft: true,
			text: "other",
			fileReferences: [{ ...reference, deviceId: "other" }],
			revision: 2,
		});
		await render();
		expect(host.textContent).not.toContain("replaced by remote");
		expect(host.textContent).toContain("stale local set aside");
		expect(handle.current?.getText()).toBe("other");
		expect(handle.current?.getFileReferences()).toEqual([{ ...reference, deviceId: "other" }]);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 820));
		});
		expect(updateSpy).not.toHaveBeenCalled();
		await clickButton("use stale local");
		expect(handle.current?.getText()).toBe("dirty");
		expect(handle.current?.getFileReferences()).toEqual([reference]);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 820));
		});
		expect(updateSpy.mock.calls.at(-1)?.[1]).toBe("dirty");
	});

	test("version-1 local text without a base survives an empty server", async () => {
		writeSession(
			"narrator-draft",
			getNarratorDraftStorageId("u1", "n1"),
			JSON.stringify({ version: 1, text: "legacy local", serverUpdatedAt: null }),
		);
		flush();
		await render();
		expect(handle.current?.getText()).toBe("legacy local");
		expect(host.textContent).not.toContain("stale local set aside");
	});

	test("a late body cannot erase text and reference edits made while it loaded", async () => {
		const pending = deferred<NarratorRemoteDraft>();
		getSpy.mockReturnValue(pending.promise);
		await render();
		await act(async () => handle.current?.restoreInput("new local", [reference]));
		await act(async () =>
			pending.resolve({ ...initial, hasDraft: true, text: "remote", revision: 2 }),
		);
		expect(handle.current?.getText()).toBe("new local");
		expect(handle.current?.getFileReferences()).toEqual([reference]);
		expect(host.textContent).not.toContain("replaced by remote");
	});

	test("a WS revision invalidates an older hydration response", async () => {
		const pending = deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>();
		panelSpy.mockReturnValue(pending.promise);
		persistNarratorInputDraft("u1", "n1", "", 1, null, [], { text: "", fileReferences: [] });
		await render();
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				hasDraft: true,
				text: "new WS",
				revision: 2,
				fileReferences: [reference],
				sourceId: "other",
			}),
		);
		await act(async () =>
			pending.resolve({
				permissions: [],
				buffer: [],
				draft: { hasDraft: false, revision: 1, updatedAt: null },
				hasMore: { permissions: false, buffer: false },
			}),
		);
		expect(handle.current?.getText()).toBe("new WS");
		expect(handle.current?.getFileReferences()).toEqual([reference]);
		expect(getSpy).not.toHaveBeenCalled();
	});

	for (const error of [new ApiError("old server", 404), new TypeError("network failure")]) {
		test(`falls back to the old body endpoint for ${error.message}`, async () => {
			panelSpy.mockRejectedValue(error);
			getSpy.mockResolvedValue({
				...initial,
				hasDraft: true,
				text: "legacy",
				fileReferences: [reference],
			});
			await render();
			expect(getSpy).toHaveBeenCalledTimes(1);
			expect(handle.current?.getText()).toBe("legacy");
			expect(handle.current?.getFileReferences()).toEqual([reference]);
		});
	}

	test("authorization failure is not bypassed through legacy endpoints", async () => {
		panelSpy.mockRejectedValue(new ApiError("forbidden", 403));
		await render();
		expect(getSpy).not.toHaveBeenCalled();
	});

	for (const switchKind of ["account", "narrator"] as const) {
		test(`does not persist the previous pair's text or attachments under a new ${switchKind}`, async () => {
			const state = { text: "previous pair private text", fileReferences: [reference] };
			persistNarratorInputDraft("u1", "n1", state.text, 1, null, state.fileReferences, state);
			panelSpy.mockResolvedValue({
				permissions: [],
				buffer: [],
				draft: { hasDraft: true, revision: 1, updatedAt: null },
				hasMore: { permissions: false, buffer: false },
			});
			await render();
			expect(handle.current?.getText()).toBe(state.text);
			if (switchKind === "account")
				await act(async () => qc.setQueryData(["auth", "me"], { id: "u2" }));
			else testNarratorId = "n2";
			await render();
			expect(handle.current?.getText()).toBe("");
			expect(handle.current?.getFileReferences()).toEqual([]);
			const next = readNarratorInputDraft(switchKind === "account" ? "u2" : "u1", testNarratorId);
			expect(next.text).toBe("");
			expect(next.fileReferences).toBeUndefined();
			expect(readNarratorInputDraft("u1", "n1").text).toBe(state.text);
		});
		test(`ignores the old pair's body after switching ${switchKind}`, async () => {
			const pending = deferred<NarratorRemoteDraft>();
			getSpy.mockReturnValueOnce(pending.promise);
			await render();
			if (switchKind === "account")
				await act(async () => qc.setQueryData(["auth", "me"], { id: "u2" }));
			else {
				testNarratorId = "n2";
				await render();
			}
			await act(async () =>
				pending.resolve({
					...initial,
					hasDraft: true,
					text: "old pair secret",
					fileReferences: [reference],
				}),
			);
			expect(handle.current?.getText()).toBe("");
			expect(handle.current?.getFileReferences()).toEqual([]);
			expect(
				readNarratorInputDraft(switchKind === "account" ? "u2" : "u1", testNarratorId).text,
			).toBe("");
		});
	}
});

describe("composer rich document contract", () => {
	function richDocument(): ComposerDocument {
		return parseComposerDocument({
			version: 1,
			assets: [
				{ id: "missing-image", kind: "image", name: "a.png", size: 1, mimeType: "image/png" },
			],
			paragraphs: [
				{
					children: [
						{ type: "text", text: "before " },
						{ type: "quote", id: "quote-node", label: "Assistant", text: "quote body" },
						{ type: "attachment", id: "image-node", assetId: "missing-image" },
						{ type: "fileReference", id: "file-node", reference },
						{ type: "text", text: " after  " },
					],
				},
			],
		});
	}
	test.each([
		"local hydration",
		"metadata fast path",
	] as const)("%s declares rich draft asset ownership before Files finish restoring", async (path) => {
		attachmentsHydrating = true;
		const doc = richDocument();
		const input = { ...composerDocumentText(doc), composerDocument: doc };
		persistNarratorInputDraft("u1", "n1", input.text, 7, "t7", input.fileReferences, input, doc);
		if (path === "local hydration") {
			panelSpy.mockReturnValue(
				deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>().promise,
			);
		} else {
			panelSpy.mockResolvedValue({
				permissions: [],
				buffer: [],
				draft: { hasDraft: true, revision: 7, updatedAt: "t7" },
				hasMore: { permissions: false, buffer: false },
			});
		}
		await render();
		expect(handle.current?.getDocument()).toEqual(doc);
		expect(documentAssetsChange).toHaveBeenCalledWith(["missing-image"]);
		expect(documentAssetsChange.mock.calls.every(([ids]) => ids.includes("missing-image"))).toBe(
			true,
		);
		expect(getSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
	});
	test("deleting a pending image declares empty membership without waiting for its File", async () => {
		attachmentsHydrating = true;
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		expect(documentAssetsChange).toHaveBeenLastCalledWith(["missing-image"]);
		const pendingImage = host.querySelector('[data-composer-asset-id="missing-image"]');
		expect(pendingImage?.getAttribute("data-loading")).toBe("true");
		expect(pendingImage?.hasAttribute("data-missing")).toBe(false);
		expect(pendingImage?.getAttribute("aria-busy")).toBe("true");
		documentAssetsChange.mockClear();
		const editor = getEditor();
		let position = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === "attachment") position = pos;
		});
		expect(position).toBeGreaterThan(0);
		await act(async () => editor.view.dispatch(editor.state.tr.delete(position, position + 1)));
		expect(handle.current?.getDocument()?.assets).toEqual([]);
		expect(documentAssetsChange).toHaveBeenLastCalledWith([]);
		// The removed image takes its positional placeholder with it.
		expect(input.text).toContain("[image #1: a.png]");
		expect(handle.current?.getText()).toBe(input.text.replace("[image #1: a.png]", ""));
		attachmentsHydrating = false;
		await render();
		expect(handle.current?.getDocument()?.assets).toEqual([]);
		expect(handle.current?.hasMissingAssets()).toBe(false);
	});
	test("an unavailable image becomes missing only after attachment restoration settles", async () => {
		attachmentsHydrating = true;
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		const image = () => host.querySelector('[data-composer-asset-id="missing-image"]');
		expect(image()?.getAttribute("data-loading")).toBe("true");
		expect(image()?.hasAttribute("data-missing")).toBe(false);
		expect(handle.current?.hasMissingAssets()).toBe(true);
		expect(host.textContent).toContain("composerRestoringAssets");
		expect(host.textContent).not.toContain("composerMissingAssets");
		attachmentsHydrating = false;
		await render();
		expect(image()?.hasAttribute("data-loading")).toBe(false);
		expect(image()?.getAttribute("data-missing")).toBe("true");
		expect(image()?.hasAttribute("aria-busy")).toBe(false);
		expect(handle.current?.hasMissingAssets()).toBe(true);
		expect(host.textContent).toContain("composerMissingAssets");
		expect(host.textContent).not.toContain("composerRestoringAssets");
		expect(handle.current?.getDocument()).toEqual(doc);
		expect(documentAssetsChange).toHaveBeenLastCalledWith(["missing-image"]);
	});
	test("legacy typing during attachment hydration does not declare unknown membership empty", async () => {
		attachmentsHydrating = true;
		const input = { text: "legacy input", fileReferences: [] };
		persistNarratorInputDraft("u1", "n1", input.text, 7, "t7", [], input);
		panelSpy.mockReturnValue(
			deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>().promise,
		);
		await render();
		expect(documentAssetsChange).not.toHaveBeenCalled();
		const editor = getEditor();
		await act(async () => editor.view.dispatch(editor.state.tr.insertText("typed ", 1)));
		expect(handle.current?.getText()).toBe("typed legacy input");
		expect(documentAssetsChange).not.toHaveBeenCalled();
		await act(async () => handle.current?.clearTextAndDraft());
		expect(documentAssetsChange).toHaveBeenLastCalledWith([]);
		expect(handle.current?.getText()).toBe("");
	});
	test.each([
		"hydrating",
		"failed",
		"fails after editing",
	] as const)("legacy %s edits preserve unknown membership in local mirrors and autosaves", async (state) => {
		attachmentsHydrating = state !== "failed";
		attachmentsRestoreFailed = state === "failed";
		const input = insertFileReference({ text: "legacy input", fileReferences: [] }, reference);
		const edited = insertFileReference(
			{ text: "typed legacy input", fileReferences: [] },
			reference,
		);
		persistNarratorInputDraft("u1", "n1", input.text, 7, "t7", input.fileReferences, input);
		panelSpy.mockResolvedValue({
			permissions: [],
			buffer: [],
			draft: { hasDraft: true, revision: 7, updatedAt: "t7" },
			hasMore: { permissions: false, buffer: false },
		});
		await render();
		expect(documentAssetsChange).not.toHaveBeenCalled();
		const editor = getEditor();
		await act(async () => editor.view.dispatch(editor.state.tr.insertText("typed ", 1)));
		if (state === "fails after editing") {
			attachmentsHydrating = false;
			attachmentsRestoreFailed = true;
			await render();
		}
		expect(handle.current?.getText()).toBe(edited.text);
		expect(handle.current?.getFileReferences()).toEqual(edited.fileReferences);
		expect(documentAssetsChange).not.toHaveBeenCalled();
		expect(readNarratorInputDraft("u1", "n1")).toMatchObject({
			text: edited.text,
			fileReferences: edited.fileReferences,
		});
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toBeUndefined();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 820));
		});
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy.mock.calls[0]?.[1]).toBe(edited.text);
		expect(updateSpy.mock.calls[0]?.[3]).toEqual(edited.fileReferences);
		expect(updateSpy.mock.calls[0]?.[4]).toBeUndefined();
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toBeUndefined();
		expect(documentAssetsChange).not.toHaveBeenCalled();
	});
	test.each([
		"explicit clear",
		"rich restore",
		"successful retry",
	] as const)("a failed legacy restore accepts authoritative membership after %s", async (action) => {
		attachmentsRestoreFailed = true;
		const input = { text: "legacy input", fileReferences: [] };
		persistNarratorInputDraft("u1", "n1", input.text, 7, "t7", [], input);
		panelSpy.mockReturnValue(
			deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>().promise,
		);
		await render();
		if (action === "successful retry") {
			attachmentsRestoreFailed = false;
			await render();
		} else if (action === "explicit clear") {
			await act(async () => handle.current?.clearTextAndDraft());
		} else {
			const doc = richDocument();
			const restored = composerDocumentText(doc);
			await act(async () =>
				handle.current?.restoreInput(restored.text, restored.fileReferences, doc),
			);
		}
		const expectedIds = action === "rich restore" ? ["missing-image"] : [];
		if (action !== "successful retry")
			expect(documentAssetsChange).toHaveBeenLastCalledWith(expectedIds);
		const editor = getEditor();
		await act(async () => editor.view.dispatch(editor.state.tr.insertText("new ", 1)));
		expect(handle.current?.getText()).toContain("new ");
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toEqual(
			handle.current?.getDocument(),
		);
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toBeDefined();
		expect(documentAssetsChange).toHaveBeenLastCalledWith(expectedIds);
	});
	test("attachment restoration failure offers a retry without clearing editable legacy input", async () => {
		attachmentsRestoreFailed = true;
		const input = { text: "legacy input", fileReferences: [] };
		persistNarratorInputDraft("u1", "n1", input.text, 7, "t7", [], input);
		panelSpy.mockReturnValue(
			deferred<Awaited<ReturnType<typeof api.getNarratorPanelState>>>().promise,
		);
		await render();
		expect(host.textContent).toContain("composerAttachmentsRestoreFailed");
		const retry = [...host.querySelectorAll("button")].find((button) =>
			/retry/i.test(button.textContent ?? ""),
		);
		expect(retry).toBeDefined();
		await act(async () => retry?.click());
		expect(retryAttachments).toHaveBeenCalledTimes(1);
		expect(handle.current?.getText()).toBe(input.text);
		expect(documentAssetsChange).not.toHaveBeenCalled();
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toBeUndefined();
		const editor = getEditor();
		await act(async () => editor.view.dispatch(editor.state.tr.insertText("still editable ", 1)));
		expect(handle.current?.getText()).toBe("still editable legacy input");
		expect(documentAssetsChange).not.toHaveBeenCalled();
	});
	test("restore, hide and failure restore retain the exact document and missing-resource state", async () => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		expect(handle.current?.getDocument()).toEqual(doc);
		expect(handle.current?.hasMissingAssets()).toBe(true);
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toEqual(doc);
		sendingRef.current = true;
		await act(async () => handle.current?.hideTextForSend());
		expect(handle.current?.getText()).toBe("");
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toEqual(doc);
		sendingRef.current = false;
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		expect(handle.current?.getDocument()).toEqual(doc);
		expect(handle.current?.hasMissingAssets()).toBe(true);
	});
	// Real File/objectURL send recovery and release run in NarratorComposer.browser.test.ts:
	// linkedom hangs while mounting the image NodeView, so Chromium verifies the actual lifecycle.
	test("real ProseMirror text transactions and undo preserve mixed node order", async () => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		const editor = getEditor();
		await act(async () => editor.view.dispatch(editor.state.tr.insertText("edited ", 1)));
		expect(handle.current?.getText()).toContain("edited before ");
		const nodeKinds = () =>
			handle.current?.getDocument()?.paragraphs[0].children.map((node) => node.type);
		expect(nodeKinds()).toEqual(["text", "quote", "attachment", "fileReference", "text"]);
		await act(async () => {
			editor.commands.undo();
		});
		expect(handle.current?.getDocument()).toEqual(doc);
		expect(nodeKinds()).toEqual(["text", "quote", "attachment", "fileReference", "text"]);
	});
	test("a newer layout-only remote edit sets older unsynced local edits aside", async () => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		const moved: ComposerDocument = {
			...doc,
			paragraphs: [
				{
					children: [
						doc.paragraphs[0].children[2],
						...doc.paragraphs[0].children.filter((node) => node.type !== "attachment"),
					],
				},
			],
		};
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				...input,
				hasDraft: true,
				composerDocument: moved,
				revision: 2,
				sourceId: "other",
			}),
		);
		expect(handle.current?.getDocument()).toEqual(moved);
		expect(host.textContent).toContain("stale local set aside");
		await clickButton("use stale local");
		expect(handle.current?.getDocument()).toEqual(doc);
	});
	test.each([
		"local edit",
		"newer remote clear",
	] as const)("late WS document reads preserve a %s", async (change) => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		const pending = deferred<Awaited<ReturnType<typeof api.getNarratorDraft>>>();
		getSpy.mockReturnValueOnce(pending.promise);
		const summary = {
			...initial,
			...input,
			hasDraft: true,
			hasComposerDocument: true,
			revision: 2,
			sourceId: "other",
		};
		await act(async () => handle.current?.handleDraftChanged(summary));
		if (change === "local edit")
			await act(async () => handle.current?.restoreInput("new input", []));
		else
			await act(async () =>
				handle.current?.handleDraftChanged({ ...initial, revision: 3, sourceId: "other" }),
			);
		await act(async () => pending.resolve({ ...summary, composerDocument: doc }));
		expect(handle.current?.getText()).toBe(change === "local edit" ? "new input" : "");
		expect(handle.current?.getDocument()).toBeUndefined();
	});
	test.each([
		"clear",
		"legacy text",
	] as const)("a layout summary accepts a newer GET %s before its WS event arrives", async (change) => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				...input,
				hasDraft: true,
				composerDocument: doc,
				revision: 2,
				sourceId: "other",
			}),
		);
		const pending = deferred<NarratorRemoteDraft>();
		getSpy.mockClear();
		getSpy.mockReturnValueOnce(pending.promise);
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				...input,
				hasDraft: true,
				hasComposerDocument: true,
				revision: 3,
				sourceId: "other",
			}),
		);
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(handle.current?.getDocument()).toEqual(doc);
		const text = change === "clear" ? "" : "newer legacy text";
		await act(async () =>
			pending.resolve({
				...initial,
				hasDraft: change !== "clear",
				text,
				revision: 4,
				sourceId: "other",
			}),
		);
		expect(handle.current?.getText()).toBe(text);
		expect(handle.current?.getFileReferences()).toEqual([]);
		expect(handle.current?.getDocument()).toBeUndefined();
		expect(handle.current?.hasMissingAssets()).toBe(false);
		expect(host.textContent).not.toContain("draftLoadFailed");
		// Replacing real content, by a clear or by other text, earns the restore offer.
		expect(host.textContent).toContain("replaced by remote");
		expect(readNarratorInputDraft("u1", "n1")).toMatchObject({ text, syncedRevision: 4 });
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toBeUndefined();
		expect(readNarratorInputDraft("u1", "n1").unsynced).toBeUndefined();
	});

	test("a same-revision nonempty GET without its announced layout errors without changing local input", async () => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		const local = readNarratorInputDraft("u1", "n1");
		const pending = deferred<NarratorRemoteDraft>();
		getSpy.mockClear();
		getSpy.mockReturnValueOnce(pending.promise);
		const summary = {
			...initial,
			hasDraft: true,
			text: "missing layout",
			hasComposerDocument: true,
			revision: 2,
			sourceId: "other",
		};
		await act(async () => handle.current?.handleDraftChanged(summary));
		await act(async () => pending.resolve({ ...summary, hasComposerDocument: false }));
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(host.textContent).toContain("draftLoadFailed");
		expect(host.textContent).not.toContain("replaced by remote");
		expect(handle.current?.getText()).toBe(input.text);
		expect(handle.current?.getFileReferences()).toEqual(input.fileReferences);
		expect(handle.current?.getDocument()).toEqual(doc);
		expect(handle.current?.hasMissingAssets()).toBe(true);
		expect(readNarratorInputDraft("u1", "n1")).toEqual(local);
	});

	test.each([
		"newer remote clear",
		"account switch",
		"narrator switch",
	] as const)("a late layout GET rejection does not error after a %s", async (change) => {
		await render();
		const pending = deferred<void>();
		getSpy.mockReturnValueOnce(
			pending.promise.then(() => {
				throw new Error("stale layout request failed");
			}),
		);
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				hasDraft: true,
				text: "old rich summary",
				hasComposerDocument: true,
				revision: 2,
				sourceId: "other",
			}),
		);
		if (change === "newer remote clear") {
			await act(async () =>
				handle.current?.handleDraftChanged({
					...initial,
					revision: 3,
					sourceId: "other",
				}),
			);
		} else if (change === "account switch") {
			await act(async () => qc.setQueryData(["auth", "me"], { id: "u2" }));
		} else {
			testNarratorId = "n2";
			await render();
		}
		const userId = change === "account switch" ? "u2" : "u1";
		const local = readNarratorInputDraft(userId, testNarratorId);
		await act(async () => pending.resolve());
		expect(host.textContent).not.toContain("draftLoadFailed");
		expect(host.textContent).not.toContain("replaced by remote");
		expect(handle.current?.getText()).toBe("");
		expect(handle.current?.getFileReferences()).toEqual([]);
		expect(handle.current?.getDocument()).toBeUndefined();
		expect(readNarratorInputDraft(userId, testNarratorId)).toEqual(local);
	});

	test.each([
		"same-revision save",
		"newer local clear",
	] as const)("a redundant layout GET rejection does not undo an acknowledged %s", async (acknowledgement) => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		const save = deferred<Awaited<ReturnType<typeof api.updateNarratorDraft>>>();
		updateSpy.mockReturnValueOnce(save.promise);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 820));
		});
		expect(updateSpy).toHaveBeenCalledTimes(1);
		const sourceId = updateSpy.mock.calls[0][2] ?? null;
		const read = deferred<void>();
		getSpy.mockClear();
		getSpy.mockReturnValueOnce(
			read.promise.then(() => {
				throw new Error("redundant layout request failed");
			}),
		);
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				...input,
				hasDraft: true,
				hasComposerDocument: true,
				revision: 2,
				sourceId,
			}),
		);
		expect(getSpy).toHaveBeenCalledTimes(1);
		await act(async () =>
			save.resolve({
				...initial,
				...input,
				composerDocument: doc,
				hasDraft: true,
				revision: 2,
				sourceId,
				ok: true,
				traits: [],
			}),
		);
		// The manually resolved save bypassed the mock's revision counter; keep it in step.
		mockServerRevision = 2;
		expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBe(2);
		expect(handle.current?.getDocument()).toEqual(doc);
		if (acknowledgement === "newer local clear") {
			await act(async () => handle.current?.clearTextAndDraft());
			expect(updateSpy).toHaveBeenCalledTimes(2);
		}
		const text = acknowledgement === "same-revision save" ? input.text : "";
		const revision = acknowledgement === "same-revision save" ? 2 : 3;
		const local = readNarratorInputDraft("u1", "n1");
		expect(local.syncedRevision).toBe(revision);
		await act(async () => read.resolve());
		expect(host.textContent).not.toContain("draftLoadFailed");
		expect(host.textContent).not.toContain("replaced by remote");
		expect(handle.current?.getText()).toBe(text);
		expect(handle.current?.getDocument()).toEqual(
			acknowledgement === "same-revision save" ? doc : undefined,
		);
		expect(readNarratorInputDraft("u1", "n1")).toEqual(local);
		expect(local.unsynced).toBeUndefined();
	});

	test("old-server empty summaries ignore a contradictory layout flag without fetching or erroring", async () => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				...input,
				hasDraft: true,
				composerDocument: doc,
				revision: 2,
				sourceId: "other",
			}),
		);
		getSpy.mockClear();
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				hasComposerDocument: true,
				revision: 3,
				sourceId: "other",
			}),
		);
		expect(getSpy).not.toHaveBeenCalled();
		expect(host.textContent).not.toContain("draftLoadFailed");
		// The empty summary cleared real on-screen content: the undo offer appears.
		expect(host.textContent).toContain("replaced by remote");
		expect(handle.current?.getText()).toBe("");
		expect(handle.current?.getFileReferences()).toEqual([]);
		expect(handle.current?.getDocument()).toBeUndefined();
		expect(handle.current?.hasMissingAssets()).toBe(false);
		expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBe(3);
		expect(readNarratorInputDraft("u1", "n1").composerDocument).toBeUndefined();
	});

	test.each([
		"overlong text",
		"editor rejection",
	] as const)("failed restore from %s preserves local text, document and persistent draft atomically", async (failure) => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(input.text, input.fileReferences, doc));
		const local = readNarratorInputDraft("u1", "n1");
		const editor = getEditor();
		const editorDocument = editor.getJSON();
		const rejection =
			failure === "editor rejection"
				? spyOn(editor.view, "updateState").mockImplementationOnce(() => {
						throw new Error("editor rejected replacement");
					})
				: undefined;
		try {
			await act(async () => {
				expect(() =>
					handle.current?.restoreInput(
						failure === "overlong text"
							? "x".repeat(MAX_COMPOSER_DOCUMENT_TEXT + 1)
							: "replacement",
						[],
					),
				).toThrow();
			});
			if (rejection) expect(rejection).toHaveBeenCalledTimes(1);
			expect(handle.current?.getText()).toBe(input.text);
			expect(handle.current?.getFileReferences()).toEqual(input.fileReferences);
			expect(handle.current?.getDocument()).toEqual(doc);
			expect(handle.current?.hasMissingAssets()).toBe(true);
			expect(editor.getJSON()).toEqual(editorDocument);
			expect(readNarratorInputDraft("u1", "n1")).toEqual(local);
		} finally {
			rejection?.mockRestore();
		}
		await act(async () => editor.view.dispatch(editor.state.tr.insertText("safe ", 1)));
		expect(handle.current?.getDocument()?.assets).toEqual(doc.assets);
		expect(handle.current?.getText()).toContain("safe before ");
		expect(handle.current?.getDocument()?.paragraphs[0].children.map((node) => node.type)).toEqual([
			"text",
			"quote",
			"attachment",
			"fileReference",
			"text",
		]);
	});

	test("WS layout summaries load their document lazily instead of clearing inline nodes", async () => {
		await render();
		const doc = richDocument();
		const input = composerDocumentText(doc);
		const pending = deferred<Awaited<ReturnType<typeof api.getNarratorDraft>>>();
		getSpy.mockReturnValueOnce(pending.promise);
		const summary = {
			...initial,
			...input,
			hasDraft: true,
			hasComposerDocument: true,
			revision: 2,
			sourceId: "other",
		};
		await act(async () => handle.current?.handleDraftChanged(summary));
		expect(handle.current?.getText()).toBe("");
		await act(async () => pending.resolve({ ...summary, composerDocument: doc }));
		expect(handle.current?.getDocument()).toEqual(doc);
		expect(handle.current?.hasMissingAssets()).toBe(true);
	});
});

describe("composer Enter focus", () => {
	test("focuses from the page without sending; leaves controls and modified Enter alone", async () => {
		await render();
		const textarea = host.querySelector<HTMLElement>('[role="textbox"]');
		if (!textarea) throw new Error("Missing composer textbox");
		Object.defineProperty(textarea, "getClientRects", { value: () => [{}] });
		const focus = spyOn(textarea, "focus").mockImplementation(() => {});
		const press = (target: Element, extra = {}) => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Enter", ...extra });
			target.dispatchEvent(event);
			return event;
		};
		expect(press(document.body).defaultPrevented).toBe(true);
		expect(focus).toHaveBeenCalledTimes(1);
		for (const extra of [
			{ shiftKey: true },
			{ ctrlKey: true },
			{ altKey: true },
			{ metaKey: true },
			{ isComposing: true },
			{ repeat: true },
		]) {
			expect(press(document.body, extra).defaultPrevented).toBe(false);
		}
		for (const tag of ["input", "button", "select"]) {
			const control = document.createElement(tag);
			host.append(control);
			expect(press(control).defaultPrevented).toBe(false);
		}
		const modal = document.createElement("div");
		modal.setAttribute("aria-modal", "true");
		host.append(modal);
		expect(press(document.body).defaultPrevented).toBe(false);
		expect(focus).toHaveBeenCalledTimes(1);
		focus.mockRestore();
	});
});

describe("composer atomic reference contract", () => {
	test("same-tick restore and add expose detached text/reference state without rerendering the parent", async () => {
		await render();
		const before = renders;
		await act(async () => {
			handle.current?.addFileReference(reference);
			expect(handle.current?.getText()).toBe("#file:src/a.ts");
			expect(handle.current?.getFileReferences()[0]).toMatchObject(reference);
			const copy = handle.current?.getFileReferences() ?? [];
			copy[0].path = "/mutated";
			expect(handle.current?.getFileReferences()[0].path).toBe(reference.path);
		});
		await act(async () => handle.current?.appendText("more"));
		expect(renders).toBe(before);
		expect(flags).toEqual([false, true]);
		expect(handle.current?.getFileReferences()).toHaveLength(1);
	});
	test("hide for send keeps persisted draft, failure restore brings back its refs, clear syncs []", async () => {
		await render();
		const state = insertFileReference({ text: "read ", fileReferences: [] }, reference);
		await act(async () => handle.current?.restoreInput(state.text, state.fileReferences));
		expect(readNarratorInputDraft("u1", "n1").fileReferences).toEqual(state.fileReferences);
		sendingRef.current = true;
		await act(async () => handle.current?.hideTextForSend());
		expect(handle.current?.getText()).toBe("");
		expect(handle.current?.getFileReferences()).toEqual([]);
		expect(readNarratorInputDraft("u1", "n1").fileReferences).toEqual(state.fileReferences);
		sendingRef.current = false;
		await act(async () => handle.current?.restoreInput(state.text, state.fileReferences));
		expect(handle.current?.getFileReferences()).toEqual(state.fileReferences);
		await act(async () => handle.current?.clearTextAndDraft());
		expect(updateSpy.mock.calls[0]?.[3]).toEqual([]);
		expect(handle.current?.getFileReferences()).toEqual([]);
		expect(readNarratorInputDraft("u1", "n1").fileReferences).toBeUndefined();
	});
	test("quote prefix becomes an inline atom rather than editable header text and persists with the draft", async () => {
		await render();
		const prefix = "> [quote] Assistant message\n> hello\n> world\n\n";
		const body = insertFileReference({ text: "explain ", fileReferences: [] }, reference);
		const full = joinQuotedComposerInput(
			[{ label: "Assistant message", text: "hello\nworld" }],
			body,
		);
		expect(full.text).toBe(`${prefix}${body.text}`);
		await act(async () => handle.current?.restoreInput(full.text, full.fileReferences));
		const editor = getEditor();
		const children = (editor.getJSON() as JSONContent).content?.[0].content ?? [];
		expect(children.find((node) => node.type === "quote")?.attrs?.value).toMatchObject({
			label: "Assistant message",
			text: "hello\nworld",
		});
		expect(
			children
				.filter((node) => node.type === "text")
				.map((node) => node.text)
				.join(""),
		).toBe("explain  ");
		expect(
			children.find((node) => node.type === "fileReference")?.attrs?.value.reference,
		).toMatchObject(reference);
		expect(host.textContent).toContain("Assistant message");
		expect(handle.current?.getText()).toBe(`${prefix}${body.text}`);
		expect(handle.current?.getFileReferences()[0].inputRange?.[0]).toBe(
			prefix.length + "explain ".length,
		);
		expect(readNarratorInputDraft("u1", "n1").text).toBe(`${prefix}${body.text}`);
		await act(async () => handle.current?.appendText("more"));
		expect(handle.current?.getText().startsWith(prefix)).toBe(true);
		expect(handle.current?.getText()).toBe(`${prefix}${body.text}\nmore`);
		expect(editor.getJSON().content?.[0].content?.some((node) => node.type === "quote")).toBe(true);
	});
	test.each([
		["empty quote body", "> [quote] source\n>\n\nbody"],
		["noncanonical quote header", "> [quote]  source  \n> quote\n\nbody"],
		["noncanonical quote separator", "> [quote] source\n> quote"],
	])("appendText preserves a legacy %s as plain text and appends at the actual end", async (_kind, text) => {
		await render();
		await act(async () => handle.current?.restoreInput(text, []));
		expect(handle.current?.getText()).toBe(text);
		expect(
			getEditor()
				.getJSON()
				.content?.some((paragraph) => paragraph.content?.some((node) => node.type === "quote")),
		).toBe(false);
		await act(async () => handle.current?.appendText("new"));
		const expected = `${text}\nnew`;
		expect(handle.current?.getText()).toBe(expected);
		expect(handle.current?.getFileReferences()).toEqual([]);
		expect(readNarratorInputDraft("u1", "n1").text).toBe(expected);
		const document = handle.current?.getDocument();
		expect(document).toBeDefined();
		if (!document) throw new Error("Missing restored composer document");
		expect(parseComposerDocument(document)).toEqual(document);
		expect(composerDocumentText(document)).toEqual({ text: expected, fileReferences: [] });
		expect(
			document.paragraphs.every((paragraph) =>
				paragraph.children.every((node) => node.type === "text" || node.type === "break"),
			),
		).toBe(true);
	});

	test("appendText only excludes real quote atoms, not literal quote-looking text after them", async () => {
		await render();
		const literal = "> [quote] source\n>\n\nbody";
		const doc: ComposerDocument = {
			version: 1,
			assets: [],
			paragraphs: [
				{
					children: [
						{ type: "quote", id: "real-quote", label: "real", text: "actual" },
						{ type: "text", text: literal },
					],
				},
			],
		};
		const original = composerDocumentText(doc);
		await act(async () => handle.current?.restoreInput(original.text, [], doc));
		await act(async () => handle.current?.appendText("new"));
		expect(handle.current?.getText()).toBe(`${original.text}\nnew`);
		const restored = handle.current?.getDocument();
		expect(restored?.paragraphs[0].children).toEqual([
			doc.paragraphs[0].children[0],
			{ type: "text", text: `${literal}\nnew` },
		]);
		expect(readNarratorInputDraft("u1", "n1").text).toBe(`${original.text}\nnew`);
	});

	test("metadata-only input is sendable and a newer remote sets it aside", async () => {
		await render();
		await act(async () => handle.current?.restoreInput("", [reference]));
		expect(handle.current?.isTextEmpty()).toBe(false);
		expect(flags).toEqual([false, true]);
		expect(host.textContent).toContain(reference.label);
		expect(
			(getEditor().getJSON() as JSONContent).content?.[0].content?.find(
				(node) => node.type === "fileReference",
			)?.attrs?.value.reference.deviceId,
		).toBe("RemoteABC");
		const remote = {
			...initial,
			hasDraft: true,
			fileReferences: [{ ...reference, deviceId: "local" }],
			revision: 2,
			sourceId: "another-editor",
		};
		await act(async () => handle.current?.handleDraftChanged(remote));
		expect(handle.current?.getFileReferences()[0].deviceId).toBe("local");
		expect(host.textContent).toContain("stale local set aside");
		await clickButton("use stale local");
		expect(handle.current?.getFileReferences()[0].deviceId).toBe("RemoteABC");
	});
	test("synced remote clear removes text and refs while a same-source echo preserves new local refs", async () => {
		getSpy.mockResolvedValue({
			...initial,
			hasDraft: true,
			text: "same",
			fileReferences: [reference],
		});
		await render();
		await act(async () =>
			handle.current?.handleDraftChanged({ ...initial, revision: 2, sourceId: "other" }),
		);
		expect(handle.current?.isTextEmpty()).toBe(true);
		expect(handle.current?.getFileReferences()).toEqual([]);
		await act(async () => handle.current?.restoreInput("same", [reference]));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 820));
		});
		const sourceId = updateSpy.mock.calls.at(-1)?.[2];
		expect(sourceId).toBeDefined();
		await act(async () => handle.current?.setFileReferences([{ ...reference, id: "newer-local" }]));
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				hasDraft: true,
				text: "same",
				fileReferences: [reference],
				revision: 4,
				sourceId: sourceId ?? null,
			}),
		);
		expect(handle.current?.getFileReferences()[0].id).toBe("newer-local");
	});
	test("a remote clear of real content offers it back and restoring saves it again", async () => {
		getSpy.mockResolvedValue({
			...initial,
			hasDraft: true,
			text: "original",
			fileReferences: [reference],
		});
		await render();
		expect(handle.current?.getText()).toBe("original");
		// Another tab sent its message: the shared draft is cleared under our feet.
		await act(async () =>
			handle.current?.handleDraftChanged({ ...initial, revision: 2, sourceId: "other" }),
		);
		expect(handle.current?.isTextEmpty()).toBe(true);
		expect(host.textContent).toContain("replaced by remote");
		await clickButton("restore original");
		expect(handle.current?.getText()).toBe("original");
		expect(handle.current?.getFileReferences()).toEqual([reference]);
		expect(host.textContent).not.toContain("replaced by remote");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 820));
		});
		expect(updateSpy.mock.calls.at(-1)?.[1]).toBe("original");
	});
	test("a remote write that swaps content also offers the replaced version back", async () => {
		getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "original" });
		await render();
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				hasDraft: true,
				text: "edited elsewhere",
				revision: 2,
				sourceId: "other",
			}),
		);
		expect(handle.current?.getText()).toBe("edited elsewhere");
		expect(host.textContent).toContain("replaced by remote");
		await clickButton("restore original");
		expect(handle.current?.getText()).toBe("original");
	});
	test("a remote write identical to the shown draft stays silent", async () => {
		getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "original" });
		await render();
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				hasDraft: true,
				text: "original",
				revision: 2,
				sourceId: "other",
			}),
		);
		expect(handle.current?.getText()).toBe("original");
		expect(host.textContent).not.toContain("replaced by remote");
	});
	test("editing after a remote clear dismisses the undo offer", async () => {
		getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "original" });
		await render();
		await act(async () =>
			handle.current?.handleDraftChanged({ ...initial, revision: 2, sourceId: "other" }),
		);
		expect(host.textContent).toContain("replaced by remote");
		await act(async () => handle.current?.setText("fresh typing"));
		expect(host.textContent).not.toContain("replaced by remote");
	});
	test("a later remote write keeps offering the version this composer showed", async () => {
		getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "original" });
		await render();
		await act(async () =>
			handle.current?.handleDraftChanged({ ...initial, revision: 2, sourceId: "other" }),
		);
		expect(host.textContent).toContain("replaced by remote");
		await act(async () =>
			handle.current?.handleDraftChanged({
				...initial,
				hasDraft: true,
				text: "fresh content",
				revision: 3,
				sourceId: "other",
			}),
		);
		expect(handle.current?.getText()).toBe("fresh content");
		expect(host.textContent).toContain("replaced by remote");
		await clickButton("restore original");
		expect(handle.current?.getText()).toBe("original");
	});
	test("newer reconnect metadata pulls the missed body and follows it when clean", async () => {
		await render();
		expect(handle.current?.getText()).toBe("");
		getSpy.mockClear();
		getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "from elsewhere", revision: 5 });
		await act(async () =>
			handle.current?.handleDraftMeta({ hasDraft: true, revision: 5, updatedAt: "t5" }),
		);
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(handle.current?.getText()).toBe("from elsewhere");
		expect(readNarratorInputDraft("u1", "n1").syncedRevision).toBe(5);
		// Equal or older metadata is a no-op, including no body fetch.
		await act(async () =>
			handle.current?.handleDraftMeta({ hasDraft: true, revision: 5, updatedAt: "t5" }),
		);
		expect(getSpy).toHaveBeenCalledTimes(1);
	});
	test("newer reconnect metadata sets older unsynced local typing aside", async () => {
		await render();
		await act(async () => handle.current?.setText("typed while offline"));
		getSpy.mockClear();
		getSpy.mockResolvedValue({ ...initial, hasDraft: true, text: "from elsewhere", revision: 5 });
		await act(async () =>
			handle.current?.handleDraftMeta({ hasDraft: true, revision: 5, updatedAt: "t5" }),
		);
		expect(getSpy).toHaveBeenCalledTimes(1);
		expect(handle.current?.getText()).toBe("from elsewhere");
		expect(host.textContent).toContain("stale local set aside");
		await clickButton("use stale local");
		expect(handle.current?.getText()).toBe("typed while offline");
	});
});
