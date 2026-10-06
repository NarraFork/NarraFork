/** Real Dockview + Monaco browser fixture. No backend, database, private editor APIs or geometry mocks. */
import "@mantine/core/styles.css";
import "dockview-react/dist/styles/dockview.css";
import "../frontend/components/dockview/theme.css";
import { MantineProvider } from "@mantine/core";
import type { FileSelection } from "@shared/file-reference";
import { type DockviewApi, DockviewReact, type IDockviewPanelProps } from "dockview-react";
import i18n from "i18next";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import {
	MonacoEditor,
	type MonacoEditorHandle,
} from "../frontend/components/narrator/file-editor/MonacoEditor";
import { MonacoSearchPanel } from "../frontend/components/narrator/file-editor/MonacoSearchPanel";
import narratorEnglish from "../frontend/locales/en/narrator.json";

export interface NavigationOptions {
	readOnly?: boolean;
	wrapping?: boolean;
	longLine?: boolean;
	internalSearch?: boolean;
}
interface Params extends NavigationOptions {
	selection?: FileSelection;
	navigationRequestId?: string;
	searchRequestId?: number;
}
export interface NavigationSnapshot {
	window: { top: number; left: number };
	ancestors: {
		name: string;
		top: number;
		left: number;
		maxTop: number;
		maxLeft: number;
		overflow: string;
	}[];
	header: { top: number; bottom: number; left: number; right: number };
	tab: { top: number; bottom: number; left: number; right: number };
	editor: {
		top: number;
		left: number;
		height: number;
		width: number;
		docLength: number;
		readOnly: boolean;
		selectionText: string;
		modelId: string;
		revision: number;
		canUndo: boolean;
		visible: boolean;
	};
	target: {
		line: number;
		column: number;
		visible: boolean;
		rect: { top: number; bottom: number; left: number; right: number } | null;
	};
	active: string | undefined;
}
export interface NavigationFixture {
	ready: boolean;
	configure(options: NavigationOptions): void;
	open(line: number, column?: number): void;
	activate(): void;
	hide(): void;
	search(): void;
	focus(): void;
	frames(count?: number): Promise<void>;
	snapshot(): NavigationSnapshot;
}
declare global {
	interface Window {
		__fileNavigation: NavigationFixture;
	}
}
let api: DockviewApi;
let editorHandle: MonacoEditorHandle | null = null;
let sequence = 0;
let target = { line: 1, column: 1 };
const plain = Array.from(
	{ length: 220 },
	(_, index) =>
		`line ${index + 1}: ${index === 179 ? "SEARCH_TARGET " : ""}${"plain text ".repeat(9)}`,
).join("\n");
const long = Array.from(
	{ length: 120 },
	(_, index) => `line ${index + 1}: ${"abcdefghij ".repeat(220)}`,
).join("\n");
function Panel({ params }: IDockviewPanelProps<Params>) {
	const [handle, setHandle] = useState<MonacoEditorHandle | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const ready = useCallback((next: MonacoEditorHandle | null) => {
		editorHandle = next;
		fixture.ready = !!next;
		setHandle(next);
	}, []);
	useEffect(() => {
		if (params.searchRequestId && !params.internalSearch) setSearchOpen(true);
	}, [params.searchRequestId, params.internalSearch]);
	const view = handle?.getEditor();
	return (
		<div
			data-editor-panel
			style={{
				height: "100%",
				minHeight: 0,
				overflow: "hidden",
				display: "flex",
				flexDirection: "column",
			}}
		>
			{searchOpen && !params.internalSearch && view && (
				<MonacoSearchPanel
					editor={view}
					readOnly={!!params.readOnly}
					onClose={() => setSearchOpen(false)}
				/>
			)}
			<div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
				<MonacoEditor
					initialValue={params.longLine ? long : plain}
					documentKey="fixture/local/file.txt"
					filePath="file.txt"
					onReady={ready}
					onError={(error) => console.error(error)}
					onSearchRequested={params.internalSearch ? undefined : () => setSearchOpen(true)}
					readOnly={params.readOnly}
					lineWrapping={params.wrapping}
					selection={params.selection}
					navigationRequestId={params.navigationRequestId}
				/>
			</div>
		</div>
	);
}
const components = { editor: Panel, other: () => <div>Other tab, editor stays mounted.</div> };
function required(selector: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) throw new Error(`Fixture element missing: ${selector}`);
	return element;
}
const rect = (element: Element) => {
	const { top, bottom, left, right } = element.getBoundingClientRect();
	return { top, bottom, left, right };
};
const fixture: NavigationFixture = {
	ready: false,
	focus() {
		editorHandle?.focus();
	},
	configure(options) {
		api
			.getPanel("file")
			?.api.updateParameters({ ...options, selection: undefined, navigationRequestId: undefined });
	},
	open(line, column = 1) {
		target = { line, column };
		const selection = {
			startLineNumber: line,
			startColumn: column,
			endLineNumber: line,
			endColumn: column + 6,
		};
		const existing = api.getPanel("file");
		if (!existing) throw new Error("Missing file panel");
		// Exact production repeated-open order, through real Dockview parameter updates and activation.
		existing.api.updateParameters({ selection, navigationRequestId: String(++sequence) });
		existing.api.setActive();
	},
	activate() {
		api.getPanel("file")?.api.setActive();
	},
	hide() {
		api.getPanel("other")?.api.setActive();
	},
	search() {
		target = { line: 180, column: 11 };
		api.getPanel("file")?.api.updateParameters({ searchRequestId: ++sequence });
	},
	async frames(count = 18) {
		for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
	},
	snapshot() {
		const view = editorHandle?.getEditor();
		const model = editorHandle?.getModel();
		const element = view?.getDomNode();
		if (!view || !model || !element) throw new Error("Real Monaco editor has not mounted");
		const ancestors: NavigationSnapshot["ancestors"] = [];
		for (let parent = element.parentElement; parent; parent = parent.parentElement)
			ancestors.push({
				name: parent.id || `${parent.tagName}.${parent.className}`.slice(0, 150),
				top: parent.scrollTop,
				left: parent.scrollLeft,
				maxTop: parent.scrollHeight - parent.clientHeight,
				maxLeft: parent.scrollWidth - parent.clientWidth,
				overflow: getComputedStyle(parent).overflow,
			});
		const position = model.validatePosition({ lineNumber: target.line, column: target.column });
		const geometry = view.getScrolledVisiblePosition(position);
		const bounds = element.getBoundingClientRect();
		const shell = required("#shell").getBoundingClientRect();
		const visible = getComputedStyle(element).visibility === "visible" && bounds.height > 0;
		const coordinates = geometry
			? {
					top: bounds.top + geometry.top,
					bottom: bounds.top + geometry.top + geometry.height,
					left: bounds.left + geometry.left,
					right: bounds.left + geometry.left + 1,
				}
			: null;
		const selection = view.getSelection();
		const selectionStart = selection ? model.getOffsetAt(selection.getStartPosition()) : 0;
		const selectionEnd = selection
			? Math.min(model.getOffsetAt(selection.getEndPosition()), selectionStart + 80)
			: 0;
		const start = model.getPositionAt(selectionStart);
		const end = model.getPositionAt(selectionEnd);
		return {
			window: { top: window.scrollY, left: window.scrollX },
			ancestors,
			header: rect(required("#header")),
			tab: rect(required(".dv-tabs-and-actions-container")),
			editor: {
				top: view.getScrollTop(),
				left: view.getScrollLeft(),
				height: bounds.height,
				width: bounds.width,
				docLength: model.getValueLength(),
				readOnly: !!view.getRawOptions().readOnly,
				selectionText: model.getValueInRange({
					startLineNumber: start.lineNumber,
					startColumn: start.column,
					endLineNumber: end.lineNumber,
					endColumn: end.column,
				}),
				modelId: model.uri.toString(),
				revision: model.getVersionId(),
				canUndo: model.canUndo(),
				visible,
			},
			target: {
				...target,
				rect: coordinates,
				visible:
					visible &&
					!!coordinates &&
					coordinates.top >= Math.max(bounds.top, shell.top) - 1 &&
					coordinates.bottom <= Math.min(bounds.bottom, shell.bottom) + 1 &&
					coordinates.left >= Math.max(bounds.left, shell.left) - 1 &&
					coordinates.right <= Math.min(bounds.right, shell.right) + 1,
			},
			active: api.activePanel?.id,
		};
	},
};
window.__fileNavigation = fixture;
const style = document.createElement("style");
// Real finite clipping: the fixed-height dock forgot to subtract its header.
style.textContent =
	"html,body,#root{margin:0;width:100%;height:100%;overflow:hidden} #shell{position:relative;margin:30px 40px;width:900px;height:570px;overflow:hidden;border:1px solid #667} #header{height:68px;background:#334;padding:16px;box-sizing:border-box} #dock{height:570px;width:900px}";
document.head.append(style);
await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { narrator: narratorEnglish } },
	interpolation: { escapeValue: false },
});
createRoot(required("#root")).render(
	<MantineProvider forceColorScheme="dark">
		<div id="shell">
			<div id="header">File navigation isolation: header must never move</div>
			<div id="dock">
				<DockviewReact
					components={components}
					defaultRenderer="always"
					theme={{ name: "narrafork", className: "dockview-theme-narrafork" }}
					onReady={(event) => {
						api = event.api;
						api.addPanel({ id: "file", component: "editor", title: "file.txt", params: {} });
						api.addPanel({
							id: "other",
							component: "other",
							title: "Other",
							position: { referencePanel: "file", direction: "within" },
						});
						api.getPanel("file")?.api.setActive();
					}}
				/>
			</div>
		</div>
	</MantineProvider>,
);
