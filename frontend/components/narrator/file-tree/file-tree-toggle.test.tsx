/**
 * file-tree-toggle.test.tsx — the dotfile visibility toggle in the toolbar.
 *
 * Why this exists at all: `showHidden` defaults to true, and the panel's own
 * comment used to promise "callers can still pass false to turn it off" — a promise
 * no caller or UI ever honoured. Without the toolbar toggle the user could expand
 * `.git/` and had no way back, so the default was effectively a hard-coded constant.
 *
 * These assert the two halves that make the toggle real rather than decorative:
 * it renders reflecting the current state, and clicking it reports a change.
 */

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { RenderTreeNodePayload, TreeNodeData } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});

/**
 * The tree body itself is irrelevant here; only the toolbar is under test.
 *
 * The root directory must look LOADED with a non-empty listing: `FileTreeContent`
 * returns a spinner while the root is unloaded, and would never reach the toolbar.
 */
mock.module("./useFileTree", () => ({
	useFileTree: () => ({
		state: new Map([
			["", { entries: [{ name: "a.txt", path: "a.txt", isDirectory: false }], stale: false }],
		]),
		loading: new Set(),
		errors: new Map(),
		load: async () => {},
		reload: async () => {},
		reloadAll: () => {},
		ingest: () => {},
	}),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

/**
 * The row menu and the rename dialog are stubbed rather than mounted: this file is about
 * the toolbar, and the menu brings Mantine's overlay, notification and portal surfaces in
 * behind the minimal `@mantine/core` mocked below. Their own behaviour is covered by
 * `FileContextMenu.test.tsx` and `file-tree-context-menu.test.tsx`.
 */
mock.module("./FileContextMenu", () => ({ FileContextMenu: () => null }));
mock.module("./FileRenameModal", () => ({ FileRenameModal: () => null }));

/**
 * Minimal Mantine surface. `ActionIcon` forwards `onClick` and `aria-pressed`, which
 * are what the assertions read; the rest collapse to their children.
 */
mock.module("@mantine/core", () => ({
	ActionIcon: ({
		children,
		onClick,
		"aria-pressed": pressed,
	}: {
		children?: import("react").ReactNode;
		onClick?: () => void;
		"aria-pressed"?: boolean;
	}) => (
		<button type="button" onClick={onClick} data-aria-pressed={String(pressed ?? false)}>
			{children}
		</button>
	),
	Box: ({ children }: { children?: import("react").ReactNode }) => <div>{children}</div>,
	Center: ({ children }: { children?: import("react").ReactNode }) => <div>{children}</div>,
	Group: ({ children }: { children?: import("react").ReactNode }) => <div>{children}</div>,
	Loader: () => <div data-loader />,
	Text: ({
		children,
		title,
		"data-git-changed": changed,
	}: {
		children?: import("react").ReactNode;
		title?: string;
		"data-git-changed"?: boolean;
	}) => (
		<span title={title} data-git-changed={changed}>
			{children}
		</span>
	),
	Tooltip: ({ children }: { children?: import("react").ReactNode }) => <>{children}</>,
	Tree: ({
		data,
		renderNode,
	}: {
		data: TreeNodeData[];
		renderNode: (payload: RenderTreeNodePayload) => import("react").ReactNode;
	}) => (
		<div data-tree>
			{data.map((node) => (
				<div key={node.value}>
					{renderNode({
						node,
						expanded: false,
						elementProps: { style: {} },
						tree: { toggleExpanded: () => {} },
					} as unknown as RenderTreeNodePayload)}
				</div>
			))}
		</div>
	),
	useTree: () => ({ tree: {}, selected: [], expanded: {} }),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FileTreeContent } = await import("./FileTreeContent");

let root: Root;
let container: HTMLElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
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

/** Render the content view and return its toolbar buttons. */
function render(props: { showHidden: boolean; onToggleShowHidden?: () => void }): void {
	act(() => {
		root.render(
			<FileTreeContent
				root="/repo"
				narratorId="narrator"
				showHidden={props.showHidden}
				onOpenFile={() => {}}
				{...(props.onToggleShowHidden ? { onToggleShowHidden: props.onToggleShowHidden } : {})}
			/>,
		);
	});
}

test("lightweight Git changes keep file markers without fake or stale line statistics", () => {
	const renderStatus = (changed: boolean, measured: boolean) =>
		act(() => {
			root.render(
				<FileTreeContent
					root="/repo"
					narratorId="narrator"
					showHidden
					onOpenFile={() => {}}
					changedPaths={new Set(changed ? ["a.txt"] : [])}
					lineStats={new Map(measured ? [["a.txt", { added: 7, removed: 2 }]] : [])}
				/>,
			);
		});
	renderStatus(true, true);
	expect(container.textContent).toContain("+7");
	renderStatus(true, false);
	expect(container.querySelector('[data-git-changed="true"]')?.textContent).toBe("a.txt");
	expect(container.textContent).not.toMatch(/[+-][0-9]|NaN/);
	renderStatus(false, false);
	expect(container.querySelector("[data-git-changed]")).toBeNull();
});

/** The visibility toggle is the first toolbar button; refresh is the second. */
const toggle = (): HTMLButtonElement | null => container.querySelector("button");

test("renders a toggle that reports the current visibility", () => {
	render({ showHidden: true, onToggleShowHidden: () => {} });
	expect(toggle()).not.toBeNull();
	expect(toggle()?.getAttribute("data-aria-pressed")).toBe("true");

	// Re-render the SAME root: the toggle is controlled, so a changed prop is what a
	// real host does when it owns the state.
	render({ showHidden: false, onToggleShowHidden: () => {} });
	expect(toggle()?.getAttribute("data-aria-pressed")).toBe("false");
});

test("clicking the toggle reports a change", () => {
	let toggles = 0;
	render({
		showHidden: true,
		onToggleShowHidden: () => {
			toggles += 1;
		},
	});

	const button = toggle();
	expect(button).not.toBeNull();
	act(() => {
		button?.click();
	});

	expect(toggles).toBe(1);
});

test("renders no toggle when the host does not ask for one", () => {
	// Optional callback, not a required prop: existing hosts (desktop dock, mobile
	// host, standalone window) render only the refresh button until they opt in.
	render({ showHidden: true });
	const buttons = container.querySelectorAll("button");
	expect(buttons).toHaveLength(1);
	expect(buttons[0].getAttribute("data-aria-pressed")).toBe("false");
});
