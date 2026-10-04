import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	type DockviewApi,
	DockviewReact,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
} from "dockview-react";
import { createInstance } from "i18next";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import narratorTranslations from "../../../locales/en/narrators.json";
import type { WorkspacePanelParams } from "./panel-types";
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

// The production store/header/CSS and native Dockview mounts are real. Only
// panel bodies and the Director background are mocked: no backend or WS.
export type ResourceKind = "terminal" | "browser" | "subagent";
const apiRef: { current: DockviewApi | null } = { current: null };
const store = createWorkspaceDockStore(apiRef);
const mounts: Record<string, number> = {};
const cleanups: Record<string, number> = {};
const bodyClicks: Record<string, number> = {};
const titleClicks: Record<string, number> = {};
let nextInstance = 0;
let reveals = 0;
let overlayClicks = 0;
let ready = false;
const escapeDecisions: { closed: boolean; prevented: boolean; target: string | null }[] = [];

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
		</div>
	);
}

function MockPanel({ api, params }: IDockviewPanelProps<WorkspacePanelParams>) {
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
	return (
		<section data-panel={api.id} data-instance={instance} style={{ height: "100%", padding: 12 }}>
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
					closed: store.closeFocusedTemporaryResource(event),
					prevented: event.defaultPrevented,
					target: event.target instanceof Element ? event.target.getAttribute("data-editor") : null,
				});
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
								api.addPanel({
									id: "source-b",
									component: "narrator",
									params: { panelType: "narrator", narratorId: "narrator-b" },
									title: "Bob",
									position: { referencePanel: "source-a", direction: "right" },
								});
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
		overlayClicks,
		escapeDecisions: [...escapeDecisions],
		temporary: [...store.getTemporaryPanelIds()],
		activePanel: api?.activePanel?.id,
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
			mounts: mounts[panel.id] ?? 0,
			cleanups: cleanups[panel.id] ?? 0,
			bodyClicks: bodyClicks[panel.id] ?? 0,
			titleClicks: titleClicks[panel.id] ?? 0,
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
