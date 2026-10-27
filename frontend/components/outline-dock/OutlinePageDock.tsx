/**
 * The outline page as a dock: the page (whatever the URL names) is the main panel, and sessions
 * and other outline panels open beside it.
 *
 *   - An agent's commit in the timeline opens the session that wrote it, when the person can
 *     read that session.
 *   - "Discuss this page in a session" picks a recent session of the space or starts one, and
 *     puts a link to the page in its composer.
 *   - A menu lists the space's recent sessions.
 *   - Outline links in the sessions, and Ctrl/Cmd-clicks in the page, open outline panels here.
 *
 * Session panels are the real session view (`NarratorPanel`) with no session dock around it: its
 * own tools open in its drawers, as in a detached session window. The layout is remembered per
 * person in this browser (`outline-page-layout.ts`).
 *
 * On a phone there is no dock: the page is the page, and opening a session goes to the session
 * (Back returns here); the two cannot share a phone's width.
 */
import { Box, Center, Loader, Text } from "@mantine/core";
import type { OutlineSpaceDetail } from "@shared/outline-api";
import { useNavigate } from "@tanstack/react-router";
import type {
	DockviewApi,
	IDockviewPanel,
	IDockviewPanelHeaderProps,
	IDockviewPanelProps,
} from "dockview-react";
import {
	createContext,
	lazy,
	type MouseEvent,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useMobileViewport } from "../../hooks/useMobileViewport";
import { useNarrator } from "../../hooks/useNarrator";
import { useOutlineEnabled, useOutlineSpace } from "../../hooks/useOutline";
import { requestComposerAppend } from "../../lib/composer-append-queue";
import { outlineTargetUrl } from "../../lib/outline-href";
import {
	isOpenClick,
	type OutlineOpener,
	OutlineOpenerProvider,
	type OutlineOpenOptions,
	wantsNewPanel,
} from "../../lib/outline-opener";
import {
	nextOutlinePanelId,
	normalizeOutlinePanelState,
	type OutlinePanelState,
} from "../../lib/outline-panel";
import { outlineRouterLink } from "../../lib/outline-router";
import { DockviewSurface } from "../dockview";
import { NarratorDockContext } from "../narrator/dock/NarratorDockContext";
import { OutlineDockPanel } from "../narrator/dock/OutlineDockPanel";
import { findOutlinePanel, navigateOutlinePanel } from "../narrator/dock/outline-dock";
import { DockviewNarratorPanelVisibilityProvider } from "../narrator/narrator-panel-visibility";
import type { OutlinePanelParams } from "../narrator/panels/panel-kind";
import {
	usePanelCompact,
	usePanelGeometryReady,
	usePanelHeaderDrag,
} from "../narrator/panels/shared";
import { OutlineSurface, type OutlineSurfaceLoaded } from "../outline/OutlineSurface";
import { OutlineHostProvider } from "../outline/outline-host";
import type { OutlineLinkProps, OutlineTarget } from "../outline/outline-nav";
import {
	applyOutlinePageDock,
	OUTLINE_PAGE_COMPONENTS,
	OUTLINE_PAGE_MAIN_ID,
	saveOutlinePageDock,
} from "./outline-page-layout";
import {
	DiscussPageButton,
	OutlinePageSessionsMenu,
	outlinePageReference,
} from "./outline-page-sessions";

const NarratorPanel = lazy(() =>
	import("../narrator/NarratorPanel").then((m) => ({ default: m.NarratorPanel })),
);

const SAVE_DEBOUNCE_MS = 400;

export interface OutlinePageRoute {
	spaceId: string;
	blockId: string;
	view?: "facts" | "all";
	asOf?: number;
	onNavigate: (to: OutlineTarget) => void;
}

/** What the main panel needs from the route and the dock. */
interface OutlinePageDockState extends OutlinePageRoute {
	space: OutlineSpaceDetail | undefined;
	openSession: (narratorId: string) => void;
	discuss: (narratorId: string) => void;
	openOutline: (state: OutlinePanelState, options?: OutlineOpenOptions) => boolean;
	onLoaded: (info: OutlineSurfaceLoaded) => void;
	/** The page the URL names has loaded, so "discuss" can name it. */
	discussReady: boolean;
}

const OutlinePageDockContext = createContext<OutlinePageDockState | null>(null);

interface NarratorPanelParams {
	panelType: "narrator";
	narratorId: string;
}

/** The page's own links: real router links; Ctrl/Cmd-click opens the target beside it. */
function useMainLinkRenderer(
	openOutline: (state: OutlinePanelState, options?: OutlineOpenOptions) => boolean,
) {
	const openRef = useRef(openOutline);
	openRef.current = openOutline;
	return useCallback(({ to, onClick, ...rest }: OutlineLinkProps) => {
		const handle = (event: MouseEvent<HTMLAnchorElement>) => {
			onClick?.(event);
			if (!isOpenClick(event) || !wantsNewPanel(event)) return;
			event.preventDefault();
			const state: OutlinePanelState =
				to.kind === "home"
					? {}
					: to.kind === "space"
						? { spaceId: to.spaceId }
						: {
								spaceId: to.spaceId,
								blockId: to.blockId,
								...(to.view === "all" ? { view: "all" as const } : {}),
								...(to.asOf !== undefined ? { asOf: to.asOf } : {}),
							};
			openRef.current(state, { newPanel: true });
		};
		return outlineRouterLink({ ...rest, to, onClick: handle });
	}, []);
}

function OutlineMainPanel(props: IDockviewPanelProps) {
	const { t } = useTranslation("outline");
	const page = useContext(OutlinePageDockContext);
	const [title, setTitle] = useState<string | null>(null);
	const onLoaded = page?.onLoaded;
	const handleLoaded = useCallback(
		(info: OutlineSurfaceLoaded) => {
			setTitle(info.title || info.address);
			onLoaded?.(info);
		},
		[onLoaded],
	);
	const tabTitle = title ?? t("title");
	useLayoutEffect(() => {
		if (props.api.title !== tabTitle) props.api.setTitle(tabTitle);
	}, [props.api, tabTitle]);
	const forget = useCallback(() => setTitle(null), []);
	const renderLink = useMainLinkRenderer(page?.openOutline ?? (() => false));
	if (!page) return null;
	return (
		<Box h="100%" style={{ overflow: "hidden" }} data-testid="outline-page-main">
			{/* Live while on screen: a session dragged into the page's group hides it. */}
			<DockviewNarratorPanelVisibilityProvider api={props.api}>
				<OutlineSurface
					spaceId={page.spaceId}
					blockId={page.blockId}
					view={page.view}
					asOf={page.asOf}
					onNavigate={page.onNavigate}
					renderLink={renderLink}
					layout="panel"
					onLoaded={handleLoaded}
					onMissing={forget}
					actions={
						<>
							<OutlinePageSessionsMenu space={page.space} onOpen={page.openSession} />
							<DiscussPageButton
								space={page.space}
								onPick={page.discuss}
								disabled={!page.discussReady}
							/>
						</>
					}
				/>
			</DockviewNarratorPanelVisibilityProvider>
		</Box>
	);
}

/** A session beside the page: the real session view, its tools in its own drawers. */
function OutlinePageNarratorPanel(props: IDockviewPanelProps<NarratorPanelParams>) {
	const { narratorId } = props.params;
	const { ref: compactRef, compact } = usePanelCompact();
	const { ref, geometryReady } = usePanelGeometryReady(compactRef);
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(props, narratorId);
	const { data } = useNarrator(narratorId);
	const title = ((data as { title?: string } | undefined)?.title ?? "").trim();
	useLayoutEffect(() => {
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [title, props.api]);
	return (
		<Box ref={ref} style={{ height: "100%", overflow: "hidden" }}>
			{geometryReady && (
				<NarratorDockContext.Provider value={null}>
					<DockviewNarratorPanelVisibilityProvider api={props.api}>
						<Suspense
							fallback={
								<Center h="100%">
									<Loader size="sm" />
								</Center>
							}
						>
							<NarratorPanel
								key={narratorId}
								narratorId={narratorId}
								compact={compact}
								onClose={close}
								onHeaderPointerDown={onHeaderPointerDown}
							/>
						</Suspense>
					</DockviewNarratorPanelVisibilityProvider>
				</NarratorDockContext.Provider>
			)}
		</Box>
	);
}

/** The main panel's tab: its title only, no close (the page is the protagonist). */
function MainTab(props: IDockviewPanelHeaderProps) {
	const [title, setTitle] = useState(props.api.title ?? "");
	useEffect(() => {
		const disposable = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
		return () => disposable.dispose();
	}, [props.api]);
	return (
		<Box px="sm" style={{ display: "flex", alignItems: "center", height: "100%" }}>
			<Text size="xs" fw={600} truncate>
				{title}
			</Text>
		</Box>
	);
}

const dockComponents = {
	[OUTLINE_PAGE_COMPONENTS.main]: OutlineMainPanel,
	[OUTLINE_PAGE_COMPONENTS.outline]: OutlineDockPanel as React.FunctionComponent<
		IDockviewPanelProps<OutlinePanelParams>
	>,
	[OUTLINE_PAGE_COMPONENTS.narrator]: OutlinePageNarratorPanel,
	// biome-ignore lint/suspicious/noExplicitAny: dockview panel registry is heterogeneous
} satisfies Record<string, React.FunctionComponent<IDockviewPanelProps<any>>>;

const tabComponents = { [OUTLINE_PAGE_COMPONENTS.main]: MainTab };

/** Where a new panel goes: as a tab beside the other side panels, or split right of the page. */
function sidePosition(api: DockviewApi) {
	const side = api.panels.find((panel) => panel.id !== OUTLINE_PAGE_MAIN_ID);
	if (side) return { referenceGroup: side.group };
	return { referencePanel: OUTLINE_PAGE_MAIN_ID, direction: "right" as const };
}

function sideWidth(api: DockviewApi): number | undefined {
	const side = api.panels.find((panel) => panel.id !== OUTLINE_PAGE_MAIN_ID);
	return side ? undefined : Math.max(360, Math.round(api.width * 0.42));
}

export function OutlinePageDock(route: OutlinePageRoute) {
	const isMobile = useMobileViewport();
	const { enabled, loading } = useOutlineEnabled();
	// Off (or not known yet): the plain surface, which says the outline is off.
	if (isMobile || loading || !enabled) return <OutlinePagePlain {...route} />;
	return <OutlinePageDockSurface {...route} />;
}

/** The page alone (a phone, or the outline off): opening a session goes to the session. */
function OutlinePagePlain(route: OutlinePageRoute) {
	// Off, the outline routes answer 404: do not ask.
	const space = useOutlineSpace(route.spaceId, useOutlineEnabled().enabled).data?.space;
	const [loaded, setLoaded] = useState<OutlineSurfaceLoaded | null>(null);
	const current = loadedPageOf(route, loaded);
	const goToSession = useGoToSession();
	const discuss = useCallback(
		(narratorId: string) => {
			if (current) requestComposerAppend(narratorId, referenceTo(current));
			goToSession(narratorId);
		},
		[current, goToSession],
	);
	return (
		<OutlineHostProvider openSession={goToSession}>
			<OutlineSurface
				spaceId={route.spaceId}
				blockId={route.blockId}
				view={route.view}
				asOf={route.asOf}
				onNavigate={route.onNavigate}
				renderLink={outlineRouterLink}
				onLoaded={setLoaded}
				actions={
					space ? (
						<>
							<OutlinePageSessionsMenu space={space} onOpen={goToSession} />
							<DiscussPageButton space={space} onPick={discuss} disabled={!current} />
						</>
					) : null
				}
			/>
		</OutlineHostProvider>
	);
}

/** Go to a session (the phone's way to open one; Back returns to the page). */
function useGoToSession(): (narratorId: string) => void {
	const navigate = useNavigate();
	return useCallback(
		(narratorId: string) => void navigate({ to: "/narrators/$narratorId", params: { narratorId } }),
		[navigate],
	);
}

/** What the surface has loaded, if it is the place the URL names now (not the previous one). */
function loadedPageOf(
	route: OutlinePageRoute,
	loaded: OutlineSurfaceLoaded | null,
): OutlineSurfaceLoaded | null {
	return loaded && loaded.spaceId === route.spaceId && loaded.rootId === route.blockId
		? loaded
		: null;
}

/** The reference to a loaded place: its address, title and URL all from the same load. */
function referenceTo(loaded: OutlineSurfaceLoaded): string {
	return outlinePageReference({
		address: loaded.address,
		title: loaded.title,
		url: outlineTargetUrl({ kind: "block", spaceId: loaded.spaceId, blockId: loaded.rootId }),
	});
}

function OutlinePageDockSurface(route: OutlinePageRoute) {
	const { data: user } = useCurrentUser();
	const userId = user?.id ? String(user.id) : null;
	const space = useOutlineSpace(route.spaceId).data?.space;
	const apiRef = useRef<DockviewApi | null>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const disposables = useRef<Array<{ dispose(): void }>>([]);
	const [loaded, setLoaded] = useState<OutlineSurfaceLoaded | null>(null);
	const current = loadedPageOf(route, loaded);
	const currentRef = useRef(current);
	currentRef.current = current;

	const openSession = useCallback((narratorId: string) => {
		const api = apiRef.current;
		if (!api || !narratorId) return;
		const existing = api.panels.find(
			(panel) =>
				(panel.params as { panelType?: string; narratorId?: string } | undefined)?.narratorId ===
					narratorId &&
				(panel.params as { panelType?: string }).panelType === OUTLINE_PAGE_COMPONENTS.narrator,
		);
		if (existing) {
			existing.api.setActive();
			return;
		}
		api.addPanel<NarratorPanelParams>({
			id: `onarrator-${narratorId}`,
			component: OUTLINE_PAGE_COMPONENTS.narrator,
			params: { panelType: "narrator", narratorId },
			position: sidePosition(api),
			...(sideWidth(api) ? { initialWidth: sideWidth(api) } : {}),
		});
	}, []);

	const openOutline = useCallback(
		(state: OutlinePanelState, options: OutlineOpenOptions = {}): boolean => {
			const api = apiRef.current;
			if (!api) return false;
			const existing = options.newPanel
				? undefined
				: findOutlinePanel(
						api.panels,
						state,
						(panel: IDockviewPanel) => panel.id !== OUTLINE_PAGE_MAIN_ID,
					);
			if (existing) {
				navigateOutlinePanel(existing, state);
				existing.api.setActive();
				return true;
			}
			api.addPanel<OutlinePanelParams>({
				id: nextOutlinePanelId("odock-outline-"),
				component: OUTLINE_PAGE_COMPONENTS.outline,
				params: { panelType: "outline", ...normalizeOutlinePanelState(state) },
				...(state.title ? { title: state.title } : {}),
				position: sidePosition(api),
				...(sideWidth(api) ? { initialWidth: sideWidth(api) } : {}),
			});
			return true;
		},
		[],
	);
	const opener = useMemo<OutlineOpener>(() => ({ open: openOutline }), [openOutline]);

	const onLoaded = useCallback((info: OutlineSurfaceLoaded) => setLoaded(info), []);
	const discuss = useCallback(
		(narratorId: string) => {
			const page = currentRef.current;
			if (page) requestComposerAppend(narratorId, referenceTo(page));
			openSession(narratorId);
		},
		[openSession],
	);

	const persist = useCallback(() => {
		if (!userId) return;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			const api = apiRef.current;
			if (api) saveOutlinePageDock(api, userId);
		}, SAVE_DEBOUNCE_MS);
	}, [userId]);

	const handleReady = useCallback(
		(api: DockviewApi) => {
			apiRef.current = api;
			applyOutlinePageDock(api, userId);
			disposables.current = [api.onDidLayoutChange(persist)];
		},
		[userId, persist],
	);

	useEffect(
		() => () => {
			if (saveTimer.current) clearTimeout(saveTimer.current);
			const api = apiRef.current;
			if (api && userId) saveOutlinePageDock(api, userId);
			for (const disposable of disposables.current) disposable.dispose();
			disposables.current = [];
		},
		[userId],
	);

	const state = useMemo<OutlinePageDockState>(
		() => ({
			...route,
			space,
			openSession,
			discuss,
			openOutline,
			onLoaded,
			discussReady: current !== null,
		}),
		[route, space, openSession, discuss, openOutline, onLoaded, current],
	);

	// The user is needed to know whose layout to restore; wait for it.
	if (!user) {
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	}
	return (
		<OutlinePageDockContext.Provider value={state}>
			<OutlineOpenerProvider value={opener}>
				<OutlineHostProvider openSession={openSession}>
					<DockviewSurface
						apiRef={apiRef}
						components={dockComponents}
						tabComponents={tabComponents}
						onReady={handleReady}
						surfaceId="outline-page"
						defaultRenderer="always"
					/>
				</OutlineHostProvider>
			</OutlineOpenerProvider>
		</OutlinePageDockContext.Provider>
	);
}
