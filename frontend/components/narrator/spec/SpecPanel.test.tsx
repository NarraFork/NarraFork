/**
 * The Spec panel's document save path with the source editor: what reaches the server is
 * exactly the typed text, an unchanged document is never re-saved, and a newly selected file
 * never shows (or saves) the previous file's text. The API is spied, Monaco is the file editor's
 * test double, and everything else (React Query, the panel, the document editor) is real.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../../lib/api";
import type {
	SpecFileDetail,
	SpecFileMeta,
	SpecOutlineBehavior,
	SpecWriteResult,
} from "../../../lib/api/spec";
import en from "../../../locales/en/narrator.json";
import { ConfirmDialogContext } from "../../common/confirm-dialog-context";
import {
	mountedTestModels,
	type TestEditorModel,
	TestMonacoEditor,
} from "../file-editor/file-editor-test-model";
import * as monacoComponent from "../file-editor/MonacoEditor";
import { SpecPanel } from "./SpecPanel";
import { __resetSpecFileSelectors, revealSpecFile } from "./spec-file-reveal";

const NARRATOR = "narrator-1";
const i18n = i18next.createInstance();
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const restores: (() => void)[] = [];
let root: Root | undefined;
let host: HTMLDivElement;
let queryClient: QueryClient;

/** Server-side state: current content and revision per path. */
let server: Map<string, { content: string; revisionId: string }>;
let revisionCounter = 0;
/** Set for a session whose tasks live in the outline: its fence is shown read-only. */
let outlineBehavior: SpecOutlineBehavior | undefined;
/** Set for an outline session while the outline is switched off (it runs on Dynamic Spec). */
let outlineSwitchedOff = false;
/** The session's task backend, as the status bar's route reports it. */
let backend: "spec" | "outline" = "spec";
const writes: { uri: string; content: string; baseRevisionId?: string | null }[] = [];
/** Every source editor render: the document it shows and the text it was opened on. */
const sourceRenders: { documentKey: string; initialValue: string }[] = [];

function meta(path: string): SpecFileMeta {
	return {
		path,
		uri: `spec://${path}`,
		readonly: path === "behavior_fence",
		uiEditable: !(outlineBehavior && path === "behavior_fence"),
		builtin: path === "tasks.json" || path === "behavior_fence",
		revisionId: server.get(path)?.revisionId ?? null,
	};
}

function detail(uri: string): SpecFileDetail {
	const path = uri.replace("spec://", "");
	const file = server.get(path);
	if (!file) throw new Error(`No such spec file ${uri}`);
	return { ...meta(path), content: file.content, revisionId: file.revisionId };
}

async function flush() {
	for (let i = 0; i < 5; i++) await act(async () => {});
}

/** Let queries, lazy chunks and effects settle until `ready` holds. */
async function waitFor(ready: () => boolean) {
	for (let i = 0; i < 50 && !ready(); i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	if (!ready()) throw new Error(`Timed out: ${host.textContent?.slice(-200)}`);
}

function shownDocumentKey() {
	return host.querySelector("[data-monaco-test-editor]")?.getAttribute("data-document-key") ?? "";
}

async function open(path: string) {
	await act(async () => {
		revealSpecFile(NARRATOR, `spec://${path}`);
	});
	await waitFor(() => shownDocumentKey().startsWith(`spec:spec://${path}:`));
}

function sourceEditor(): TestEditorModel {
	const key = host.querySelector("[data-monaco-test-editor]")?.getAttribute("data-document-key");
	const model = key ? mountedTestModels.get(key) : undefined;
	if (!model) throw new Error(`No source editor: ${host.textContent}`);
	return model;
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "getSelection", { value: () => null });
	const overrides = {
		window,
		document: window.document,
		navigator: { ...window.navigator, platform: "Linux", userAgent: "test" },
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		MutationObserver: window.MutationObserver,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		Event: window.Event,
		KeyboardEvent: window.KeyboardEvent ?? window.Event,
		getSelection: () => null,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ getPropertyValue: () => "", whiteSpace: "pre" }),
		matchMedia: (media: string) => ({
			media,
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(overrides)) {
		originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	if (!i18n.isInitialized)
		await i18n.init({
			lng: "en",
			resources: { en: { narrator: en } },
			react: { useSuspense: false },
		});

	server = new Map([
		["tasks.json", { content: '{\n\t"tasks": []\n}\n', revisionId: "t1" }],
		[
			"design.md",
			{
				content: "调用 snake_case，R&D\n\n| a | b |\n| --- | --- |\n| x \\| y | 2 |\n",
				revisionId: "d1",
			},
		],
		["notes.json", { content: '{"key_name": ["*"]}\n', revisionId: "n1" }],
	]);
	revisionCounter = 0;
	outlineBehavior = undefined;
	outlineSwitchedOff = false;
	backend = "spec";
	writes.length = 0;
	sourceRenders.length = 0;

	const spies = [
		spyOn(api, "listSpecFiles").mockImplementation(async () => ({
			files: [...server.keys()].map(meta),
			...(outlineBehavior ? { outlineBehavior } : {}),
			...(outlineSwitchedOff ? { outlineSwitchedOff: true } : {}),
		})),
		spyOn(api, "readSpecFile").mockImplementation(async (_narrator, uri) => detail(uri)),
		spyOn(api, "readSpecTasks").mockImplementation(async () => ({
			content: server.get("tasks.json")?.content ?? "",
			revisionId: "t1",
			document: { tasks: [] },
			compiled: null as never,
		})),
		spyOn(api, "writeSpecFile").mockImplementation(async (_narrator, data) => {
			writes.push({ uri: data.uri, content: data.content, baseRevisionId: data.baseRevisionId });
			const path = data.uri.replace("spec://", "");
			const revisionId = `w${++revisionCounter}`;
			server.set(path, { content: data.content, revisionId });
			return {
				path,
				uri: data.uri,
				revisionId,
				readonly: false,
				interjected: false,
			} as SpecWriteResult;
		}),
		spyOn(api, "getNarratorCurrentTask").mockImplementation(async () => ({
			backend,
			current: null,
			awaitingConfirmation: 0,
			awaitingYourConfirmation: 0,
		})),
		spyOn(api, "getSessionTaskBoard").mockImplementation(async () => ({
			scope: { kind: "session", narratorId: NARRATOR },
			sections: [],
			canAdd: false,
			nextCursor: null,
			me: { userId: "u1", name: "u1" },
		})),
		spyOn(api, "getUserPreferences").mockResolvedValue({} as never),
		spyOn(api, "getSettings").mockResolvedValue({ agent: {} } as never),
		spyOn(api, "getNarrator").mockResolvedValue({ id: NARRATOR } as never),
		spyOn(monacoComponent, "MonacoEditor").mockImplementation((props) => {
			sourceRenders.push({ documentKey: props.documentKey, initialValue: props.initialValue });
			return TestMonacoEditor(props);
		}),
	];
	for (const spy of spies) restores.push(() => spy.mockRestore());

	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<QueryClientProvider client={queryClient}>
						<ConfirmDialogContext.Provider value={{ confirm: async () => true }}>
							<SpecPanel narratorId={NARRATOR} onClose={() => {}} />
						</ConfirmDialogContext.Provider>
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
	await waitFor(() => !!host.textContent?.includes(en.spec.noTasks));
});

afterEach(async () => {
	try {
		await act(async () => root?.unmount());
		host?.remove();
		queryClient.clear();
		// React Query notifies on a zero-delay timer; let it run before the DOM globals go away.
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		root = undefined;
		__resetSpecFileSelectors();
		for (const restore of restores.splice(0)) restore();
		for (const [key, descriptor] of originalGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originalGlobals.clear();
		mountedTestModels.clear();
	}
});

test("a markdown spec opens in source mode and Ctrl+S saves exactly the typed text", async () => {
	await open("design.md");
	const original = server.get("design.md")?.content ?? "";
	const editor = sourceEditor();
	expect(editor.props.initialValue).toBe(original);
	expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="source"]')?.checked).toBe(
		true,
	);

	// Ctrl+S on an unchanged document saves nothing.
	await act(async () => editor.props.onSave?.());
	await flush();
	expect(writes).toEqual([]);

	const typed = `${original}\n新增：改 *.test.ts 与 a_b\n`;
	// Monaco's own Ctrl+S right after the keystroke, before React has re-rendered the panel.
	await act(async () => {
		editor.edit(typed);
		editor.props.onSave?.();
	});
	await flush();
	expect(writes).toEqual([{ uri: "spec://design.md", content: typed, baseRevisionId: "d1" }]);

	// The saved revision comes back with the same text: no second save on Ctrl+S.
	await act(async () => sourceEditor().props.onSave?.());
	await flush();
	expect(writes.length).toBe(1);
	expect(sourceEditor().getValue()).toBe(typed);
});

test("a JSON spec gets only the source editor and keeps its text verbatim", async () => {
	await open("notes.json");
	expect(host.querySelector('input[type="radio"]')).toBeNull();
	const editor = sourceEditor();
	expect(editor.props.initialValue).toBe('{"key_name": ["*"]}\n');
	await act(async () => editor.edit('{"key_name": ["*"], "b_c": 1}\n'));
	await act(async () => editor.props.onSave?.());
	await flush();
	expect(writes).toEqual([
		{ uri: "spec://notes.json", content: '{"key_name": ["*"], "b_c": 1}\n', baseRevisionId: "n1" },
	]);
});

test("switching files never opens the new file on the previous file's text", async () => {
	await open("design.md");
	await open("notes.json");
	await open("design.md");
	const designText = server.get("design.md")?.content;
	const notesText = server.get("notes.json")?.content;
	const shown = new Set(
		sourceRenders.map((render) => render.documentKey.split(":").slice(0, 3).join(":")),
	);
	expect(shown).toEqual(new Set(["spec:spec://design.md", "spec:spec://notes.json"]));
	for (const render of sourceRenders) {
		const expected = render.documentKey.includes("spec://notes.json") ? notesText : designText;
		expect(render.initialValue).toBe(expected ?? "");
	}
	expect(writes).toEqual([]);
});

test("an outline session's fence tab is read-only and opens the behavior page in the outline", async () => {
	outlineBehavior = { spaceId: "space-1", pageId: "page-1" };
	server.set("behavior_fence", { content: "Plugin SOP: report back.", revisionId: "f1" });
	await act(async () => {
		await queryClient.invalidateQueries();
	});
	await act(async () => {
		revealSpecFile(NARRATOR, "spec://behavior_fence");
	});
	const notice = () => host.querySelector('[data-testid="spec-outline-fence-notice"]');
	await waitFor(() => !!notice() && !!host.textContent?.includes("Plugin SOP: report back."));
	expect(notice()?.textContent).toContain(en.spec.outlineFenceHint);
	const link = notice()?.querySelector("a");
	expect(link?.textContent).toBe(en.spec.outlineFenceOpen);
	expect(link?.getAttribute("href")).toContain("space-1");
	expect(link?.getAttribute("href")).toContain("page-1");
	// Shown, not edited: no editor, no fence settings, nothing saved.
	expect(host.querySelector("[data-monaco-test-editor]")).toBeNull();
	expect(host.textContent).not.toContain(en.spec.behaviorFenceEditHint);
	expect(writes).toEqual([]);
});

test("a spec session's fence tab stays editable, without the outline note", async () => {
	server.set("behavior_fence", { content: "Never force-push.", revisionId: "f1" });
	await act(async () => {
		await queryClient.invalidateQueries();
	});
	await open("behavior_fence");
	expect(host.querySelector('[data-testid="spec-outline-fence-notice"]')).toBeNull();
	expect(host.querySelector('[data-testid="spec-outline-switched-off-notice"]')).toBeNull();
	expect(host.textContent).toContain(en.spec.behaviorFenceEditHint);
});

test("with the outline switched off, an outline session's fence tab is editable and says where its rules are", async () => {
	outlineSwitchedOff = true;
	server.set("behavior_fence", { content: "Plugin SOP: report back.", revisionId: "f1" });
	await act(async () => {
		await queryClient.invalidateQueries();
	});
	await open("behavior_fence");
	const notice = () => host.querySelector('[data-testid="spec-outline-switched-off-notice"]');
	await waitFor(() => !!notice());
	expect(notice()?.textContent).toBe(en.spec.outlineFenceSwitchedOff);
	// Editable as in any spec session; the read-only outline note is not shown.
	expect(host.textContent).toContain(en.spec.behaviorFenceEditHint);
	expect(host.querySelector('[data-testid="spec-outline-fence-notice"]')).toBeNull();
	// Only on the fence tab.
	await open("design.md");
	expect(notice()).toBeNull();
});

test("an outline session's old Spec files are read only: previews, no task editor, nothing saved", async () => {
	backend = "outline";
	server.set("tasks.json", {
		content: '{"tasks":[{"text":"Old spec task","status":"todo"}]}\n',
		revisionId: "t2",
	});
	spyOn(api, "readSpecTasks").mockImplementation(async () => ({
		content: server.get("tasks.json")?.content ?? "",
		revisionId: "t2",
		document: { tasks: [{ text: "Old spec task", status: "todo" }] },
		compiled: null as never,
	}));
	await act(async () => {
		await queryClient.invalidateQueries();
	});
	const legacy = () => host.querySelector('[data-testid="outline-tasks-legacy"]');
	await waitFor(() => !!legacy());
	await act(async () => (legacy() as unknown as { click: () => void }).click());
	const tasks = () => host.querySelector('[data-testid="spec-tasks-readonly"]');
	await waitFor(() => !!tasks() && !!tasks()?.textContent?.includes("Old spec task"));
	expect(host.querySelector('[data-testid="outline-tasks-back"]')).not.toBeNull();
	// No task editor (its empty state, its add and save controls).
	expect(host.textContent).not.toContain(en.spec.noTasks);
	await act(async () => {
		revealSpecFile(NARRATOR, "spec://design.md");
	});
	await waitFor(() => !!host.textContent?.includes("snake_case"));
	expect(host.querySelector("[data-monaco-test-editor]")).toBeNull();
	expect(writes).toEqual([]);
});
