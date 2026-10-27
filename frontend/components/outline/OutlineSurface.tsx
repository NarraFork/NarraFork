/**
 * One outline page, or any block of one focused as a page: breadcrumbs, the live editor (or the
 * read-only block tree), a side panel with backlinks and history, and the timeline strip.
 *
 * A self-contained surface: everything it shows comes from its props, and everything that would
 * change them (focus, breadcrumbs, the view, the time) goes out through `onNavigate`; links
 * render through the host's link renderer (`outline-nav.tsx`). It never touches the router, so
 * the outline route (`routes/outline/$spaceId/$blockId.tsx`) and dock panels host it alike, and
 * several may be mounted in one tab: the same page twice shares one live session and one page
 * subscription (both keyed by page), while folding, selection and scroll stay per surface.
 *
 * The current page is the live editor (`OutlineEditor`): people who may write the space edit it
 * together, people who may only read it watch it change. The view as of a commit is the
 * read-only block tree, and so is a page live editing cannot take (too large, the socket is
 * unavailable, or the tab already has as many pages live as its socket takes). The side panel
 * and the timeline follow commits through the page subscription.
 *
 * Live only on screen: inside a dock panel that is not visible (a background tab, a Director
 * preview) the surface neither joins the page's live session nor subscribes to the page, and
 * shows the read-only tree; it joins again when shown (`live-sessions.ts` keeps a session a few
 * seconds after its last editor, so flicking between tabs is cheap). Hidden panels so take no
 * live slot of the socket and do not show their reader as present to others.
 *
 * Narrow (a phone, or a dock panel of 320–480 px): the side panel is a drawer, over the window on
 * a phone and inside the surface in a panel.
 */
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Drawer,
	Group,
	Loader,
	SegmentedControl,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useElementSize, useMediaQuery } from "@mantine/hooks";
import { titleOf } from "@shared/outline";
import type { OutlineViewMode } from "@shared/outline-api";
import { OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import { IconClock, IconLayoutSidebarRight } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineBlock, useOutlinePageLive } from "../../hooks/useOutline";
import { ApiError } from "../../lib/api";
import { forgetOutlineRecent, recordOutlineRecent } from "../../lib/outline-recents";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import { MANTINE_SM_BREAKPOINT_PX, MOBILE_VIEWPORT_MEDIA_QUERY } from "../../lib/responsive";
import { useNarratorPanelVisible } from "../narrator/narrator-panel-visibility";
import { OutlineEditor, type OutlineLiveUnavailable } from "./editor/OutlineEditor";
import classes from "./Outline.module.css";
import { OutlineBlockBody } from "./OutlineBlockBody";
import { OutlineBlockTree, OutlineTaskIcon } from "./OutlineBlockTree";
import { OutlineBreadcrumbs } from "./OutlineBreadcrumbs";
import { OutlineGate } from "./OutlineGate";
import { OutlineSidePanel } from "./OutlineSidePanel";
import { OutlineTimeline } from "./OutlineTimeline";
import {
	type OutlineLinkRenderer,
	OutlineNavProvider,
	type OutlineTarget,
	outlineBlockTarget,
} from "./outline-nav";
import { OutlineViewStates } from "./view-state";

export interface OutlineSurfaceProps {
	spaceId: string;
	/** The focused block (a page's own id shows the whole page). */
	blockId: string;
	/** Facts (the default) or all. */
	view?: OutlineViewMode;
	/** Commit seq to show the page as of (read only); absent for the current, live page. */
	asOf?: number;
	/** Focus, breadcrumb, view and time changes: the host decides what they do. */
	onNavigate: (to: OutlineTarget) => void;
	/** Renders links to other blocks and spaces; plain anchors calling `onNavigate` without. */
	renderLink?: OutlineLinkRenderer;
	/** Narrow layout (side panel as a drawer). Measured from the surface's width when absent. */
	compact?: boolean;
	/**
	 * `page`: the surface is the app's page (it fills the viewport's height; drawers cover the
	 * window). `panel`: it fills its container and scrolls inside it; drawers stay inside.
	 */
	layout?: "page" | "panel";
	/**
	 * Told what is shown once it has loaded (and again when it changes): a dock panel names its
	 * tab after it and remembers the page it is on.
	 */
	onLoaded?: (info: OutlineSurfaceLoaded) => void;
	/** The place could not be read (it does not exist, or the person may not read it). */
	onMissing?: () => void;
	/** The host's own controls, at the end of the toolbar (open beside, discuss in a session). */
	actions?: React.ReactNode;
}

/** What a surface shows, reported by `onLoaded`. */
export interface OutlineSurfaceLoaded {
	spaceId: string;
	spaceKey: string;
	pageId: string;
	/** The focused block (the page itself when the page is shown). */
	rootId: string;
	/** `key/sid` of the focused block. */
	address: string;
	/** Title of the focused block (or its short id when it has none). */
	title: string;
	/** Whether the person may edit the space. */
	canWrite: boolean;
}

export function OutlineSurface(props: OutlineSurfaceProps) {
	return (
		<OutlineNavProvider onNavigate={props.onNavigate} renderLink={props.renderLink}>
			<OutlineGate>
				<SurfaceBody {...props} />
			</OutlineGate>
		</OutlineNavProvider>
	);
}

function SurfaceBody({
	spaceId,
	blockId,
	view: viewMode,
	asOf,
	onNavigate,
	compact: compactProp,
	layout = "page",
	onLoaded,
	onMissing,
	actions,
}: OutlineSurfaceProps) {
	const { t } = useTranslation("outline");
	const mode: OutlineViewMode = viewMode ?? "facts";
	// The current page is edited live while on screen, unless live editing turned out
	// unavailable here.
	const onScreen = useNarratorPanelVisible();
	const [fallback, setFallback] = useState<OutlineLiveUnavailable | null>(null);
	const [hiddenLive, setHiddenLive] = useState(0);
	const editing = onScreen && asOf === undefined && fallback === null;
	// No room was left while on screen: try again the next time the panel is shown.
	useEffect(() => {
		if (!onScreen) setFallback((current) => (current === "tab_limit" ? null : current));
	}, [onScreen]);
	// While editing, the HTTP read only feeds the breadcrumbs, side panel and timeline.
	const query = useOutlineBlock(spaceId, blockId, {
		asOf,
		view: mode,
		...(editing ? { blocks: 1 } : {}),
	});
	const view = query.data;
	useOutlinePageLive(onScreen ? view : undefined);
	const pageId = view?.pageId;
	useEffect(() => {
		if (pageId) setFallback(null);
	}, [pageId]);

	// Folding, caret and block selection of each page this surface showed: its own, not shared
	// with another surface on the same page.
	const [viewStates] = useState(() => new OutlineViewStates());
	const viewState = pageId ? viewStates.of(pageId) : null;
	const [foldVersion, bumpFold] = useReducer((n: number) => n + 1, 0);
	useEffect(
		() =>
			viewState?.on((part) => {
				if (part === "collapsed") bumpFold();
			}),
		[viewState],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: foldVersion says the set changed
	const collapsed = useMemo<ReadonlySet<string>>(
		() => new Set(viewState?.collapsed ?? []),
		[viewState, foldVersion],
	);
	const toggle = useCallback((id: string) => viewState?.toggleCollapsed(id), [viewState]);

	const mobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const { ref: surfaceRef, width } = useElementSize();
	const compact = compactProp ?? (width > 0 ? width < MANTINE_SM_BREAKPOINT_PX : mobile);
	const [sideOpen, setSideOpen] = useState<boolean | null>(null);
	const showSide = sideOpen ?? !compact;

	const go = useCallback(
		(patch: { blockId?: string; view?: OutlineViewMode; asOf?: number | undefined }) =>
			onNavigate(
				outlineBlockTarget(
					spaceId,
					patch.blockId ?? blockId,
					"view" in patch ? patch.view : mode,
					"asOf" in patch ? patch.asOf : asOf,
				),
			),
		[onNavigate, spaceId, blockId, mode, asOf],
	);
	const linkSearch = useMemo<OutlineBlockSearch>(
		() => ({
			...(asOf !== undefined ? { asOf } : {}),
			...(viewMode && viewMode !== "facts" ? { view: viewMode } : {}),
		}),
		[asOf, viewMode],
	);

	const root = view?.blocks.find((block) => block.id === view.rootId);
	const rootTitle = root ? titleOf(root.content) || root.sid : "";

	// Remember pages actually opened (their current state), and forget ones that are gone.
	const missing = query.error instanceof ApiError && query.error.status === 404;
	useEffect(() => {
		if (view?.current && root) {
			recordOutlineRecent({ spaceId, blockId, title: rootTitle, visitedAt: Date.now() });
		}
	}, [view?.current, root, spaceId, blockId, rootTitle]);
	useEffect(() => {
		if (missing && asOf === undefined) forgetOutlineRecent(blockId);
	}, [missing, asOf, blockId]);
	useEffect(() => {
		if (missing) onMissing?.();
	}, [missing, onMissing]);
	const loadedSpaceKey = view?.space.key;
	const loadedCanWrite = view?.space.canWrite === true;
	const rootSid = root?.sid;
	useEffect(() => {
		if (!onLoaded || !pageId || !loadedSpaceKey || !rootSid) return;
		onLoaded({
			spaceId,
			spaceKey: loadedSpaceKey,
			pageId,
			rootId: blockId,
			address: `${loadedSpaceKey}/${rootSid}`,
			title: rootTitle,
			canWrite: loadedCanWrite,
		});
	}, [onLoaded, spaceId, blockId, pageId, loadedSpaceKey, rootSid, rootTitle, loadedCanWrite]);

	let content: React.ReactNode;
	let drawer: React.ReactNode = null;
	if (query.isLoading) {
		content = <Loader size="sm" />;
	} else if (!view || !root || !viewState) {
		content = (
			<Alert color={missing ? "gray" : "red"} variant="light">
				{t(missing ? (asOf !== undefined ? "notAtTime" : "notFound") : "loadFailed")}
				{missing && asOf !== undefined && (
					<Button
						size="compact-xs"
						variant="subtle"
						ml="xs"
						onClick={() => go({ asOf: undefined })}
					>
						{t("page.backToCurrent")}
					</Button>
				)}
			</Alert>
		);
	} else {
		const sidePanel = (
			<OutlineSidePanel view={view} search={linkSearch} onViewAt={(seq) => go({ asOf: seq })} />
		);
		if (compact) {
			drawer = (
				<Drawer
					opened={showSide}
					onClose={() => setSideOpen(false)}
					position="bottom"
					size="70%"
					title={rootTitle}
					// In a panel the drawer covers the surface, not the window, and leaves the rest
					// of the window (a composer beside it) scrolling and typing.
					{...(layout === "panel"
						? {
								withinPortal: false,
								lockScroll: false,
								styles: {
									overlay: { position: "absolute" },
									inner: { position: "absolute" },
								},
							}
						: {})}
				>
					{sidePanel}
				</Drawer>
			);
		}
		content = (
			<>
				<div className={classes.toolbar}>
					<OutlineBreadcrumbs view={view} rootTitle={rootTitle} search={linkSearch} />
					<Group gap="xs" wrap="nowrap">
						<SegmentedControl
							size="xs"
							value={view.view}
							onChange={(value) => go({ view: value as OutlineViewMode })}
							data={[
								{ value: "facts", label: t("page.view.facts") },
								{ value: "all", label: t("page.view.all") },
							]}
							aria-label={t("page.viewLabel")}
						/>
						<Tooltip label={t("page.sidePanel")}>
							<ActionIcon
								variant={showSide ? "light" : "subtle"}
								color="gray"
								aria-label={t("page.sidePanel")}
								aria-pressed={showSide}
								onClick={() => setSideOpen(!showSide)}
							>
								<IconLayoutSidebarRight size={18} />
							</ActionIcon>
						</Tooltip>
						{actions}
					</Group>
				</div>

				{!view.current && (
					<Alert
						variant="light"
						color="indigo"
						icon={<IconClock size={16} />}
						py={6}
						styles={{
							message: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
						}}
					>
						<Text size="sm">{t("page.asOfBanner", { seq: view.seq })}</Text>
						<Button size="compact-xs" variant="light" onClick={() => go({ asOf: undefined })}>
							{t("page.backToCurrent")}
						</Button>
					</Alert>
				)}
				{view.pageTruncated && (
					<Alert variant="light" color="yellow" py={6}>
						{t("page.truncated")}
					</Alert>
				)}

				<div className={`${classes.body} ${showSide && !compact ? classes.bodyWithSide : ""}`}>
					<Box className={classes.main}>
						{fallback === "too_large" && (
							<Alert variant="light" color="yellow" py={6} mb="xs">
								{t("editor.tooLargePage")}
							</Alert>
						)}
						{fallback === "tab_limit" && (
							<Alert variant="light" color="gray" py={6} mb="xs" data-testid="outline-tab-limit">
								<Group gap="xs" wrap="wrap">
									<Text size="sm">
										{t("editor.tabLimit", { count: OUTLINE_LIVE_LIMITS.sessionsPerSocket })}
									</Text>
									<Button size="compact-xs" variant="light" onClick={() => setFallback(null)}>
										{t("editor.retry")}
									</Button>
								</Group>
							</Alert>
						)}
						{fallback !== null &&
							fallback !== "too_large" &&
							fallback !== "access_denied" &&
							fallback !== "tab_limit" && (
								<Alert variant="light" color="gray" py={6} mb="xs">
									<Group gap="xs" wrap="wrap">
										<Text size="sm">{t("editor.unavailable")}</Text>
										<Button size="compact-xs" variant="light" onClick={() => setFallback(null)}>
											{t("editor.retry")}
										</Button>
									</Group>
								</Alert>
							)}
						{editing && view.current ? (
							<OutlineEditor
								pageId={view.pageId}
								focusId={view.rootId}
								spaceKey={view.space.key}
								canWrite={view.space.canWrite}
								lens={mode}
								viewState={viewState}
								onFocus={(id) => go({ blockId: id })}
								onUnavailable={setFallback}
								onHiddenChange={setHiddenLive}
							/>
						) : (
							<>
								<Group gap={6} wrap="nowrap" align="flex-start" mb="xs">
									{root.task && <OutlineTaskIcon status={root.task.status} />}
									<Title order={3} className={classes.rootTitle}>
										{rootTitle}
									</Title>
								</Group>
								{root.content.trim() !== rootTitle && (
									<Box className={classes.content} mb="xs">
										<OutlineBlockBody content={root.content} />
									</Box>
								)}
								<OutlineBlockTree
									view={view}
									collapsed={collapsed}
									search={linkSearch}
									onToggle={toggle}
								/>
							</>
						)}
						{view.view === "facts" && (editing ? hiddenLive : view.hiddenByView) > 0 && (
							<Text size="xs" c="dimmed" mt="sm">
								{t("page.processHidden", {
									count: editing ? hiddenLive : view.hiddenByView,
								})}{" "}
								<Button size="compact-xs" variant="subtle" onClick={() => go({ view: "all" })}>
									{t("page.showAll")}
								</Button>
							</Text>
						)}
					</Box>
					{showSide && !compact && <Box className={classes.side}>{sidePanel}</Box>}
				</div>

				<OutlineTimeline view={view} asOf={asOf} onSelect={(seq) => go({ asOf: seq })} />
			</>
		);
	}

	return (
		<div
			ref={surfaceRef}
			className={classes.surface}
			data-layout={layout}
			data-compact={compact || undefined}
			data-testid="outline-surface"
		>
			<Box className={classes.page}>{content}</Box>
			{drawer}
		</div>
	);
}
