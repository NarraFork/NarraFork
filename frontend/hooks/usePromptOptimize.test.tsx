/**
 * Prompt optimization, as seen by the composer.
 *
 * The request itself lives in `prompt-optimize-tasks` so it survives the composer
 * unmounting — switching narrator is the common case and used to throw the work
 * away. These tests pin the composer side of that contract: it triggers the task,
 * renders its running state, and claims a finished result into ITS OWN surface,
 * never anybody else's.
 *
 * The registry has its own tests for the transport and delivery-ownership rules.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ComposerDocument } from "@shared/composer-document";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { composerOptimizeTarget } from "../components/narrator/composer/composer-optimize-target";
import type { InlineComposerEditorHandle } from "../components/narrator/composer/InlineComposerEditor";
import {
	getPromptOptimizeTask,
	isNarratorOptimizingPrompt,
	resetPromptOptimizeTasksForTest,
	startPromptOptimizeTask,
} from "../lib/prompt-optimize-tasks";

mock.module("./useInstanceSettings", () => ({
	useInstanceSettings: () => ({ promptOptimizeContextMaxMessages: 10 }),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { usePromptOptimize } = await import("./usePromptOptimize");
const { narratorsApi } = await import("../lib/api/narrators");
const { notifications } = await import("@mantine/notifications");

let root: Root;
let result: ReturnType<typeof usePromptOptimize>;
let applied: string[];
let requests: {
	text: string;
	signal: AbortSignal;
	resolve: (value: { text: string; reasoningSummary?: string }) => void;
	reject: (error: Error) => void;
}[];
const originals = new Map<string, PropertyDescriptor | undefined>();
let restore: (() => void)[];
/** Narrator the probe renders; changing it simulates switching narrator. */
let renderNarratorId = "n";

function Probe() {
	result = usePromptOptimize({
		narratorId: renderNarratorId,
		textareaRef: {
			current: {
				value: "original",
				ownerDocument: document,
				focus() {},
				setSelectionRange() {},
			} as unknown as HTMLTextAreaElement,
		},
		onOptimized: (text) => applied.push(text),
	});
	return null;
}

beforeEach(async () => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Object.assign(document, { execCommand: () => false });
	applied = [];
	requests = [];
	renderNarratorId = "n";
	resetPromptOptimizeTasksForTest();
	const api = spyOn(narratorsApi, "optimizePrompt").mockImplementation(
		(_id, _text, _style, options) =>
			new Promise((resolve, reject) =>
				requests.push({
					text: _text,
					signal: options?.signal as AbortSignal,
					resolve: (value) => resolve({ ...value, model: "test" }),
					reject,
				}),
			),
	);
	const notify = spyOn(notifications, "show").mockImplementation(() => "id");
	restore = [() => api.mockRestore(), () => notify.mockRestore()];
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const fn of restore) fn();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
	resetPromptOptimizeTasksForTest();
});

/** `handleOptimize` only starts the task, so the transport must be drained separately. */
async function flush() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

test("cancel immediately clears loading and ignores a late successful response", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	expect(result.loading).toBe(true);
	await act(async () => result.cancelOptimize());
	expect(requests[0].signal.aborted).toBe(true);
	expect(result.loading).toBe(false);
	await act(async () => requests[0].resolve({ text: "late" }));
	await flush();
	expect(applied).toEqual([]);
	expect(notifications.show).not.toHaveBeenCalled();
});

test("a superseded request cannot deliver after a newer one starts", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => {
		await result.handleOptimize("concise");
	});
	await act(async () => requests[0].reject(new Error("late failure")));
	await flush();
	expect(result.loading).toBe(true);
	await act(async () => requests[1].resolve({ text: "new" }));
	await flush();
	expect(applied).toEqual(["new"]);
	expect(result.loading).toBe(false);
});

/**
 * The behaviour this whole change exists for: unmounting the composer (which is
 * what switching narrator does) must NOT kill the request.
 */
test("unmounting does not abort the request", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => root.unmount());
	expect(requests[0].signal.aborted).toBe(false);
	// Nothing is written while no surface exists…
	await act(async () => requests[0].resolve({ text: "late" }));
	await flush();
	expect(applied).toEqual([]);
});

test("a result that arrives while unmounted is delivered after remount", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => root.unmount());
	await act(async () => requests[0].resolve({ text: "写一个登录页面。" }));
	await flush();
	expect(applied).toEqual([]);

	// Coming back to the same narrator claims the pending result.
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
	await flush();
	expect(applied).toEqual(["写一个登录页面。"]);
});

test("writes the returned text verbatim and notifies success", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => requests[0].resolve({ text: "写一个登录页面。" }));
	await flush();
	expect(applied).toEqual(["写一个登录页面。"]);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeSuccess", color: "green" }),
	);
	expect(result.loading).toBe(false);
});

test("preserves multi-segment markers in the returned text", async () => {
	const optimized =
		"<<<NF_seg_0>>>\n写一个登录页面\n<<<NF_seg_0_END>>>\n<<<NF_seg_1>>>\n补充校验\n<<<NF_seg_1_END>>>";
	await act(async () => {
		await result.handleOptimize("structured");
	});
	await act(async () => requests[0].resolve({ text: optimized }));
	await flush();
	// Markers are the client's rebuild keys: the hook must not trim or reflow them.
	expect(applied).toEqual([optimized]);
});

test("surfaces a server-side failure instead of writing anything", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => requests[0].reject(new Error("context too long: no context available")));
	await flush();
	expect(applied).toEqual([]);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeNoContext", color: "red" }),
	);
	expect(result.loading).toBe(false);
});

/**
 * The rationale popup.
 *
 * The summary is presentation only — it must never be written into the composer,
 * and an absent or blank one must not raise a popup at all.
 */
function summaryCalls() {
	return (notifications.show as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
		(call) => (call[0] as { title?: string }).title === "optimizeSummaryTitle",
	);
}

test("shows the rationale once when the server returns a summary", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () =>
		requests[0].resolve({
			text: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验要求。",
		}),
	);
	await flush();
	const calls = summaryCalls();
	expect(calls).toHaveLength(1);
	expect(calls[0][0]).toEqual(
		expect.objectContaining({
			title: "optimizeSummaryTitle",
			message: "补充了字段与校验要求。",
			// Manually dismissable, and it goes away on its own.
			withCloseButton: true,
			autoClose: expect.any(Number),
		}),
	);
	// The summary is shown beside the result, never written into the prompt.
	expect(applied).toEqual(["写一个登录页面。"]);
});

test("does not show a popup when the summary is missing", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => requests[0].resolve({ text: "写一个登录页面。" }));
	await flush();
	expect(summaryCalls()).toHaveLength(0);
	// The success notification still fires.
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeSuccess" }),
	);
});

test("does not show a popup when the summary is blank", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => requests[0].resolve({ text: "写一个登录页面。", reasoningSummary: "   " }));
	await flush();
	expect(summaryCalls()).toHaveLength(0);
});

test("does not repeat the popup for the same summary within one optimization", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () =>
		requests[0].resolve({ text: "写一个登录页面。", reasoningSummary: "补充校验。" }),
	);
	await flush();
	expect(summaryCalls()).toHaveLength(1);
});

test("a cancelled optimization never shows the rationale", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	await act(async () => result.cancelOptimize());
	await act(async () =>
		requests[0].resolve({ text: "late", reasoningSummary: "should not appear" }),
	);
	await flush();
	expect(summaryCalls()).toHaveLength(0);
	expect(applied).toEqual([]);
});

/**
 * Narrator attribution.
 *
 * A result belongs to the narrator that asked for it. Switching away must neither
 * cancel that request nor let its text surface in the narrator now on screen.
 */
test("switching narrator keeps the original request running", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	// Same route, different narrator: the composer re-renders against a new id.
	renderNarratorId = "other";
	await act(async () => root.render(<Probe />));

	// The other narrator sees no loading state of its own…
	expect(result.loading).toBe(false);
	// …and the first request was not cancelled.
	expect(requests[0].signal.aborted).toBe(false);

	// Its result must not be written into the narrator now on screen.
	await act(async () => requests[0].resolve({ text: "属于第一个叙述者。" }));
	await flush();
	expect(applied).toEqual([]);
});

/**
 * Coming back to a narrator whose optimization is still running must show that
 * narrator as busy again — the composer is a fresh mount and must read the
 * running task out of the registry rather than starting from `loading: false`.
 */
test("switching back to a still-running narrator restores its loading state", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	expect(result.loading).toBe(true);

	// Away to another narrator…
	renderNarratorId = "other";
	await act(async () => root.render(<Probe />));
	expect(result.loading).toBe(false);

	// …and back to the one whose request is still in flight.
	renderNarratorId = "n";
	await act(async () => root.render(<Probe />));
	expect(result.loading).toBe(true);
});

test("a narrator with no running task still reports idle after switching", async () => {
	renderNarratorId = "other";
	await act(async () => root.render(<Probe />));
	expect(result.loading).toBe(false);
});

/**
 * The real switch path: the composer is torn down and rebuilt for the narrator
 * being shown, so the running state has to be re-read from the registry on mount
 * rather than living in component state that starts at `loading: false`.
 */
test("remounting the composer of a running narrator restores loading", async () => {
	await act(async () => {
		await result.handleOptimize("clarify");
	});
	expect(result.loading).toBe(true);

	// Leave the narrator entirely.
	await act(async () => root.unmount());
	expect(requests[0].signal.aborted).toBe(false);

	// Come back to it: a brand-new mount reads the still-running task.
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
	expect(result.loading).toBe(true);
});

/**
 * The acceptance path, with the request started by a DIFFERENT instance of the
 * composer (which is what a narrator switch produces — the mount that started the
 * work is gone, so the new mount holds no task of its own).
 */
test("a fresh composer adopts a running optimization started by another instance", async () => {
	// Somebody else (the previous mount) started the narrator's optimization.
	await act(async () => {
		startPromptOptimizeTask({
			narratorId: "n",
			text: "original",
			style: "clarify",
			withContext: false,
			request: () => new Promise(() => {}),
		});
	});
	expect(isNarratorOptimizingPrompt("n")).toBe(true);

	// A new mount for the same narrator must report the in-flight work, not idle.
	await act(async () => root.render(<Probe />));
	expect(result.loading).toBe(true);
});

test("adopting does not leak across narrators", async () => {
	startPromptOptimizeTask({
		narratorId: "other",
		text: "x",
		style: "clarify",
		withContext: false,
		request: () => new Promise(() => {}),
	});
	// Narrator "n" has nothing running, so its toolbar stays idle even though a
	// different narrator is busy.
	await act(async () => root.render(<Probe />));
	expect(result.loading).toBe(false);
});

test("an inline message edit does not make the composer toolbar look busy", async () => {
	// Message editors are a different draft; the composer must not claim their work
	// (nor offer to cancel it from the wrong surface).
	startPromptOptimizeTask({
		narratorId: "n",
		messageId: "m1",
		text: "x",
		style: "clarify",
		withContext: false,
		request: () => new Promise(() => {}),
	});
	await act(async () => root.render(<Probe />));
	expect(result.loading).toBe(false);
	// The narrator is still shown as busy in the sidebar — that indicator counts any
	// optimization for the narrator.
	expect(isNarratorOptimizingPrompt("n")).toBe(true);
});

function richEditor(...paragraphs: string[]) {
	let document: ComposerDocument = {
		version: 1,
		paragraphs: paragraphs.map((text) => ({ children: [{ type: "text", text }] })),
		assets: [],
	};
	let selection = { start: 0, end: 0 };
	return {
		handle: {
			getElement: () => globalThis.document.createElement("div"),
			getDocument: () => document,
			getSelection: () => selection,
			setDocument: (next: ComposerDocument) => {
				document = next;
			},
		} as InlineComposerEditorHandle,
		getDocument: () => document,
		select: (start: number, end: number) => {
			selection = { start, end };
		},
	};
}

function RichProbe({
	editor,
	ready = true,
}: {
	editor: InlineComposerEditorHandle;
	ready?: boolean;
}) {
	result = usePromptOptimize({
		narratorId: renderNarratorId,
		ready,
		textareaRef: { current: null },
		target: (snapshot) => composerOptimizeTarget(editor, snapshot),
	});
	return null;
}

test("rich multi-paragraph results use the original segment markers", async () => {
	const editor = richEditor("alpha", "beta");
	await act(async () => root.render(<RichProbe editor={editor.handle} />));
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	const response = requests[0].text.replace("alpha", "ALPHA").replace("beta", "BETA");
	await act(async () => requests[0].resolve({ text: response }));
	expect(editor.getDocument().paragraphs).toEqual([
		{ children: [{ type: "text", text: "ALPHA" }] },
		{ children: [{ type: "text", text: "BETA" }] },
	]);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeSuccess" }),
	);
});

test("a rich result never overwrites typing made while the request was running", async () => {
	const editor = richEditor("original");
	await act(async () => root.render(<RichProbe editor={editor.handle} />));
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	const changed = richEditor("new draft").getDocument();
	editor.handle.setDocument(changed);
	await act(async () => requests[0].resolve({ text: "stale optimized text" }));
	expect(editor.getDocument()).toEqual(changed);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "richComposer.optimizeChanged", color: "red" }),
	);
});

test("moving the selection does not change the range an optimization replaces", async () => {
	const editor = richEditor("hello world");
	editor.select(6, 11);
	await act(async () => root.render(<RichProbe editor={editor.handle} />));
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	expect(requests[0].text).toBe("world");
	editor.select(0, 5);
	await act(async () => requests[0].resolve({ text: "earth" }));
	expect(editor.getDocument().paragraphs[0].children).toEqual([
		{ type: "text", text: "hello earth" },
	]);
});

test("a rich result rebinds to the remounted editor after draft hydration", async () => {
	const previous = richEditor("alpha", "beta");
	await act(async () => root.render(<RichProbe editor={previous.handle} />));
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	await act(async () => root.unmount());
	const response = requests[0].text.replace("alpha", "ALPHA").replace("beta", "BETA");
	await act(async () => requests[0].resolve({ text: response }));

	const current = richEditor("");
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<RichProbe editor={current.handle} ready={false} />));
	expect(getPromptOptimizeTask("n")?.pendingDelivery).toBe(true);
	current.handle.setDocument(previous.getDocument());
	await act(async () => root.render(<RichProbe editor={current.handle} />));
	expect(current.getDocument().paragraphs).toEqual([
		{ children: [{ type: "text", text: "ALPHA" }] },
		{ children: [{ type: "text", text: "BETA" }] },
	]);
	expect(previous.getDocument().paragraphs[0].children).toEqual([{ type: "text", text: "alpha" }]);
	expect(getPromptOptimizeTask("n")).toBeUndefined();
});

test("an unavailable sibling surface cannot steal or discard the visible surface's result", async () => {
	function Unavailable() {
		usePromptOptimize({ narratorId: "n", textareaRef: { current: null } });
		return null;
	}
	await act(async () =>
		root.render(
			<>
				<Unavailable />
				<Probe />
			</>,
		),
	);
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	await act(async () => requests[0].resolve({ text: "optimized" }));
	expect(applied).toEqual(["optimized"]);
	expect(getPromptOptimizeTask("n")).toBeUndefined();
});

test("two ready surfaces apply a shared result only once", async () => {
	await act(async () =>
		root.render(
			<>
				<Probe />
				<Probe />
			</>,
		),
	);
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	await act(async () => requests[0].resolve({ text: "optimized", reasoningSummary: "rationale" }));
	expect(applied).toEqual(["optimized"]);
	expect(notifications.show).toHaveBeenCalledTimes(2);
});

test("closed surfaces do not consume results even if a textarea is still mounted", async () => {
	function Closed() {
		usePromptOptimize({
			narratorId: "n",
			ready: false,
			textareaRef: {
				current: {
					value: "different hidden draft",
					ownerDocument: document,
				} as HTMLTextAreaElement,
			},
		});
		return null;
	}
	await act(async () =>
		root.render(
			<>
				<Closed />
				<Probe />
			</>,
		),
	);
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	await act(async () => requests[0].resolve({ text: "optimized" }));
	expect(applied).toEqual(["optimized"]);
	expect(notifications.show).toHaveBeenCalledWith(
		expect.objectContaining({ message: "optimizeSuccess", color: "green" }),
	);
});

test("delivery retries retain an unready result until the surface mounts", async () => {
	const retries: Array<() => void> = [];
	const setTimeout = globalThis.setTimeout;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
		...args: Parameters<typeof setTimeout>
	) => {
		const [callback, delay] = args;
		if (delay === 250) {
			retries.push(callback as () => void);
			return 0;
		}
		return setTimeout(...args);
	}) as typeof setTimeout);
	restore.push(() => timer.mockRestore());
	function Unavailable() {
		usePromptOptimize({ narratorId: "n", textareaRef: { current: null } });
		return null;
	}
	await act(async () => result.handleOptimize("clarify"));
	await flush();
	await act(async () => root.render(<Unavailable />));
	await act(async () => requests[0].resolve({ text: "optimized" }));
	await act(async () => {
		for (let i = 0; i < 20; i++) retries.shift()?.();
	});
	expect(getPromptOptimizeTask("n")?.pendingDelivery).toBe(true);
	await act(async () => root.render(<Probe />));
	expect(applied).toEqual(["optimized"]);
});
