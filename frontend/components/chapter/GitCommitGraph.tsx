import {
	ActionIcon,
	Box,
	Button,
	Group,
	Loader,
	ScrollArea,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitLog, useGitStatus } from "../../hooks/useGit";
import { useGitGraphCollapsed } from "../../hooks/useGitGraphCollapsed";
import {
	GIT_GRAPH_HEIGHT_MAX,
	GIT_GRAPH_HEIGHT_MIN,
	startGitGraphHeightResize,
	useGitGraphHeight,
} from "../../hooks/useGitGraphHeight";
import { api } from "../../lib/api";
import { type GitLogEntry, type GitTarget, gitBasePath, gitTargetKey } from "../../lib/api/git";
import { buildCommitPreviewBrowserHref } from "../../lib/git-commit-preview-navigation";
import { GitCommitDetailModal } from "./GitCommitDetailModal";
import {
	buildRowCircles,
	buildRowSvgPaths,
	GRAPH_COMMIT_CAP,
	GRAPH_PAGE_SIZE,
	GRAPH_ROW_HEIGHT,
	graphRowWidth,
	layoutCommitGraph,
} from "./git-graph-layout";

const MESSAGE_CLAMP = 200;

function clampMessage(message: string): string {
	if (message.length <= MESSAGE_CLAMP) return message;
	return `${message.slice(0, MESSAGE_CLAMP)}…`;
}

/**
 * Minimum height left to the changes list above, so dragging the graph taller can
 * never squeeze the list it belongs to down to nothing.
 *
 * The cap applies to the DRAG as well as the render: a drag that kept accepting
 * input past the visible limit would feel broken (the handle moves, nothing
 * happens), so the stored preference is what the user actually saw. The render
 * still clamps independently, because the host can shrink after the fact.
 */
const MIN_SIBLING_HEIGHT = 140;

/** Header row (chevron + label + refresh) — excluded from the resizable body. */
const GRAPH_HEADER_HEIGHT = 34;

/**
 * Collapsible repository commit-graph strip under the Git changes list.
 *
 * The first page shares React Query invalidation with other Git views. Extra
 * pages are local and belong to one first-page revision and workspace only.
 */
export function GitCommitGraph({
	target,
	headSha: headShaProp,
}: {
	target: GitTarget;
	headSha?: string;
}) {
	const { t } = useTranslation("git");
	const { collapsed, toggle } = useGitGraphCollapsed(target);
	const { height: panelHeight, setHeight: setPanelHeight } = useGitGraphHeight(target);
	const workspaceKey = gitTargetKey(target) ?? "";
	const previewTargetKey = JSON.stringify([gitBasePath(target), workspaceKey]);
	const [preview, setPreview] = useState<{ sha: string; targetKey: string } | null>(null);
	const previewSha = preview?.targetKey === previewTargetKey ? preview.sha : null;
	useEffect(() => {
		setPreview((current) => (current?.targetKey === previewTargetKey ? current : null));
	}, [previewTargetKey]);
	const statusQuery = useGitStatus(target);
	const headSha = headShaProp ?? statusQuery.data?.headSha;

	const [commits, setCommits] = useState<GitLogEntry[]>([]);
	/**
	 * Whether the LAST page came back full.
	 *
	 * This — not `loaded === pages × pageSize` — is what says "there may be more".
	 * A short page (history capped by `--max-count`, or a repo with fewer commits
	 * than one page) means the end was reached, and deriving the answer from the
	 * loaded count made the button vanish or persist by arithmetic coincidence.
	 */
	const [lastPageFull, setLastPageFull] = useState(false);
	const logQuery = useGitLog(target, GRAPH_PAGE_SIZE, 0, !collapsed);
	const [paginationLoading, setPaginationLoading] = useState(false);
	const [manualRefreshing, setManualRefreshing] = useState(false);
	const [pageError, setPageError] = useState<string | null>(null);
	const generation = useRef(0);
	const pageRequest = useRef<AbortController | null>(null);
	const manualRequest = useRef<object | null>(null);
	const loadedWorkspaceRef = useRef<string | null>(null);
	/** Height available to this whole strip, measured from the flex parent. */
	const [availableHeight, setAvailableHeight] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Identity, not the target object's reference, owns requests. A refreshed first
	// page also invalidates offsets from the previous history, even if equal by value.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Request lifecycle boundaries invalidate local pagination.
	useEffect(() => {
		generation.current += 1;
		pageRequest.current?.abort();
		pageRequest.current = null;
		setPaginationLoading(false);
		setPageError(null);
		return () => {
			generation.current += 1;
			pageRequest.current?.abort();
			pageRequest.current = null;
		};
	}, [workspaceKey, collapsed, logQuery.dataUpdatedAt, logQuery.isFetching]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Equal first pages still reset pagination after a successful refresh.
	useEffect(() => {
		if (loadedWorkspaceRef.current !== workspaceKey) {
			loadedWorkspaceRef.current = workspaceKey;
			manualRequest.current = null;
			setManualRefreshing(false);
		}
		const firstPage = logQuery.data ?? [];
		setCommits(firstPage);
		setLastPageFull(firstPage.length >= GRAPH_PAGE_SIZE);
	}, [workspaceKey, logQuery.data, logQuery.dataUpdatedAt]);

	const loading = logQuery.isFetching || paginationLoading;
	const error = pageError ?? (logQuery.error ? String(logQuery.error.message) : null);

	// The strip sits in a flex column next to the changes list, and the persisted
	// height is a plain number with no knowledge of the host. Measure the parent so a
	// 560px preference inside a 400px dock panel cannot crush its sibling.
	useEffect(() => {
		const parent = rootRef.current?.parentElement;
		if (!parent || typeof ResizeObserver === "undefined") return;
		const read = () => setAvailableHeight(parent.clientHeight || null);
		read();
		const observer = new ResizeObserver(read);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	const loadMore = useCallback(async () => {
		if (!target || !workspaceKey || collapsed || loading || pageRequest.current) return;
		const offset = commits.length;
		if (offset >= GRAPH_COMMIT_CAP) return;
		const request = new AbortController();
		const requestGeneration = generation.current;
		pageRequest.current = request;
		const isCurrent = () =>
			pageRequest.current === request && generation.current === requestGeneration;
		setPaginationLoading(true);
		setPageError(null);
		try {
			const page = await api.getGitLog(target, GRAPH_PAGE_SIZE, offset, request.signal);
			if (!isCurrent()) return;
			const rows = Array.isArray(page) ? page : [];
			setCommits((prev) => [...prev, ...rows]);
			setLastPageFull(rows.length >= GRAPH_PAGE_SIZE);
		} catch (err) {
			if (isCurrent()) setPageError(err instanceof Error ? err.message : String(err));
		} finally {
			if (isCurrent()) {
				pageRequest.current = null;
				setPaginationLoading(false);
			}
		}
	}, [commits.length, loading, target, workspaceKey, collapsed]);

	const refresh = useCallback(async () => {
		if (!target || !workspaceKey || collapsed || manualRequest.current) return;
		const request = {};
		manualRequest.current = request;
		generation.current += 1;
		pageRequest.current?.abort();
		pageRequest.current = null;
		setPaginationLoading(false);
		setManualRefreshing(true);
		try {
			await logQuery.refetch();
		} finally {
			if (manualRequest.current === request) {
				manualRequest.current = null;
				setManualRefreshing(false);
			}
		}
	}, [target, workspaceKey, collapsed, logQuery.refetch]);

	const rows = useMemo(() => layoutCommitGraph(commits, headSha), [commits, headSha]);
	const topologyUnknown = useMemo(
		() => commits.length > 0 && commits.some((commit) => commit.parents === undefined),
		[commits],
	);
	const atCap = commits.length >= GRAPH_COMMIT_CAP;
	const canLoadMore = !loading && !error && !atCap && lastPageFull;
	// Never below the floor: a host too short for both panes still gets a usable strip
	// rather than a zero-height one.
	const effectiveMaxHeight = Math.max(
		GIT_GRAPH_HEIGHT_MIN,
		Math.min(
			GIT_GRAPH_HEIGHT_MAX,
			availableHeight == null
				? GIT_GRAPH_HEIGHT_MAX
				: availableHeight - GRAPH_HEADER_HEIGHT - MIN_SIBLING_HEIGHT,
		),
	);
	const bodyHeight = Math.min(panelHeight, effectiveMaxHeight);
	return (
		<Box
			ref={rootRef}
			style={{
				flexShrink: 0,
				borderTop: "1px solid var(--mantine-color-default-border)",
			}}
		>
			{/* Invisible hit area on the section border; drag it like a normal splitter. */}
			{!collapsed && (
				<Box
					role="separator"
					aria-orientation="horizontal"
					aria-label={t("panel.graphResize")}
					// Reports the height actually in effect, and the ceiling actually
					// reachable in this host — an assistive reader must not be told it can
					// grow to 560 when the panel physically stops at 260.
					aria-valuenow={bodyHeight}
					aria-valuemin={GIT_GRAPH_HEIGHT_MIN}
					aria-valuemax={effectiveMaxHeight}
					tabIndex={0}
					style={{
						height: 6,
						marginTop: -3,
						cursor: "ns-resize",
						background: "transparent",
						touchAction: "none",
					}}
					onPointerDown={(event) => {
						startGitGraphHeightResize(
							{
								clientY: event.clientY,
								pointerId: event.pointerId,
								preventDefault: () => event.preventDefault(),
							},
							{
								workspaceKey,
								startHeight: bodyHeight,
								setHeight: setPanelHeight,
								maxHeight: effectiveMaxHeight,
							},
						);
					}}
					onKeyDown={(event) => {
						const clampToHost = (value: number) => Math.min(value, effectiveMaxHeight);
						if (event.key === "ArrowUp") {
							event.preventDefault();
							setPanelHeight(clampToHost(bodyHeight + 24));
						} else if (event.key === "ArrowDown") {
							event.preventDefault();
							setPanelHeight(bodyHeight - 24);
						} else if (event.key === "Home") {
							event.preventDefault();
							setPanelHeight(GIT_GRAPH_HEIGHT_MIN);
						} else if (event.key === "End") {
							event.preventDefault();
							setPanelHeight(effectiveMaxHeight);
						}
					}}
				/>
			)}
			<Group
				wrap="nowrap"
				gap={6}
				px="xs"
				py={6}
				style={{ cursor: "pointer", userSelect: "none" }}
				onClick={toggle}
				aria-label={collapsed ? t("panel.graphExpand") : t("panel.graphCollapse")}
				role="button"
				tabIndex={0}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						toggle();
					}
				}}
			>
				{collapsed ? (
					<IconChevronRight size={14} aria-hidden />
				) : (
					<IconChevronDown size={14} aria-hidden />
				)}
				<Text size="sm" fw={600}>
					{t("panel.graph")}
				</Text>
				<Box style={{ flex: 1 }} />
				<ActionIcon
					variant="subtle"
					size="sm"
					aria-label={t("panel.graphRefresh")}
					// A refresh in flight is visible on the control itself, and the control
					// is disabled while it runs: the body keeps the previous page on screen
					// (deliberately — blanking it makes the strip jump), so without this the
					// click had no observable effect at all.
					loading={manualRefreshing}
					disabled={manualRefreshing}
					onClick={(event) => {
						event.stopPropagation();
						refresh();
					}}
				>
					<IconRefresh size={14} />
				</ActionIcon>
			</Group>
			{!collapsed && (
				<ScrollArea style={{ height: bodyHeight, minHeight: 0 }}>
					{loading && commits.length === 0 ? (
						<Group justify="center" py="md">
							<Loader size="sm" />
						</Group>
					) : error ? (
						<Box px="xs" py="xs">
							<Text size="xs" c="red" mb={4}>
								{error}
							</Text>
							<Button size="compact-xs" variant="light" onClick={refresh}>
								{t("workspace.retry")}
							</Button>
						</Box>
					) : rows.length === 0 ? (
						<Text size="xs" c="dimmed" py="md" ta="center">
							{t("commitEmpty")}
						</Text>
					) : (
						<>
							{topologyUnknown && (
								<Text size="xs" c="dimmed" px="xs" pb={4}>
									{t("graph.topologyUnavailable")}
								</Text>
							)}
							{rows.map((row) => {
								const width = graphRowWidth(row);
								const paths = buildRowSvgPaths(row);
								const circles = buildRowCircles(row);
								return (
									<UnstyledButton
										key={row.commit.sha}
										component="a"
										href={buildCommitPreviewBrowserHref(target, row.commit.sha)}
										aria-label={t("commitPreview.open", { sha: row.commit.shortSha })}
										data-commit-row={row.commit.sha}
										style={{ display: "block", width: "100%" }}
										onClick={(event) => {
											if (
												event.button > 0 ||
												event.metaKey ||
												event.ctrlKey ||
												event.shiftKey ||
												event.altKey
											)
												return;
											event.preventDefault();
											setPreview({ sha: row.commit.sha, targetKey: previewTargetKey });
										}}
									>
										<Group wrap="nowrap" h={GRAPH_ROW_HEIGHT} gap={8} px={6}>
											<Box style={{ flexShrink: 0, height: GRAPH_ROW_HEIGHT, width }}>
												<svg
													width={width}
													height={GRAPH_ROW_HEIGHT}
													aria-hidden
													role="presentation"
													style={{ display: "block", overflow: "visible" }}
												>
													{paths.map((path) => (
														<path
															key={path.d}
															d={path.d}
															stroke={path.stroke}
															strokeWidth={2}
															fill="none"
														/>
													))}
													{circles.map((circle) => (
														<circle
															key={`${circle.cx}:${circle.cy}:${circle.r}:${circle.fill}:${circle.hollow ? "h" : "s"}`}
															cx={circle.cx}
															cy={circle.cy}
															r={circle.r}
															strokeWidth={circle.strokeWidth}
															fill={circle.hollow ? "var(--mantine-color-body)" : circle.fill}
															stroke={circle.hollow ? "none" : circle.fill}
														/>
													))}
												</svg>
											</Box>
											<Text
												size="xs"
												truncate
												fw={row.isHead ? 600 : 400}
												style={{ flex: 1, minWidth: 0 }}
											>
												{clampMessage(row.commit.message)}
											</Text>
											<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
												{row.commit.author}
											</Text>
										</Group>
									</UnstyledButton>
								);
							})}
							{canLoadMore ? (
								<Group justify="center" py="xs">
									<Button size="compact-xs" variant="light" onClick={loadMore}>
										{t("loadMore")}
									</Button>
								</Group>
							) : null}
							{atCap ? (
								<Text size="xs" c="dimmed" ta="center" py="xs">
									{t("graph.capReached", { count: GRAPH_COMMIT_CAP })}
								</Text>
							) : null}
						</>
					)}
				</ScrollArea>
			)}
			<GitCommitDetailModal
				key={previewTargetKey}
				target={target}
				sha={previewSha}
				onClose={() => setPreview(null)}
			/>
		</Box>
	);
}
