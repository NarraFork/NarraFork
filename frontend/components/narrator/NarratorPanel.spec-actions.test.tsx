import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, memo, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NarratorToolPanelType } from "./dock/dock-panel-types";
import type { NarratorDockContextValue } from "./dock/NarratorDockContext";

// Run the panel's actual Spec hooks under React, without mounting its unrelated
// queries, WS connection and virtual list. No callback/dependency logic is copied
// into this fixture: a boundary move must update the fixture rather than silently
// leaving an old implementation under test.
const source = await Bun.file(new URL("./NarratorPanel.tsx", import.meta.url)).text();
function section(start: string, end: string) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	if (from < 0 || to < 0) throw new Error(`Spec hook boundary not found: ${start}`);
	return source.slice(from, to);
}
const hookCode = new Bun.Transpiler({ loader: "ts" }).transformSync(`
function useSpecActions({ dock, narratorId, onToggleSpecPanel, specPanelOpen, isWorkspacePreview }) {
	${section("const dockOpenToolPanel =", "\n")}
	${section("const [internalSpecOpen,", "// Background tasks:")}
	${section("const handleOpenSpecFile =", "/**\n\t * Open a chapter referenced")}
	return { openSpecTool, handleOpenSpecFile, specToolOpened, specToolAvailable, useInternalSpec };
}`);

type SpecDock = Pick<
	NarratorDockContextValue,
	"narratorId" | "openToolTypes" | "openToolPanel" | "toggleToolPanel" | "browserInfo"
>;
interface SpecOptions {
	dock: SpecDock | null;
	narratorId: string;
	onToggleSpecPanel?: () => void;
	specPanelOpen?: boolean;
	isWorkspacePreview: boolean;
}
interface SpecActions {
	openSpecTool: () => void;
	handleOpenSpecFile: (uri: string) => void;
	specToolOpened: boolean;
	specToolAvailable: boolean;
	useInternalSpec: boolean;
}
const reveal = mock((_narratorId: string, _uri: string) => {});
const useSpecActions = new Function(
	"useCallback",
	"useRef",
	"useState",
	"revealSpecFile",
	`${hookCode}\nreturn useSpecActions;`,
)(useCallback, useRef, useState, reveal) as (options: SpecOptions) => SpecActions;

let root: Root;
let actions: SpecActions;
let rowRenders: number;
const originals = new Map<string, PropertyDescriptor | undefined>();
const Row = memo(({ open }: { open: (uri: string) => void }) => {
	rowRenders++;
	return (
		<button type="button" onClick={() => open("spec://tasks.json")}>
			Spec
		</button>
	);
});
function Probe(options: SpecOptions) {
	actions = useSpecActions(options);
	return <Row open={actions.handleOpenSpecFile} />;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	rowRenders = 0;
	reveal.mockClear().mockImplementation(() => {});
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(options: Partial<SpecOptions> = {}) {
	await act(async () => {
		root.render(<Probe dock={null} narratorId="parent" isWorkspacePreview={false} {...options} />);
	});
}

function makeDock(): SpecDock {
	return {
		narratorId: "parent",
		openToolTypes: new Set(["spec"]),
		openToolPanel: mock((_type: NarratorToolPanelType) => {}),
		toggleToolPanel: mock((_type: NarratorToolPanelType) => {}),
		browserInfo: { sessionCount: 0, visualChange: null },
	};
}

describe("NarratorPanel Spec row actions", () => {
	test("unrelated dock publications retain row callbacks and always open rather than toggle", async () => {
		const dock = makeDock();
		await render({ dock });
		const first = actions.handleOpenSpecFile;
		const firstOpen = actions.openSpecTool;
		for (let i = 0; i < 5; i++) {
			await render({
				dock: {
					...dock,
					openToolTypes: new Set(["spec"]),
					browserInfo: { sessionCount: i + 1, visualChange: null },
				},
			});
		}
		expect(actions.openSpecTool).toBe(firstOpen);
		expect(actions.handleOpenSpecFile).toBe(first);
		expect(rowRenders).toBe(1);
		first("spec://tasks.json");
		first("spec://index.md");
		expect(dock.openToolPanel).toHaveBeenCalledTimes(2);
		expect(dock.openToolPanel).toHaveBeenCalledWith("spec");
		expect(dock.toggleToolPanel).not.toHaveBeenCalled();
		expect(reveal).toHaveBeenLastCalledWith("parent", "spec://index.md");
	});

	test("a changed dock opener takes effect before revealing the file", async () => {
		const dock = makeDock();
		await render({ dock });
		const first = actions.handleOpenSpecFile;
		const events: string[] = [];
		const replacement = mock((_type: NarratorToolPanelType) => events.push("open"));
		reveal.mockImplementation(() => {
			events.push("reveal");
		});
		await render({ dock: { ...dock, openToolPanel: replacement } });
		expect(actions.handleOpenSpecFile).not.toBe(first);
		actions.handleOpenSpecFile("spec://tasks.json");
		expect(replacement).toHaveBeenCalledWith("spec");
		expect(dock.openToolPanel).not.toHaveBeenCalled();
		expect(events).toEqual(["open", "reveal"]);
		reveal.mockImplementation(() => {});
	});

	test("legacy callbacks open closed panels but never close an already-open panel", async () => {
		const toggle = mock(() => {});
		await render({ onToggleSpecPanel: toggle, specPanelOpen: false });
		actions.openSpecTool();
		expect(toggle).toHaveBeenCalledTimes(1);
		await render({ onToggleSpecPanel: toggle, specPanelOpen: true });
		actions.openSpecTool();
		actions.handleOpenSpecFile("spec://tasks.json");
		expect(toggle).toHaveBeenCalledTimes(1);
		expect(reveal).toHaveBeenCalledWith("parent", "spec://tasks.json");
		const replacement = mock(() => {});
		await render({ onToggleSpecPanel: replacement, specPanelOpen: false });
		actions.openSpecTool();
		expect(replacement).toHaveBeenCalledTimes(1);
	});

	test("the internal drawer opens idempotently and reveals the current narrator's file", async () => {
		await render();
		expect(actions.useInternalSpec).toBe(true);
		expect(actions.specToolOpened).toBe(false);
		await act(async () => actions.handleOpenSpecFile("spec://tasks.json"));
		expect(actions.specToolOpened).toBe(true);
		await act(async () => actions.openSpecTool());
		expect(actions.specToolOpened).toBe(true);
		await render({ narratorId: "other" });
		await act(async () => actions.handleOpenSpecFile("spec://index.md"));
		expect(reveal).toHaveBeenLastCalledWith("other", "spec://index.md");
	});

	test("pushed child sessions fall back to their own drawer or legacy host, not the parent dock", async () => {
		const dock = makeDock();
		await render({ dock });
		const first = actions.handleOpenSpecFile;
		await render({ dock, narratorId: "child" });
		expect(actions.handleOpenSpecFile).not.toBe(first);
		expect(actions.useInternalSpec).toBe(true);
		await act(async () => actions.handleOpenSpecFile("spec://tasks.json"));
		expect(actions.specToolOpened).toBe(true);
		expect(dock.openToolPanel).not.toHaveBeenCalled();
		expect(reveal).toHaveBeenLastCalledWith("child", "spec://tasks.json");
		const toggle = mock(() => {});
		await render({ dock, narratorId: "child", onToggleSpecPanel: toggle });
		actions.openSpecTool();
		expect(toggle).toHaveBeenCalledTimes(1);
		expect(dock.openToolPanel).not.toHaveBeenCalled();
	});

	test("off-dock workspace previews still do not offer an internal Spec surface", async () => {
		await render({ isWorkspacePreview: true });
		expect(actions.specToolAvailable).toBe(false);
		expect(actions.useInternalSpec).toBe(false);
	});
});
