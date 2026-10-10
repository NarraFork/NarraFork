import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	type DockviewApi,
	DockviewReact,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
	type SerializedDockview,
} from "dockview-react";
import { createInstance } from "i18next";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { onPanelDragEnd, onPanelDragMove } from "../../../lib/panel-drag";
import narratorTranslations from "../../../locales/en/narrators.json";
import { ToolPanelShell } from "../dock/panels";
import { useNarratorPanelVisible } from "../narrator-panel-visibility";
import { DEFAULT_DIRECTOR_STATE, serializeWorkspaceLayout } from "./dockview-layout";
import type { WorkspacePanelParams } from "./panel-types";
import { WorkspaceResourceFrame } from "./WorkspaceResourceFrame";
import { WorkspaceResourceTab } from "./WorkspaceResourceTab";
import {
	createWorkspaceDockStore,
	WorkspaceDockProvider,
	workspaceSubagentPanelId,
	workspaceToolPanelId,
} from "./workspace-dock";
import "@mantine/core/styles.css";
import "dockview-react/dist/styles/dockview.css";
import "../../dockview/theme.css";
import "./workspace-resource.css";

// The production store, WorkspaceResourceFrame, ToolPanelShell/header/drag,
// theme CSS, Query/Locale providers and native Dockview mounts are real. Only
// transport-heavy resource bodies and the Director background are mocked.
// Subagent uses the same real common header shell with a mocked child body;
// this does not claim to exercise the full session/query/WS implementation.
export type ResourceKind = "terminal" | "browser" | "subagent";
const apiRef: { current: DockviewApi | null } = { current: null };
const store = createWorkspaceDockStore(apiRef);
const mounts: Record<string, number> = {};
const cleanups: Record<string, number> = {};
const bodyClicks: Record<string, number> = {};
const titleClicks: Record<string, number> = {};
const headerPointerDowns: Record<string, number> = {};
const consumedHeaders = new Set<string>();
let nextInstance = 0;
let reveals = 0;
let overlayClicks = 0;
let ready = false;
let normalDragMoves = 0;
let normalDragDrops = 0;
onPanelDragMove(() => normalDragMoves++);
onPanelDragEnd((state) => {
	if (state) normalDragDrops++;
});
const escapeDecisions: {
	closed: boolean;
	prevented: boolean;
	target: string | null;
	focused: boolean;
	opener: string | null;
}[] = [];

/** Deterministically expose Dockview's pre-first-paint attachment state. */
export function holdLayoutFrames() {
	const request = window.requestAnimationFrame;
	const cancel = window.cancelAnimationFrame;
	const pending = new Map<number, FrameRequestCallback>();
	let nextId = -1;
	window.requestAnimationFrame = (callback) => {
		if (pending.size >= 100) throw new Error("Fixture layout callback budget exceeded");
		const id = nextId--;
		pending.set(id, callback);
		return id;
	};
	window.cancelAnimationFrame = (id) => {
		if (!pending.delete(id)) cancel.call(window, id);
	};
	releaseLayoutFrames = () => {
		window.requestAnimationFrame = request;
		window.cancelAnimationFrame = cancel;
		for (const callback of pending.values()) request.call(window, callback);
		pending.clear();
	};
}
export let releaseLayoutFrames = () => {};

export function resourceFocus(id: string) {
	const pin = document.querySelector<HTMLButtonElement>(`[data-workspace-resource-pin="${id}"]`);
	if (!pin) throw new Error("Missing resource pin");
	const rect = pin.getBoundingClientRect();
	const panel = apiRef.current?.getPanel(id);
	return {
		focused: document.activeElement === pin,
		activeTag: document.activeElement?.tagName,
		activeOpener: document.activeElement?.getAttribute("data-open"),
		disabled: pin.disabled,
		visible: pin.checkVisibility({ checkVisibilityCSS: true }),
		visibility: getComputedStyle(pin).visibility,
		width: rect.width,
		height: rect.height,
		panelVisible: panel?.api.isVisible,
		floating: panel?.api.location.type === "floating",
		contentContains: panel?.view.content.element.contains(pin),
	};
}

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
});
for (const id of ["narrator-a", "narrator-b"])
	client.setQueryData(["narrators", id], { id, title: id === "narrator-a" ? "Alice" : "Bob" });
const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { narrators: narratorTranslations } },
});

export function resourceId(kind: ResourceKind) {
	return kind === "subagent"
		? workspaceSubagentPanelId("narrator-a", "child-one")
		: workspaceToolPanelId("narrator-a", kind);
}

function openResource(kind: ResourceKind) {
	if (kind === "subagent") store.openSubagentPanel("narrator-a", "child-one");
	else store.openToolPanel("narrator-a", kind, null);
}

function ResourceButtons({ director = false }: { director?: boolean }) {
	return (
		<div style={{ display: "flex", gap: 6 }}>
			{(["terminal", "browser", "subagent"] as const).map((kind) => (
				<button
					key={kind}
					type="button"
					data-open={`${director ? "director" : "grid"}-${kind}`}
					onClick={() => openResource(kind)}
				>
					Open {kind}
				</button>
			))}
			<button
				type="button"
				data-toggle={`${director ? "director" : "grid"}-terminal`}
				onClick={() => store.toggleToolPanel("narrator-a", "terminal", null)}
			>
				Toggle terminal
			</button>
		</div>
	);
}

function BodyVisibilityProbe({ children }: { children: ReactNode }) {
	const visible = useNarratorPanelVisible();
	return <div data-resource-visible={String(visible)}>{children}</div>;
}

export function consumeHeaderPointerDown(id: string, consume: boolean) {
	if (consume) consumedHeaders.add(id);
	else consumedHeaders.delete(id);
}

function MockPanel(props: IDockviewPanelProps<WorkspacePanelParams>) {
	const { api, params } = props;
	const [instance] = useState(() => ++nextInstance);
	const [clicks, setClicks] = useState(0);
	const title =
		params.panelType === "narrator"
			? params.narratorId === "narrator-a"
				? "Alice"
				: "Bob"
			: params.panelType === "narrator-tool"
				? params.toolType
				: "subagent";
	useEffect(() => {
		mounts[api.id] = (mounts[api.id] ?? 0) + 1;
		return () => {
			cleanups[api.id] = (cleanups[api.id] ?? 0) + 1;
		};
	}, [api]);
	useEffect(() => {
		api.setTitle(title);
	}, [api, title]);
	const body = (
		<div style={{ padding: 12 }}>
			{params.panelType === "narrator" && params.narratorId === "narrator-a" && <ResourceButtons />}
			<button
				type="button"
				data-body={api.id}
				onClick={() => {
					bodyClicks[api.id] = (bodyClicks[api.id] ?? 0) + 1;
					setClicks((value) => value + 1);
				}}
			>
				Body {api.id}: {clicks}
			</button>
			{params.panelType !== "narrator" && (
				<div style={{ display: "grid", gap: 4 }}>
					<input data-editor="input" aria-label="Mock input" />
					<textarea data-editor="textarea" aria-label="Mock textarea" />
					<select data-editor="select" aria-label="Mock select">
						<option>Choice</option>
					</select>
					{/* biome-ignore lint/a11y/useSemanticElements: Exercise contenteditable separately from input/textarea exclusions. */}
					<div
						data-editor="contenteditable"
						contentEditable
						role="textbox"
						tabIndex={0}
						aria-label="Mock editable"
					/>
					<div className="xterm">
						<button type="button" data-editor="xterm">
							Mock xterm target
						</button>
					</div>
					<div className="monaco-editor">
						<button type="button" data-editor="monaco">
							Mock Monaco target
						</button>
					</div>
					<div role="menu">
						<button type="button" data-editor="menu">
							Mock menu target
						</button>
					</div>
					<div role="dialog" aria-label="Mock dialog">
						<button type="button" data-editor="dialog">
							Mock dialog target
						</button>
					</div>
					<button
						type="button"
						data-editor="consumed"
						onKeyDown={(event) => {
							if (event.key === "Escape") event.preventDefault();
						}}
					>
						Consume Escape
					</button>
				</div>
			)}
		</div>
	);
	return (
		<section
			data-panel={api.id}
			data-instance={instance}
			style={{ height: "100%" }}
			onPointerDownCapture={(event) => {
				if ((event.target as Element).closest(".nf-panel-header")) {
					headerPointerDowns[api.id] = (headerPointerDowns[api.id] ?? 0) + 1;
					// Simulate an earlier consumer, without replacing the real header handler.
					if (consumedHeaders.has(api.id)) event.preventDefault();
				}
			}}
			onClickCapture={(event) => {
				if ((event.target as Element).closest(".nf-panel-header")) {
					titleClicks[api.id] = (titleClicks[api.id] ?? 0) + 1;
				}
			}}
		>
			{params.panelType === "narrator" ? (
				body
			) : (
				<WorkspaceResourceFrame props={props}>
					<ToolPanelShell
						title={title}
						props={props}
						subjectId={api.id}
						detachKind={params.panelType === "narrator-tool" ? params.toolType : "subagent"}
					>
						<BodyVisibilityProbe>{body}</BodyVisibilityProbe>
					</ToolPanelShell>
				</WorkspaceResourceFrame>
			)}
		</section>
	);
}

function ResourceHeader(props: IDockviewPanelHeaderProps) {
	return (
		<div
			data-resource-tab={props.api.id}
			style={{ display: "flex", height: "100%" }}
			onClickCapture={() => {
				titleClicks[props.api.id] = (titleClicks[props.api.id] ?? 0) + 1;
			}}
		>
			<WorkspaceResourceTab {...props} />
		</div>
	);
}

const components = { narrator: MockPanel, "narrator-tool": MockPanel, subagent: MockPanel };
const tabComponents = { "workspace-resource": ResourceHeader };
function Harness() {
	const director = useSyncExternalStore(store.subscribeDirector, store.getDirectorActive);
	const surfaceRoot = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const root = surfaceRoot.current;
		if (!root) return;
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Same native ancestor + microtask ordering as DockviewWorkspace:
			// React editors may preventDefault after this listener has run.
			queueMicrotask(() => {
				escapeDecisions.push({
					focused: event.target === document.activeElement,
					closed: store.closeFocusedTemporaryResource(event),
					prevented: event.defaultPrevented,
					target: event.target instanceof Element ? event.target.getAttribute("data-editor") : null,
					opener: event.target instanceof Element ? event.target.getAttribute("data-open") : null,
				});
				if (escapeDecisions.length > 40) escapeDecisions.shift();
			});
		};
		root.addEventListener("keydown", onEscape);
		return () => root.removeEventListener("keydown", onEscape);
	}, []);
	return (
		<>
			<button type="button" data-director-toggle onClick={() => store.setDirectorActive(!director)}>
				Toggle Director background
			</button>
			<div
				ref={surfaceRoot}
				data-workspace
				className={`workspace-resource-surface${director ? " workspace-resource-director" : ""}`}
				style={{
					position: "relative",
					margin: "18px 24px",
					width: "calc(100% - 48px)",
					height: "calc(100vh - 110px)",
				}}
			>
				<div data-dockview-surface style={{ position: "absolute", inset: 0 }}>
					<div className="dockview-theme-narrafork">
						<DockviewReact
							components={components}
							tabComponents={tabComponents}
							defaultRenderer="always"
							floatingGroupBounds="boundedWithinViewport"
							theme={{
								name: "narrafork",
								className: "dockview-theme-narrafork",
								tabGroupIndicator: "none",
							}}
							onReady={({ api }) => {
								apiRef.current = api;
								store.onRevealGrid = () => {
									reveals++;
									store.setDirectorActive(false);
								};
								api.onDidLayoutChange(() => {
									store.reconcileTemporaryResources();
									store.refreshOpenToolTypes(api);
								});
								api.onDidRemovePanel((panel) => store.forgetResource(panel.id));
								api.addPanel({
									id: "source-a",
									component: "narrator",
									params: { panelType: "narrator", narratorId: "narrator-a" },
									title: "Alice",
								});
								if (new URLSearchParams(location.search).get("slots") !== "1") {
									api.addPanel({
										id: "source-b",
										component: "narrator",
										params: { panelType: "narrator", narratorId: "narrator-b" },
										title: "Bob",
										position: { referencePanel: "source-a", direction: "right" },
									});
								}
								ready = true;
							}}
						/>
					</div>
				</div>
				{director && (
					<div
						className="workspace-resource-director-overlay"
						data-director-overlay
						style={{ position: "absolute", inset: 0, background: "#202025", padding: 12 }}
						onClickCapture={() => {
							overlayClicks++;
						}}
					>
						<ResourceButtons director />
						<p>Mock Director background (not DirectorLayout).</p>
					</div>
				)}
			</div>
		</>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<MantineProvider defaultColorScheme="dark">
		<QueryClientProvider client={client}>
			<I18nextProvider i18n={i18n}>
				<WorkspaceDockProvider store={store} workspaceId="browser-fixture">
					<Harness />
				</WorkspaceDockProvider>
			</I18nextProvider>
		</QueryClientProvider>
	</MantineProvider>,
);

export function snapshot() {
	const api = apiRef.current;
	return {
		ready,
		director: store.getDirectorActive(),
		reveals,
		normalDragMoves,
		normalDragDrops,
		overlayClicks,
		escapeDecisions: [...escapeDecisions],
		temporary: [...store.getTemporaryPanelIds()],
		activePanel: api?.activePanel?.id,
		singleGridSlot: store.hasSingleGridSlot(),
		rootGrid: api?.toJSON().grid,
		grid: (api?.groups ?? [])
			.filter((group) => group.api.location.type === "grid")
			.map((group) => ({
				id: group.id,
				...rect(group.element),
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		panels: (api?.panels ?? []).map((panel) => ({
			id: panel.id,
			group: panel.group.id,
			location: panel.api.location.type,
			headerHidden: panel.group.header.hidden,
			managedPreview: store.isManagedPreview(panel.id),
			activePreview: store.isActivePreview(panel.id),
			providerVisible:
				document
					.querySelector(`[data-panel="${panel.id}"] [data-resource-visible]`)
					?.getAttribute("data-resource-visible") === "true",
			nativeHostInert:
				panel.group.element.closest<HTMLElement>(".dv-resize-container")?.inert ?? false,
			bodyOverlayInert:
				document
					.querySelector(`[data-panel="${panel.id}"]`)
					?.closest<HTMLElement>(".dv-render-overlay")?.inert ?? false,
			groupBounds: rect(panel.group.element),
			mounts: mounts[panel.id] ?? 0,
			cleanups: cleanups[panel.id] ?? 0,
			bodyClicks: bodyClicks[panel.id] ?? 0,
			titleClicks: titleClicks[panel.id] ?? 0,
			headerPointerDowns: headerPointerDowns[panel.id] ?? 0,
			instance: document.querySelector(`[data-panel="${panel.id}"]`)?.getAttribute("data-instance"),
			visible:
				document
					.querySelector(`[data-panel="${panel.id}"]`)
					?.checkVisibility({ checkVisibilityCSS: true }) ?? false,
		})),
	};
}

function rect(element: Element) {
	const { left, top, width, height } = element.getBoundingClientRect();
	return { left, top, width, height };
}

export function durableLayout(): SerializedDockview {
	return JSON.parse(
		serializeWorkspaceLayout(
			nativeDockviewApi(),
			DEFAULT_DIRECTOR_STATE,
			store.getTemporaryPanelIds(),
		),
	).layout;
}

export function nativeDockviewApi() {
	if (!apiRef.current) throw new Error("Native Dockview not mounted");
	return apiRef.current;
}

export function nativeFloatingBounds() {
	const workspace = document.querySelector("[data-workspace]");
	if (!workspace) throw new Error("Workspace not mounted");
	return {
		workspace: rect(workspace),
		floating: [
			...workspace.querySelectorAll(".dv-floating-overlay-host > .dv-resize-container"),
		].map(rect),
	};
}
