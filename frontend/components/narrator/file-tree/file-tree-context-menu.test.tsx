/**
 * file-tree-context-menu.test.tsx — the right-click GESTURE on a file tree row.
 *
 * The menu's own behaviour is covered by `FileContextMenu.test.tsx`; what this file pins is
 * the row-level gating, which is easy to get wrong in a way no other test notices:
 *
 *  - a right-click on a FILE row must prevent the browser's own menu and open ours, with
 *    the absolute path composed from the tree root and the entry's relative path;
 *  - a right-click on a DIRECTORY row must leave the browser menu alone. Rename, delete and
 *    paste all refuse directories on the server, so opening the menu there would offer
 *    actions that can only fail.
 *
 * `FileContextMenu` is replaced by a marker element carrying the props it received: this is
 * a test about the gesture, and mounting the real menu would drag in Mantine's overlays,
 * the confirm dialog and four API calls.
 */

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { RenderTreeNodePayload, TreeNodeData } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
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

// The root level is loaded with one directory and one file, which is all the gesture needs.
mock.module("./useFileTree", () => ({
	useFileTree: () => ({
		state: new Map([
			[
				"",
				{
					entries: [
						{ name: "src", path: "src", isDirectory: true, isSymlink: false },
						{ name: "a.ts", path: "a.ts", isDirectory: false, isSymlink: false, size: 3 },
					],
					stale: false,
				},
			],
		]),
		loading: new Set(),
		errors: new Map(),
		load: async () => {},
		reload: async () => {},
		reloadAll: () => {},
		ingest: () => {},
	}),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("./FileRenameModal", () => ({ FileRenameModal: () => null }));
mock.module("./FileContextMenu", () => ({
	FileContextMenu: (props: {
		x: number;
		y: number;
		target: { absolutePath: string; relativePath: string; name: string };
		narratorId: string;
		onReference: (() => void) | null;
	}) => (
		<div
			data-menu-x={props.x}
			data-menu-y={props.y}
			data-menu-path={props.target.absolutePath}
			data-menu-narrator={props.narratorId}
			data-menu-reference={String(props.onReference !== null)}
		/>
	),
}));

/**
 * Minimal Mantine surface. Components spread their props so the row's own `onClick` and
 * `onContextMenu` survive — that is the wiring under test.
 */
mock.module("@mantine/core", () => ({
	ActionIcon: ({ children, ...rest }: { children?: ReactNode }) => (
		<button {...rest}>{children}</button>
	),
	Box: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
	Center: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
	Group: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
	Loader: () => <div data-loader />,
	Text: ({
		children,
		truncate: _truncate,
		...rest
	}: {
		children?: ReactNode;
		truncate?: boolean;
	}) => <span {...rest}>{children}</span>,
	Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
	Tree: ({
		data,
		renderNode,
	}: {
		data: TreeNodeData[];
		renderNode: (payload: RenderTreeNodePayload) => ReactNode;
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
	document.body.append(container);
	root = createRoot(container);
	act(() => {
		root.render(
			<FileTreeContent root="/repo" narratorId="narrator-a" showHidden onOpenFile={() => {}} />,
		);
	});
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

/** linkedom implements `Event` but not `MouseEvent`; the handler only reads these fields. */
function rightClick(node: Element): Event {
	const created = new window.Event("contextmenu", { bubbles: true, cancelable: true });
	Object.assign(created, { clientX: 120, clientY: 80 });
	act(() => node.dispatchEvent(created));
	return created as unknown as Event;
}

/** The rendered row whose label matches `label`. */
function row(label: string): Element {
	// The row is the element with the pointer cursor; its parents (the mocked tree's wrapper)
	// carry the same text and would swallow the dispatch.
	const found = [...container.querySelectorAll("div")].find(
		(node) => node.textContent === label && node.style.cursor === "pointer",
	);
	if (!found) throw new Error(`row not rendered: ${label}`);
	return found;
}

test("right-clicking a file opens the menu with its absolute path", () => {
	const event = rightClick(row("a.ts"));
	expect(event.defaultPrevented).toBe(true);

	const menu = container.querySelector("[data-menu-path]") as HTMLElement | null;
	expect(menu).not.toBeNull();
	expect(menu?.dataset.menuPath).toBe("/repo/a.ts");
	expect(menu?.dataset.menuX).toBe("120");
	expect(menu?.dataset.menuY).toBe("80");
	expect(menu?.dataset.menuNarrator).toBe("narrator-a");
	// No composer scope is mounted around the tree in this test, so the entry is not offered.
	expect(menu?.dataset.menuReference).toBe("false");
});

test("right-clicking a directory leaves the browser's own menu", () => {
	const event = rightClick(row("src"));
	expect(event.defaultPrevented).toBe(false);
	expect(container.querySelector("[data-menu-path]")).toBeNull();
});
