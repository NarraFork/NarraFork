/**
 * FileContextMenu.test.tsx — what the file row's menu offers, and what each entry does.
 *
 * Three properties are worth pinning here, and none of them is visible from the code alone:
 *
 *  - **availability** — "reference in the composer" must vanish when no composer is in
 *    scope, and "paste" must be disabled unless the tree's own clipboard holds an entry
 *    from THIS narrator. A menu that offers an action which can only fail is worse than a
 *    menu that omits it.
 *  - **the paste target** — the destination is the directory of the file the gesture
 *    pointed at, which is the whole meaning of "paste into this file's folder". A paste
 *    that silently used the tree root instead would still succeed, somewhere else.
 *  - **cut is consumed, copy is not** — a cut that stays in the clipboard pastes twice.
 *
 * The API, the notification system, the confirm dialog and the platform/preference hooks
 * are all replaced: this is a test about the menu's wiring, not about the server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

type Notification = { color?: string; title?: string; message?: unknown };
const shown: Notification[] = [];
let confirmAnswer = true;
const confirmCalls: unknown[] = [];
const deleteCalls: unknown[] = [];
const transferCalls: unknown[] = [];
const revealCalls: unknown[] = [];
const renameCalls: unknown[] = [];
const systemClipboardCalls: unknown[] = [];
/** Set to make the next transfer answer a conflict, the way a taken name does. */
let transferConflicts = false;
/** Throw a bare `{status, data}` object instead of an `ApiError` instance. */
let transferConflictPlainShape = false;
/** The code every conflict carries: the destination name is taken. */
const CONFLICT_CODE = "ALREADY_EXISTS";

const keys = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Event",
] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	Element: window.Element,
	Node: window.Node,
	Event: window.Event,
	getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	// Mantine's portal/transition plumbing needs the animation frame pair; linkedom has none.
	requestAnimationFrame: (callback: (time: number) => void) =>
		setTimeout(() => callback(performance.now()), 0) as unknown as number,
	cancelAnimationFrame: (handle: number) => clearTimeout(handle),
	IS_REACT_ACT_ENVIRONMENT: true,
});

// A `t` that returns its key keeps every assertion independent of the copy.
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@mantine/notifications", () => ({
	notifications: { show: (notification: Notification) => shown.push(notification) },
}));
// `treatAsLocalAccess` is the browse-from-this-machine preference; without it the reveal and
// clipboard entries are correctly hidden.
mock.module("@frontend/hooks/useUserPreferences", () => ({
	useUserPreferences: () => ({ data: { treatAsLocalAccess: true } }),
}));
mock.module("@frontend/hooks/usePlatform", () => ({ usePlatform: () => "linux" }));
mock.module("@frontend/components/common/confirm-dialog-context", () => ({
	useConfirmDialog: () => async (options: unknown) => {
		confirmCalls.push(options);
		return confirmAnswer;
	},
}));

const { api, ApiError } = await import("@frontend/lib/api");
const { clearFileClipboard, getFileClipboard, setFileClipboard } = await import("./file-clipboard");
const { FileContextMenu } = await import("./FileContextMenu");
const { MantineProvider } = await import("@mantine/core");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

const target = {
	absolutePath: "/repo/src/deep/a.ts",
	relativePath: "src/deep/a.ts",
	name: "a.ts",
};

let root: Root;
let container: HTMLElement;
let closed = 0;
let referenced = 0;
let changed: string[] = [];
let renamed: unknown[] = [];

beforeAll(() => {
	// `spyOn` on the real api object keeps the rest of its surface intact.
	const spy = (name: keyof typeof api, record: unknown[], result: unknown) => {
		// biome-ignore lint/suspicious/noExplicitAny: test double over a large api object
		(api as any)[name] = async (input: unknown) => {
			record.push(input);
			return result;
		};
	};
	spy("fsDeleteFile", deleteCalls, { ok: true });
	spy("fsReveal", revealCalls, { ok: true });
	spy("fsRename", renameCalls, { ok: true, path: "/repo/src/deep/b.ts" });
	spy("fsCopyFileToClipboard", systemClipboardCalls, { ok: true });
	// biome-ignore lint/suspicious/noExplicitAny: test double over a large api object
	(api as any).fsTransferFile = async (input: unknown) => {
		transferCalls.push(input);
		// The server answers 409 while a destination exists and `overwrite` is not set.
		if (transferConflicts && !(input as { overwrite?: boolean }).overwrite) {
			// A plain object stands in for the second copy of `ApiError` a bundle can create;
			// the menu must not depend on the class identity to recognise a conflict.
			if (transferConflictPlainShape) {
				throw { status: 409, data: { code: CONFLICT_CODE }, message: "Already exists" };
			}
			throw new ApiError("Already exists: a.ts", 409, { code: CONFLICT_CODE });
		}
		return { ok: true, path: "/repo/src/deep/a.ts" };
	};
});

beforeEach(() => {
	shown.length = 0;
	confirmCalls.length = 0;
	deleteCalls.length = 0;
	transferCalls.length = 0;
	revealCalls.length = 0;
	systemClipboardCalls.length = 0;
	transferConflicts = false;
	transferConflictPlainShape = false;
	clearFileClipboard();
	confirmAnswer = true;
	closed = 0;
	referenced = 0;
	changed = [];
	renamed = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
	}
});

function render(props: { onReference?: (() => void) | null } = {}): void {
	act(() => {
		root.render(
			createElement(
				MantineProvider,
				null,
				createElement(FileContextMenu, {
					x: 20,
					y: 20,
					target,
					narratorId: "narrator-a",
					onReference: props.onReference ?? null,
					onRename: (next: unknown) => renamed.push(next),
					onChanged: (dir: string) => changed.push(dir),
					onClose: () => {
						closed += 1;
					},
				}),
			),
		);
	});
}

/**
 * The menu is a Mantine `Menu` with `withinPortal`, so its items live in `document.body`
 * rather than in the container the component was rendered into — which is also why the
 * dropdown cannot be clipped by a scrolled dock panel.
 */
function item(key: string): HTMLElement | null {
	return document.body.querySelector(`[data-context-menu-item="${key}"]`);
}

function itemKeys(): string[] {
	return [...document.body.querySelectorAll("[data-context-menu-item]")].map(
		(node) => (node as HTMLElement).dataset.contextMenuItem ?? "",
	);
}

test("offers the file actions without a redundant open entry", () => {
	render();
	// No "open" (the row's own click opens the file) and no separate system-clipboard entry:
	// that capability lives inside "copy" now.
	expect(itemKeys()).toEqual(["copy", "cut", "paste", "rename", "delete", "reveal"]);
	expect(item("reference")).toBeNull();
});

test("offers reference in the composer when one is in scope", () => {
	render({ onReference: () => (referenced += 1) });
	expect(item("reference")).not.toBeNull();
	act(() => item("reference")?.click());
	expect(referenced).toBe(1);
	expect(closed).toBe(1);
});

test("copy fills the tree clipboard and the system clipboard in one action", async () => {
	render();
	await act(async () => item("copy")?.click());

	expect(getFileClipboard()).toEqual({
		mode: "copy",
		path: target.absolutePath,
		name: "a.ts",
		narratorId: "narrator-a",
		sourceDirectory: "src/deep",
	});
	expect(systemClipboardCalls).toEqual([target.absolutePath]);
	expect(shown.at(-1)?.message).toBe("fileTree.copyToClipboardDone");
});

test("cut stays inside the tree: no system clipboard, no file-manager paste", async () => {
	render();
	await act(async () => item("cut")?.click());
	expect(getFileClipboard()?.mode).toBe("move");
	expect(systemClipboardCalls).toEqual([]);
});

test("paste is disabled until the clipboard holds a file from this narrator", () => {
	render();
	const paste = () => item("paste") as HTMLButtonElement | null;
	expect(paste()?.hasAttribute("disabled")).toBe(true);

	// Another narrator's entry cannot be pasted: the server bounds the target by the
	// narrator whose tree is pasting, so this could only be refused.
	act(() => {
		setFileClipboard({
			mode: "copy",
			path: "/other/x.ts",
			name: "x.ts",
			narratorId: "narrator-b",
		});
	});
	expect(paste()?.hasAttribute("disabled")).toBe(true);

	act(() => {
		setFileClipboard({ mode: "copy", path: "/repo/y.ts", name: "y.ts", narratorId: "narrator-a" });
	});
	expect(paste()?.hasAttribute("disabled")).toBe(false);
});

test("paste targets the directory of the file the gesture pointed at", async () => {
	act(() => {
		setFileClipboard({ mode: "copy", path: "/repo/y.ts", name: "y.ts", narratorId: "narrator-a" });
	});
	render();
	await act(async () => item("paste")?.click());

	expect(transferCalls).toEqual([
		{
			narratorId: "narrator-a",
			path: "/repo/y.ts",
			targetDir: "/repo/src/deep",
			mode: "copy",
		},
	]);
	// A copy stays in the clipboard so the same file can be pasted again.
	expect(getFileClipboard()).not.toBeNull();
	expect(changed).toEqual(["src/deep"]);
	expect(shown.at(-1)?.message).toBe("fileTree.pasteDone");
});

test("copy and cut fill the clipboard, and a cut is consumed by its paste", async () => {
	render();
	await act(async () => item("cut")?.click());
	expect(getFileClipboard()).toEqual({
		mode: "move",
		path: target.absolutePath,
		name: "a.ts",
		narratorId: "narrator-a",
		sourceDirectory: "src/deep",
	});
	expect(closed).toBe(1);

	// Paste the cut into the same directory: the entry is gone afterwards.
	render();
	await act(async () => item("paste")?.click());
	expect(transferCalls).toEqual([
		{
			narratorId: "narrator-a",
			path: target.absolutePath,
			targetDir: "/repo/src/deep",
			mode: "move",
		},
	]);
	expect(getFileClipboard()).toBeNull();
});

test("a taken destination asks before replacing, then retries with overwrite", async () => {
	transferConflicts = true;
	act(() => {
		setFileClipboard({ mode: "copy", path: "/repo/y.ts", name: "y.ts", narratorId: "narrator-a" });
	});
	render();
	await act(async () => item("paste")?.click());

	// The conflict is a question, not a failure report: the user is shown which name is
	// taken and gets to say yes or no.
	expect(confirmCalls).toHaveLength(1);
	expect(transferCalls).toEqual([
		{ narratorId: "narrator-a", path: "/repo/y.ts", targetDir: "/repo/src/deep", mode: "copy" },
		{
			narratorId: "narrator-a",
			path: "/repo/y.ts",
			targetDir: "/repo/src/deep",
			mode: "copy",
			overwrite: true,
		},
	]);
	expect(changed).toEqual(["src/deep"]);
	expect(shown.some((notification) => notification.title === "fileTree.pasteFailed")).toBe(false);
});

test("declining the overwrite leaves the existing file alone", async () => {
	transferConflicts = true;
	confirmAnswer = false;
	act(() => {
		setFileClipboard({ mode: "copy", path: "/repo/y.ts", name: "y.ts", narratorId: "narrator-a" });
	});
	render();
	await act(async () => item("paste")?.click());

	expect(confirmCalls).toHaveLength(1);
	// Only the first, non-overwriting attempt was made.
	expect(transferCalls).toHaveLength(1);
	expect(changed).toEqual([]);
});

test("a conflict is recognised even when the error is not an ApiError instance", async () => {
	// The regression this pins: `instanceof ApiError` answered false for a real 409 once a
	// bundle held two copies of the class, so the overwrite question never appeared and the
	// only thing the user saw was "Already exists".
	transferConflicts = true;
	transferConflictPlainShape = true;
	act(() => {
		setFileClipboard({ mode: "copy", path: "/repo/y.ts", name: "y.ts", narratorId: "narrator-a" });
	});
	render();
	await act(async () => item("paste")?.click());

	expect(confirmCalls).toHaveLength(1);
	expect(transferCalls).toEqual([
		{ narratorId: "narrator-a", path: "/repo/y.ts", targetDir: "/repo/src/deep", mode: "copy" },
		{
			narratorId: "narrator-a",
			path: "/repo/y.ts",
			targetDir: "/repo/src/deep",
			mode: "copy",
			overwrite: true,
		},
	]);
	expect(changed).toEqual(["src/deep"]);
});

test("pasting a file onto itself still asks, then replaces without touching the bytes", async () => {
	// The destination name is the source's own, so pasting onto the same row is exactly a
	// taken destination: one confirm dialog, one overwrite retry, no "nothing to paste".
	transferConflicts = true;
	act(() => {
		setFileClipboard({
			mode: "copy",
			path: target.absolutePath,
			name: target.name,
			narratorId: "narrator-a",
		});
	});
	render();
	await act(async () => item("paste")?.click());

	expect(confirmCalls).toHaveLength(1);
	expect(transferCalls).toEqual([
		{
			narratorId: "narrator-a",
			path: target.absolutePath,
			targetDir: "/repo/src/deep",
			mode: "copy",
		},
		{
			narratorId: "narrator-a",
			path: target.absolutePath,
			targetDir: "/repo/src/deep",
			mode: "copy",
			overwrite: true,
		},
	]);
	expect(changed).toEqual(["src/deep"]);
	expect(shown.some((notification) => notification.title === "fileTree.pasteFailed")).toBe(false);
});

test("a move re-reads the folder it came from as well as the one it landed in", async () => {
	act(() => {
		setFileClipboard({
			mode: "move",
			path: "/repo/docs/y.ts",
			name: "y.ts",
			narratorId: "narrator-a",
			sourceDirectory: "docs",
		});
	});
	render();
	await act(async () => item("paste")?.click());

	expect(transferCalls).toHaveLength(1);
	expect(changed).toEqual(["src/deep", "docs"]);
});

test("delete asks first, then removes the file", async () => {
	render();
	await act(async () => item("delete")?.click());
	expect(confirmCalls).toHaveLength(1);
	expect(deleteCalls).toEqual([{ narratorId: "narrator-a", path: target.absolutePath }]);
	expect(changed).toEqual(["src/deep"]);
});

test("a declined confirmation deletes nothing", async () => {
	confirmAnswer = false;
	render();
	await act(async () => item("delete")?.click());
	expect(confirmCalls).toHaveLength(1);
	expect(deleteCalls).toEqual([]);
	expect(changed).toEqual([]);
});

test("rename hands the row to the tree instead of acting itself", () => {
	render();
	act(() => item("rename")?.click());
	expect(renamed).toEqual([target]);
	expect(closed).toBe(1);
});

test("reveal acts on the file's own path", () => {
	render();
	act(() => item("reveal")?.click());
	expect(revealCalls).toEqual([target.absolutePath]);
});

test("the menu is Mantine's own, so items get its hover and keyboard behaviour", () => {
	render();
	// The whole point of reusing the conversation's mechanism: these class names are
	// Mantine's `Menu`, which already owns the hover background, icon gutter, divider
	// spacing, roving focus and Escape handling. A hand-rolled row of buttons had none.
	const dropdown = document.body.querySelector(".mantine-Menu-dropdown");
	expect(dropdown).not.toBeNull();
	expect(dropdown?.getAttribute("aria-label")).toBe("fileTree.menuLabel");
	const first = item("copy");
	expect(first?.className).toContain("mantine-Menu-item");
	// Dividers are `Menu.Divider` too, not bare <hr>s.
	expect(document.body.querySelector(".mantine-Menu-divider")).not.toBeNull();
});

test("a disabled entry is rendered but not selectable", () => {
	render();
	// Paste has no clipboard to work from in this render. Mantine marks the item itself as
	// unavailable, so the browser's own disabled semantics apply.
	const paste = item("paste") as HTMLButtonElement;
	expect(paste.hasAttribute("disabled") || paste.dataset.disabled === "true").toBe(true);
	act(() => paste.click());
	expect(transferCalls).toEqual([]);
});

test("closing is Mantine's: the dropdown reports dismissal through onChange", () => {
	render();
	// Mantine calls `onChange(false)` for outside clicks, Escape and item selection; the
	// component's only job is to forward that to the caller. `onClose` is asserted here by
	// driving the same prop the framework would.
	const menu = document.body.querySelector('[role="menu"]');
	expect(menu).not.toBeNull();
	act(() => item("reveal")?.click());
	expect(closed).toBe(1);
});
