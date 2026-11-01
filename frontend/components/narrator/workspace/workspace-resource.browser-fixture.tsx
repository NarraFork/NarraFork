import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	type DockviewApi,
	DockviewReact,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
	type SerializedDockview,
} from "dockview-react";
import { createInstance } from "i18next";
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { PretextDocumentPageResult, TreeMessage } from "../../../lib/api/types";
import { onPanelDragEnd, onPanelDragMove } from "../../../lib/panel-drag";
import narratorTranslations from "../../../locales/en/narrators.json";
import { ToolPanelShell } from "../dock/panels";
import {
	DockviewNarratorPanelVisibilityProvider,
	useNarratorPanelVisible,
} from "../narrator-panel-visibility";
import type { PretextDocumentFetchPage } from "../vlist/pretext-document-loader";
import { usePretextDocument } from "../vlist/usePretextDocument";
import { hasVisibleVListGeometry } from "../vlist/vlist-visible-viewport";
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
// Opt-in only: existing resource/Director cases retain their original mocked bodies.
const messagesMode = new URLSearchParams(location.search).get("messages") === "1";
const messageRequests: { narratorId: string; tail: boolean; aborted: boolean }[] = [];
const parkAfterMessageCommit = new Set<string>();
const parkedMessageCommits: { panelId: string; width: number; height: number }[] = [];

/** Force commit -> CSS parking -> passive effects without depending on browser scheduling. */
export function parkAfterNextMessageCommit(panelId: string) {
	parkAfterMessageCommit.add(panelId);
}
const messageDocuments: Record<
	string,
	{
		narratorId: string;
		providerVisible: boolean;
		status: string;
		messageIds: string[];
		texts: string[];
		itemCount: number;
		totalHeight: number;
		itemWidths: (number | undefined)[];
		firstReadyMs: number | null;
		clearedAfterReady: number;
		zeroSizeAdoptions: number;
		error: string | null;
	}
> = {};
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
	else store.openToolPanel("narrator-a", kind);
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
				onClick={() => store.toggleToolPanel("narrator-a", "terminal")}
			>
				Toggle terminal
			</button>
		</div>
	);
}

// Stable identity is essential: coordinator rerenders must not restart transport.
const fetchMessagePage: PretextDocumentFetchPage = async (narratorId, options) => {
	const request = {
		narratorId,
		tail: options.afterSeq == null && options.beforeSeq == null,
		aborted: options.signal?.aborted ?? false,
	};
	messageRequests.push(request);
	options.signal?.addEventListener(
		"abort",
		() => {
			request.aborted = true;
		},
		{ once: true },
	);
	const messages = [0, 1].map((seq): TreeMessage => {
		const text =
			`## ${narratorId} message ${seq}\n\nReal measured document body for ${narratorId}. ` +
			"Several words wrap naturally using this panel's actual browser width. ".repeat(8);
		const row = {
			id: `${narratorId}-message-${seq}`,
			narratorId,
			parentToolUseId: null,
			role: "assistant",
			contentText: text,
			toolCalls: [],
			createdAt: "2026-10-01T00:00:00.000Z",
			seq,
		} as Omit<TreeMessage, "blocks">;
		return rowWithElements(row, [{ type: "text", text }]);
	});
	return {
		messages,
		minSeq: 0,
		maxSeq: 1,
		hasNext: false,
		hasPrev: false,
		messageVersion: 1,
	} satisfies PretextDocumentPageResult;
};
const messageLoadOptions = { fetchPage: fetchMessagePage };

/** Real hook/coordinator/build; only the transport and expensive session/WS view are mocked. */
function MessageDocumentProbe({ panelId, narratorId }: { panelId: string; narratorId: string }) {
	const visible = useNarratorPanelVisible();
	const nodeRef = useRef<HTMLDivElement | null>(null);
	const [geometry, setGeometry] = useState({ width: 0, height: 0, ready: false });
	const startedAt = useRef(performance.now());
	const firstReadyAt = useRef<number | null>(null);
	const previouslyReady = useRef(false);
	const previousIndex = useRef<unknown>(null);
	const cleared = useRef(0);
	const zeroAdoptions = useRef(0);
	useEffect(() => {
		const node = nodeRef.current;
		if (!node) return;
		const measure = () => {
			const ready = visible && hasVisibleVListGeometry(node);
			const width = node.clientWidth;
			const height = node.clientHeight;
			setGeometry((old) =>
				old.width === width && old.height === height && old.ready === ready
					? old
					: { width, height, ready },
			);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		measure();
		return () => observer.disconnect();
	}, [visible]);
	const document = usePretextDocument(narratorId, {
		layoutReady: visible && geometry.ready,
		lod: 5,
		widthBucket: String(geometry.width),
		contentWidth: geometry.width,
		viewportHeight: geometry.height,
		scrollTop: 0,
		pinnedToBottom: true,
		loadOptions: messageLoadOptions,
	});
	// Observe each committed index synchronously. A passive observer can see an
	// older commit's index after Dockview/test code has already CSS-parked its DOM,
	// falsely counting retention of a measured document as a zero-size adoption.
	useLayoutEffect(() => {
		if (document.status === "ready" && document.index && firstReadyAt.current == null)
			firstReadyAt.current = performance.now();
		if (previouslyReady.current && document.messages.length === 0) cleared.current++;
		if (
			document.index &&
			document.index !== previousIndex.current &&
			(!nodeRef.current || !hasVisibleVListGeometry(nodeRef.current))
		)
			zeroAdoptions.current++;
		previousIndex.current = document.index;
		previouslyReady.current ||= document.messages.length > 0;
		messageDocuments[panelId] = {
			narratorId,
			providerVisible: visible,
			status: document.status,
			messageIds: document.messages.map((message) => message.id),
			texts: document.messages.map((message) => message.contentText ?? ""),
			itemCount: document.items.length,
			totalHeight: document.index?.totalHeight ?? 0,
			itemWidths: document.items.map((item) => item.contentWidth),
			firstReadyMs: firstReadyAt.current == null ? null : firstReadyAt.current - startedAt.current,
			clearedAfterReady: cleared.current,
			zeroSizeAdoptions: zeroAdoptions.current,
			error: document.error == null ? null : String(document.error),
		};
	});
	// Registered after the commit observer: a measured ready document is committed
	// with real geometry, then parked before React can flush its passive effects.
	useLayoutEffect(() => {
		const node = nodeRef.current;
		if (document.status !== "ready" || !document.index || !node) return;
		if (!parkAfterMessageCommit.delete(panelId)) return;
		parkedMessageCommits.push({ panelId, width: node.clientWidth, height: node.clientHeight });
		node.style.display = "none";
	}, [document.index, document.status, panelId]);
	return (
		<div
			ref={nodeRef}
			data-message-document={panelId}
			data-message-status={document.status}
			style={{ height: "100%", overflow: "auto" }}
		>
			{document.messages.map((message) => (
				<p key={message.id}>{message.contentText}</p>
			))}
		</div>
	);
}

export function messageSnapshot() {
	return {
		parkedCommits: parkedMessageCommits.map((commit) => ({ ...commit })),
		requests: messageRequests.map((request) => ({ ...request })),
		documents: Object.entries(messageDocuments).map(([panelId, document]) => {
			const node = window.document.querySelector(`[data-message-document="${panelId}"]`);
			const panel = apiRef.current?.getPanel(panelId);
			return {
				panelId,
				...document,
				width: node?.clientWidth ?? 0,
				height: node?.clientHeight ?? 0,
				apiVisible: panel?.api.isVisible,
				apiActive: panel?.api.isActive,
				/** Dockview's own size for the panel; the always-rendered DOM can lag it. */
				apiWidth: panel?.api.width,
			};
		}),
	};
}

/** Exercise real zero-size CSS parking, independently of Dockview's visibility:hidden overlay. */
export function parkMessageViewport(panelId: string, parked: boolean) {
	const node = document.querySelector<HTMLElement>(`[data-message-document="${panelId}"]`);
	if (!messagesMode || !node) throw new Error("Message viewport is not mounted");
	node.style.display = parked ? "none" : "";
}

export function addMessageTab(panelId: string, narratorId: string) {
	if (!messagesMode) throw new Error("Message fixture mode is not enabled");
	return nativeDockviewApi().addPanel({
		id: panelId,
		component: "narrator",
		params: { panelType: "narrator", narratorId },
		title: narratorId,
		inactive: true,
		position: { referencePanel: "source-a", direction: "within" },
	});
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
				messagesMode ? (
					<DockviewNarratorPanelVisibilityProvider api={api}>
						<MessageDocumentProbe panelId={api.id} narratorId={params.narratorId} />
					</DockviewNarratorPanelVisibilityProvider>
				) : (
					body
				)
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
								if (new URLSearchParams(location.search).get("slots") === "3") {
									api.addPanel({
										id: "source-c",
										component: "narrator",
										params: { panelType: "narrator", narratorId: "narrator-c" },
										title: "Carol",
										position: { referencePanel: "source-b", direction: "right" },
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
