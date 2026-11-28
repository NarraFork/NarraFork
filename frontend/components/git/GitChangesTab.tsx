import { statusRegistry } from "@frontend/lib/status-registry";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	HoverCard,
	Loader,
	rem,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Timeline,
	Tooltip,
	VisuallyHidden,
} from "@mantine/core";

import {
	IconCheck,
	IconFilter,
	IconFilterOff,
	IconMinus,
	IconPlus,
	IconRefresh,
	IconSparkles,
	IconTrash,
} from "@tabler/icons-react";
import {
	memo,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type {
	GitStatusPageScopeProof,
	GitStatusPageSection,
} from "../../../shared/git-status-page";
import {
	type CurrentDiffTarget,
	useGitAiCommitMessage,
	useGitCommit,
	useGitDiscard,
	useGitFileModifications,
	useGitLineStats,
	useGitStage,
	useGitStatus,
	useGitUnstage,
} from "../../hooks/useGit";
import { useGitFolderPrefs } from "../../hooks/useGitFolderPrefs";
import { useGitStatusFilter } from "../../hooks/useGitStatusFilter";
import { useGitStatusPageStats } from "../../hooks/useGitStatusPageStats";
import { useGitStatusPages } from "../../hooks/useGitStatusPages";
import { useGitViewMode } from "../../hooks/useGitViewMode";
import { ApiError } from "../../lib/api/client";
import {
	GIT_FILE_ACTION_MAX_FILES,
	type GitTarget,
	gitCanWrite,
	gitTargetKey,
} from "../../lib/api/git";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { observePageLifecycle } from "../../lib/page-lifecycle";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { buildAttributionLabels } from "./attribution-label";
import classes from "./GitChangesTab.module.css";
import { GitFileDiff } from "./GitFileDiff";
import { GitLineStatsSummary } from "./GitLineStatsSummary";
import { GitStagingWorkspace } from "./GitStagingLists";
import {
	clampGitFilePath,
	DirectoryGlyph,
	LineStats,
	STATUS_BADGE_WIDTH,
	TreeRow,
} from "./GitTreeRow";
import {
	type GitChangesDisplayFile as DisplayFile,
	GIT_CHANGES_ROW_HEIGHT,
	type GitChangesListConfig,
	type GitChangesRow,
} from "./git-changes-list-model";
import { type GitFileSection, gitFileBadgeChar } from "./git-file-status";
import { formatGitSectionCount } from "./git-status-counts";
import { type GitStatusFilterChar, visibleFilterChars } from "./git-status-filter";
import { useGitChangesList } from "./useGitChangesList";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

function createDisplayAccess(scope: string, allowed: boolean) {
	const listeners = new Set<() => void>();
	const access = {
		scope,
		allowed,
		live: true,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: (): string => JSON.stringify([access.scope, access.allowed, access.live]),
		notify: () => {
			for (const listener of listeners) listener();
		},
	};
	return access;
}

/** Confirmation portals must not keep paths after their readable owner is gone. */
function DisplayConfirmation({
	access,
	scope,
	fallback,
	children,
}: {
	access: ReturnType<typeof createDisplayAccess>;
	scope: string;
	fallback: string;
	children: ReactNode;
}) {
	useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
	return (
		<Text size="sm">
			{access.live && access.allowed && access.scope === scope ? children : fallback}
		</Text>
	);
}

/** Everything a tree row needs that does not change per node. */
interface TreeContext {
	attributionHover: { current: string | null };
	generation: string;
	actionEpoch: number;
	canWrite: boolean;
	rangeComplete: boolean;
	displayRangeComplete: boolean;
	rangeReason: string;
	onDirectoryAction: (path: string) => void;
	action: "stage" | "unstage";
	actionLabel?: string;
	/**
	 * Which half of the porcelain status these rows report. Carried explicitly
	 * rather than derived from `action`: the badge letter depends on it, and
	 * inferring "staged" from the verb "unstage" is the kind of double negative
	 * that reads wrong at the call site.
	 */
	section: GitFileSection;
	/**
	 * Folder paths the user has opened. Folders default to CLOSED, so this is the
	 * exception list rather than a collapsed list — an unseen path is collapsed
	 * without anyone having to enumerate the tree.
	 */
	expandedFolders: Set<string>;
	onToggle: (path: string) => void;
	onAction: (files: string[]) => void;
	onOpenFile: (path: string) => void;
	onDiscard?: (path: string) => void;
	/** Attribution is read per file when its hover card opens, never for the whole list. */
	target: GitTarget;
	t: Translate;
}

export function GitChangesTab(props: { target: GitTarget; onRefresh?: () => void }) {
	const { t } = useTranslation("git");
	const [selected, setSelected] = useState<{ key: string; mode: "groups" | "native" }>();
	const key = gitTargetKey(props.target) ?? "";
	const mode = selected?.key === key ? selected.mode : "native";
	return (
		<Box
			className={classes.changesPanel}
			style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
		>
			<Button.Group p="xs" style={{ flexShrink: 0 }}>
				<Button
					size="compact-xs"
					variant={mode === "groups" ? "filled" : "subtle"}
					aria-pressed={mode === "groups"}
					onClick={() => setSelected({ key, mode: "groups" })}
				>
					{t("staging.title")}
				</Button>
				<Button
					size="compact-xs"
					variant={mode === "native" ? "filled" : "subtle"}
					aria-pressed={mode === "native"}
					onClick={() => setSelected({ key, mode: "native" })}
				>
					{t("staging.nativeView")}
				</Button>
			</Button.Group>
			{mode === "groups" ? <GitStagingWorkspace {...props} /> : <NativeGitChangesTab {...props} />}
		</Box>
	);
}

function NativeGitChangesTab({ target, onRefresh }: { target: GitTarget; onRefresh?: () => void }) {
	const canWrite = gitCanWrite(target);
	const preferenceKey = gitTargetKey(target) ?? "";
	const { t } = useTranslation("git");
	const confirm = useConfirmDialog();
	const { data: summary, isLoading, error } = useGitStatus(target, "details", { pushOnly: true });
	const status = summary ?? { staged: 0, branch: "", hasChanges: true };
	const lineStats = useGitLineStats(target, "details", { pushOnly: true });
	const stage = useGitStage(target);
	const unstage = useGitUnstage(target);
	const commit = useGitCommit(target);
	const discard = useGitDiscard(target);
	const rowHeight = GIT_CHANGES_ROW_HEIGHT;
	const scopeExpired = [stage.error, unstage.error, discard.error].some(
		(error) => error instanceof ApiError && error.data?.code === "GIT_STATUS_PAGE_EXPIRED",
	);
	const aiMsg = useGitAiCommitMessage(target);
	const { mode: viewMode, setMode: setViewMode } = useGitViewMode(preferenceKey);

	const [message, setMessage] = useState("");
	const [diffFile, setDiffFile] = useState<string | null>(null);
	const [diffScope, setDiffScope] = useState("");
	const [diffStaged, setDiffStaged] = useState(false);
	const statusFilter = useGitStatusFilter(preferenceKey);
	const stagedFolders = useGitFolderPrefs(preferenceKey, "staged");
	const unstagedFolders = useGitFolderPrefs(preferenceKey, "unstaged");

	const pages = useGitStatusPages(target, statusFilter.selected);
	const attributionHover = useMemo<{ current: string | null }>(
		() => ({ current: null, scope: pages.displayScope }),
		[pages.displayScope],
	);
	const listConfig = useMemo<GitChangesListConfig>(
		() => ({
			mode: viewMode,
			filter: [...statusFilter.selected],
			expanded: { staged: [...stagedFolders.expanded], unstaged: [...unstagedFolders.expanded] },
		}),
		[viewMode, statusFilter.selected, stagedFolders.expanded, unstagedFolders.expanded],
	);
	const [displayBlock, setDisplayBlock] = useState<{
		scope: string;
		generation: string;
		error?: Error | null;
	} | null>(null);
	const displayBlocked =
		displayBlock?.scope === pages.displayScope && displayBlock.generation === pages.queryGeneration;
	const list = useGitChangesList({
		generation: pages.queryGeneration,
		pages: pages.pages,
		config: listConfig,
		rowHeight,
		displayScope: pages.displayScope,
		workspaceIdentity: pages.workspaceIdentity,
		displayAllowed: pages.displayAllowed && !displayBlocked,
	});
	const candidateMatches =
		list.candidateWindow.snapshotId !== undefined &&
		list.candidateWindow.snapshotId === pages.pages[0]?.snapshotId;
	const pageStats = useGitStatusPageStats(
		target,
		candidateMatches ? list.candidateWindow.snapshotId : undefined,
		statusFilter.selected,
		candidateMatches ? list.candidateWindow.rows : [],
		{
			generation: pages.queryGeneration,
			cache: pages.cache,
			enabled: pages.displayAllowed,
			onSnapshotObservation: pages.observeSnapshotStats,
		},
	);
	const hardRefusal = !pages.displayAllowed || pageStats.readRefused;
	const displayAllowed = !hardRefusal && !displayBlocked;
	// A statistics refusal is learned after the list hook. Hide facts in this render,
	// then retire its callbacks before paint; only a fresh page generation may reopen it.
	useLayoutEffect(() => {
		if (!hardRefusal) return;
		setDisplayBlock((previous) =>
			previous?.scope === pages.displayScope && previous.generation === pages.queryGeneration
				? previous
				: {
						scope: pages.displayScope,
						generation: pages.queryGeneration,
						error: pages.error || pageStats.error,
					},
		);
		list.clearDisplay();
	}, [
		hardRefusal,
		pages.displayScope,
		pages.queryGeneration,
		pages.error,
		pageStats.error,
		list.clearDisplay,
	]);
	useEffect(() => {
		if (!displayAllowed || !candidateMatches) return;
		list.mergePageStats(pageStats.source, pageStats.data, {
			settled: pageStats.isSettled,
			failed: !!pageStats.error,
			rows: pageStats.rows,
		});
	}, [
		displayAllowed,
		candidateMatches,
		list.mergePageStats,
		pageStats.source,
		pageStats.data,
		pageStats.isSettled,
		pageStats.error,
		pageStats.rows,
	]);
	const displayError = displayBlocked ? displayBlock?.error : null;
	const displayWindow = displayAllowed ? list.window : undefined;
	const displayCounts = displayAllowed ? list.displayCounts : undefined;
	const [readAccess] = useState(() => createDisplayAccess(pages.displayScope, displayAllowed));
	useLayoutEffect(() => {
		readAccess.scope = pages.displayScope;
		readAccess.allowed = displayAllowed;
		readAccess.notify();
	}, [readAccess, pages.displayScope, displayAllowed]);
	useLayoutEffect(() => {
		readAccess.live = true;
		readAccess.notify();
		return () => {
			readAccess.live = false;
			readAccess.notify();
		};
	}, [readAccess]);
	const listCurrent =
		displayAllowed &&
		list.isCurrent === true &&
		!list.isRetained &&
		list.displayGeneration === pages.queryGeneration &&
		list.displaySnapshotId === pages.pages[0]?.snapshotId;
	const refreshing =
		displayAllowed &&
		(pages.updating ||
			pageStats.updating ||
			list.isRetained ||
			list.window.statsRefreshing === true);
	const [scopeError, setScopeError] = useState<string | null>(null);
	const generationRef = useRef(pages.queryGeneration);
	generationRef.current = pages.queryGeneration;
	const filterActive = statusFilter.selected.size > 0;
	const countsAreLowerBounds = displayCounts?.exact === false;
	const badgeCounts = new Map<GitStatusFilterChar, number>(
		Object.entries(displayCounts?.badgeCounts ?? {}) as [GitStatusFilterChar, number][],
	);
	const filterChars = visibleFilterChars(badgeCounts, statusFilter.selected);
	const rangeComplete =
		listCurrent &&
		pages.isComplete &&
		pages.snapshotValid &&
		list.candidateWindow.loadedFiles === pages.counts?.filteredFiles;
	// Configuration ACKs gate actions, but do not change a complete displayed snapshot.
	const displayRangeComplete =
		displayAllowed &&
		(list.isCurrent || list.isConfiguring) &&
		!list.isRetained &&
		list.displayGeneration === pages.queryGeneration &&
		!!list.displaySnapshotId &&
		list.displaySnapshotId === pages.pages[0]?.snapshotId &&
		pages.isComplete &&
		pages.snapshotValid &&
		list.window.loadedFiles === pages.counts?.filteredFiles;
	const snapshotNeedsRefresh = !!displayWindow?.snapshotId && !pages.snapshotValid;
	const partialReason =
		pages.pages[0]?.complete === false
			? t("pages.partial", {
					reason: t(`pages.limitReasons.${pages.pages[0].limitReason ?? "remote-incomplete"}`),
				})
			: undefined;
	const rangeReason = !listCurrent
		? t("pages.refreshing")
		: pages.statusPagesReliable === false
			? t("pages.rangeUnreliable")
			: snapshotNeedsRefresh
				? t("pages.rangeExpired")
				: (partialReason ?? t("pages.rangeIncomplete"));
	const listWritable = canWrite && listCurrent && pages.snapshotValid;
	const nativeWritable = listWritable;
	const bulkBlocked = !listWritable || (filterActive && !rangeComplete);
	const needsBatchRange = canWrite && (filterActive || viewMode === "tree");
	const showRangeControls =
		displayAllowed &&
		(pages.isLoadingAll ||
			(needsBatchRange &&
				!rangeComplete &&
				(snapshotNeedsRefresh ||
					pages.statusPagesReliable === false ||
					(pages.hasNextPage && !partialReason))));
	const autoLoadToken = useRef("");
	useEffect(() => {
		autoLoadToken.current = `${pages.queryGeneration}:reset`;
		setDiffFile(null);
		setScopeError(null);
	}, [pages.queryGeneration]);
	useEffect(() => {
		// Background pages are scheduled by the hook. Consume each scroll once, including
		// during an in-flight page, so it cannot queue an extra page after that budget stops.
		const token = `${pages.queryGeneration}:${list.scrollVersion}`;
		if (autoLoadToken.current === token) return;
		autoLoadToken.current = token;
		if (
			!list.scrollVersion ||
			!listCurrent ||
			!candidateMatches ||
			!pages.hasNextPage ||
			pages.isFetchingNextPage ||
			pages.isLoadingAll ||
			pages.error
		)
			return;
		const viewport = list.viewportRef.current;
		if (
			!viewport ||
			viewport.scrollTop + viewport.clientHeight <
				list.candidateWindow.totalRows * rowHeight - 6 * rowHeight
		)
			return;
		void pages.fetchNextPage();
	}, [
		list.scrollVersion,
		list.viewportRef,
		list.candidateWindow.totalRows,
		listCurrent,
		candidateMatches,
		pages,
	]);

	function handleCommit() {
		if (!canWrite || !nativeWritable || !message.trim() || status?.staged === 0) return;
		commit.mutate(message.trim(), { onSuccess: () => setMessage("") });
	}

	function handleAiGenerate() {
		aiMsg.mutate(undefined, {
			onSuccess: (data) => {
				if (data?.message) setMessage(data.message);
			},
		});
	}

	const writeIntent = useRef({
		generation: pages.queryGeneration,
		scope: pages.displayScope,
		writable: listWritable,
		version: 0,
	});
	if (
		writeIntent.current.generation !== pages.queryGeneration ||
		writeIntent.current.scope !== pages.displayScope ||
		writeIntent.current.writable !== listWritable
	)
		writeIntent.current = {
			generation: pages.queryGeneration,
			scope: pages.displayScope,
			writable: listWritable,
			version: writeIntent.current.version + 1,
		};
	const actionEpoch = writeIntent.current.version;
	const rangeState = useRef({
		generation: pages.queryGeneration,
		ready: rangeComplete,
		writable: listWritable,
		actionEpoch,
		expiresAt: 0,
	});
	rangeState.current = {
		generation: pages.queryGeneration,
		ready: rangeComplete,
		writable: listWritable,
		actionEpoch,
		expiresAt: pages.pages.at(-1)?.expiresAt ?? 0,
	};
	function mayWrite(generation = pages.queryGeneration, intent = actionEpoch) {
		return (
			readAccess.live &&
			rangeState.current.writable &&
			rangeState.current.generation === generation &&
			rangeState.current.actionEpoch === intent &&
			rangeState.current.expiresAt > Date.now()
		);
	}
	async function completePaths(section: GitStatusPageSection, directory?: string) {
		const generation = pages.queryGeneration;
		if (!mayWrite(generation) || !rangeState.current.ready) return null;
		try {
			const paths = await list.scope(section, directory);
			if (!mayWrite(generation) || !rangeState.current.ready) return null;
			if (paths.length > GIT_FILE_ACTION_MAX_FILES) {
				setScopeError(
					t("pages.rangeTooLarge", { count: paths.length, limit: GIT_FILE_ACTION_MAX_FILES }),
				);
				return null;
			}
			return paths;
		} catch (error) {
			if (
				generationRef.current === generation &&
				!(error instanceof DOMException && error.name === "AbortError")
			)
				setScopeError(error instanceof Error ? error.message : String(error));
			return null;
		}
	}
	function snapshotScope(
		section: GitStatusPageSection,
		directory?: string,
	): GitStatusPageScopeProof | undefined {
		const page = pages.pages[0];
		if (!page) return undefined;
		return {
			snapshotId: page.snapshotId,
			filter: [...statusFilter.selected],
			section,
			...(directory == null ? {} : { directory }),
		};
	}
	async function handleBulk(section: GitStatusPageSection, directory?: string) {
		if (!mayWrite()) return;
		const generation = pages.queryGeneration;
		const mutation = section === "staged" ? unstage : stage;
		if (!filterActive && directory == null) {
			mutation.mutate({ all: true });
			return;
		}
		const proof = snapshotScope(section, directory);
		if (!proof) return;
		const paths = await completePaths(section, directory);
		if (paths?.length && mayWrite(generation) && rangeState.current.ready)
			mutation.mutate({ files: paths, snapshotScope: proof });
	}
	async function handleDiscardAll() {
		if (!mayWrite() || !nativeWritable) return;
		const generation = pages.queryGeneration;
		const proof = filterActive ? snapshotScope("unstaged") : undefined;
		const files = filterActive ? await completePaths("unstaged") : null;
		if (filterActive && (!files || !proof)) return;
		const confirmMessage = files
			? t("filter.discardMatchedConfirm", { count: files.length })
			: t("discardConfirm");
		const scope = `\n${t("workspace.scope", { root: target.rootPath })}`;
		if (
			!(await confirm({
				message: (
					<DisplayConfirmation
						access={readAccess}
						scope={pages.displayScope}
						fallback={t("pages.scopeExpired")}
					>
						{confirmMessage + scope}
					</DisplayConfirmation>
				),
			}))
		)
			return;
		if (!mayWrite(generation) || (filterActive && !rangeState.current.ready)) return;
		if (files) {
			if (files.length) discard.mutate({ files, snapshotScope: proof });
		} else discard.mutate({ all: true });
	}

	function contextFor(
		section: GitFileSection,
		action: "stage" | "unstage",
		folders: { expanded: Set<string>; toggle: (path: string) => void },
	): TreeContext {
		return {
			generation: pages.queryGeneration,
			attributionHover,
			actionEpoch,
			canWrite: listWritable,
			rangeComplete,
			displayRangeComplete,
			rangeReason,
			onDirectoryAction: (path) => {
				void handleBulk(section, path);
			},
			action,
			section,
			expandedFolders: folders.expanded,
			onToggle: folders.toggle,
			onAction: (paths) => {
				if (!mayWrite()) return;
				if (action === "stage") stage.mutate({ files: paths });
				else unstage.mutate({ files: paths });
			},
			onOpenFile: (path) => {
				if (!readAccess.allowed || readAccess.scope !== pages.displayScope) return;
				setDiffScope(pages.displayScope);
				setDiffFile(path);
				setDiffStaged(section === "staged");
			},
			onDiscard:
				section === "unstaged" && nativeWritable
					? async (file) => {
							if (!mayWrite()) return;
							const generation = pages.queryGeneration;
							const scope = `\n${t("workspace.scope", { root: target.rootPath })}`;
							if (
								(await confirm({
									message: (
										<DisplayConfirmation
											access={readAccess}
											scope={pages.displayScope}
											fallback={t("pages.scopeExpired")}
										>
											{t("discardFileConfirm", { file }) + scope}
										</DisplayConfirmation>
									),
								})) &&
								mayWrite(generation)
							)
								discard.mutate({ files: [file] });
						}
					: undefined,
			target,
			t,
		};
	}

	function renderRow(row: GitChangesRow) {
		if (row.type.startsWith("staging-")) return null;
		if (!("section" in row) && row.type !== "loading" && row.type !== "empty") return null;
		if (row.type === "loading")
			return (
				<Group justify="center" h="100%" gap={4} wrap="nowrap">
					<Button
						size="compact-xs"
						variant="subtle"
						data-testid="git-changes-load-more"
						loading={pages.isFetching || pages.isLoadingAll}
						onClick={() => {
							if (pages.error) void pages.retry();
							else void pages.fetchNextPage();
						}}
					>
						{pages.error ? t("pages.retry") : t("pages.loadMore")}
					</Button>
				</Group>
			);
		if (row.type === "empty")
			return (
				<Group justify="center" h="100%" gap={4} wrap="nowrap">
					<Text size="xs" c="dimmed">
						{filterActive ? t("filter.noMatches") : t("noChanges")}
					</Text>
					{filterActive && (
						<Button size="compact-xs" variant="subtle" onClick={statusFilter.clear}>
							{t("filter.clear")}
						</Button>
					)}
				</Group>
			);
		const section = row.section;
		if (row.type === "section") {
			const tooLarge = filterActive && row.count > GIT_FILE_ACTION_MAX_FILES;
			const blocked = bulkBlocked || tooLarge;
			const reason = tooLarge
				? t("pages.rangeTooLarge", { count: row.count, limit: GIT_FILE_ACTION_MAX_FILES })
				: rangeReason;
			const countReason = countsAreLowerBounds
				? `${t("workspace.sectionTruncated", { section: t(section) })}${partialReason ? `\n${partialReason}` : ""}`
				: partialReason;
			return (
				<Group gap={4} justify="space-between" h="100%" px={4} wrap="nowrap">
					<Text size="xs" fw={600} truncate data-git-section-count={section} title={countReason}>
						{t(section)} (
						{filterActive
							? `${formatGitSectionCount(row.count, countsAreLowerBounds)}/${formatGitSectionCount(row.total, countsAreLowerBounds)}`
							: formatGitSectionCount(row.total, countsAreLowerBounds)}
						)
					</Text>
					<Group gap={4} wrap="nowrap">
						<span title={blocked ? reason : undefined}>
							<Button
								size="compact-xs"
								variant="subtle"
								disabled={!canWrite || blocked}
								title={blocked ? reason : undefined}
								loading={section === "staged" ? unstage.isPending : stage.isPending}
								onClick={() => {
									void handleBulk(section);
								}}
							>
								{filterActive
									? t(section === "staged" ? "filter.unstageMatched" : "filter.stageMatched")
									: t(section === "staged" ? "unstageAll" : "stageAll")}
							</Button>
						</span>

						{section === "unstaged" && (
							<span title={blocked ? reason : undefined}>
								<Button
									size="compact-xs"
									variant="subtle"
									color="red"
									disabled={!canWrite || blocked}
									title={blocked ? reason : undefined}
									loading={discard.isPending}
									onClick={handleDiscardAll}
								>
									{filterActive ? t("filter.discardMatched") : t("discardAll")}
								</Button>
							</span>
						)}
					</Group>
				</Group>
			);
		}
		const context = contextFor(
			section,
			section === "staged" ? "unstage" : "stage",
			section === "staged" ? stagedFolders : unstagedFolders,
		);
		if (row.type === "directory") return <MemoizedDirectoryRow row={row} ctx={context} />;
		return (
			<MemoizedFileRow file={row.file} depth={row.depth} ctx={context}>
				{row.label}
			</MemoizedFileRow>
		);
	}

	return (
		<Box
			className={classes.changesPanel}
			data-git-native-view
			style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}
		>
			{(isLoading || (pages.isCachePending && !list.window.snapshotId)) && <Loader size="xs" />}
			{pages.waitingForConnection && (
				<Text role="status" c="dimmed" size="xs" px="xs">
					{t("pages.waitingForConnection")}
				</Text>
			)}
			{(error ||
				pages.error ||
				pages.statsError ||
				pageStats.error ||
				displayError ||
				list.error ||
				scopeError) && (
				<Text c="red" size="xs" px="xs">
					{scopeError ||
						(pages.error || error)?.message ||
						(pages.statsError
							? t("lineStats.failed")
							: (pageStats.error || displayError || list.error)?.message)}
				</Text>
			)}
			{(stage.error || unstage.error || commit.error || discard.error || aiMsg.error) && (
				<Text c="red" size="xs" px="xs" pt={4}>
					{(stage.error || unstage.error || commit.error || discard.error || aiMsg.error)?.message}
				</Text>
			)}
			{(stage.error || unstage.error || commit.error || discard.error) && (
				<Text c="dimmed" size="xs" px="xs">
					{scopeExpired ? t("pages.scopeExpired") : t("workspace.writeFailureHint")}
				</Text>
			)}

			{
				<Stack gap={4} px="xs" pt="xs" style={{ flexShrink: 0 }}>
					<TextInput
						placeholder={t("commitMessage")}
						value={message}
						onChange={(e) => setMessage(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) handleCommit();
						}}
						rightSection={
							<Tooltip label={t("aiGenerate")}>
								<ActionIcon
									aria-label={t("aiGenerate")}
									variant="subtle"
									size="sm"
									onClick={handleAiGenerate}
									disabled={!canWrite}
									loading={aiMsg.isPending}
								>
									<IconSparkles size={14} />
								</ActionIcon>
							</Tooltip>
						}
						size="sm"
					/>
					<Button
						fullWidth
						size="sm"
						leftSection={<IconCheck size={15} />}
						onClick={handleCommit}
						loading={commit.isPending}
						disabled={!canWrite || !nativeWritable || !message.trim() || status.staged === 0}
					>
						{t("commitButton")}
						{displayAllowed && displayWindow?.snapshotId && status.staged > 0
							? ` (${status.staged})`
							: ""}
					</Button>
				</Stack>
			}

			<Group gap={6} px="xs" py={6} wrap="nowrap" style={{ flexShrink: 0 }}>
				<Text
					size="sm"
					fw={600}
					style={{ flexShrink: 0 }}
					data-git-file-count
					title={
						countsAreLowerBounds
							? t("workspace.sectionTruncated", { section: t("panel.changes") })
							: undefined
					}
				>
					{t("panel.changes")}
					{displayCounts &&
						` (${
							filterActive
								? `${formatGitSectionCount(displayCounts.filteredFiles, countsAreLowerBounds)}/${formatGitSectionCount(displayCounts.totalFiles, countsAreLowerBounds)}`
								: formatGitSectionCount(displayCounts.totalFiles, countsAreLowerBounds)
						})`}
				</Text>
				{displayAllowed && displayWindow?.snapshotId && (
					<GitLineStatsSummary {...lineStats} compact />
				)}
				<Box style={{ flex: 1, minWidth: 0 }} />
				<Button.Group style={{ flexShrink: 0 }}>
					<Button
						size="compact-xs"
						variant={viewMode === "tree" ? "filled" : "subtle"}
						aria-pressed={viewMode === "tree"}
						onClick={() => setViewMode("tree")}
					>
						{t("view.tree")}
					</Button>
					<Button
						size="compact-xs"
						variant={viewMode === "flat" ? "filled" : "subtle"}
						aria-pressed={viewMode === "flat"}
						onClick={() => setViewMode("flat")}
					>
						{t("view.flat")}
					</Button>
				</Button.Group>
				<Tooltip label={t("workspace.retry")}>
					<ActionIcon
						size="sm"
						variant="subtle"
						aria-label={t("workspace.retry")}
						data-testid="git-changes-refresh"
						data-refreshing={refreshing}
						onClick={() => {
							void pages.refresh();
							onRefresh?.();
						}}
					>
						<IconRefresh size={15} className={refreshing ? classes.refreshing : undefined} />
					</ActionIcon>
				</Tooltip>
			</Group>

			{refreshing && <VisuallyHidden role="status">{t("pages.refreshing")}</VisuallyHidden>}
			<StatusFilterBar
				chars={filterChars}
				counts={badgeCounts}
				countsKnown={displayCounts?.exact === true}
				selected={statusFilter.selected}
				onToggle={statusFilter.toggle}
				onClear={statusFilter.clear}
				t={t}
			/>

			<ScrollArea
				style={{ flex: 1, minHeight: 0 }}
				viewportRef={list.viewportRef}
				classNames={{ viewport: "git-changes-viewport" }}
				viewportProps={{
					...{ "data-git-changes-list": "true", "aria-busy": refreshing },
				}}
				onScrollPositionChange={list.onScroll}
			>
				<Box px={4} data-git-total-rows={displayWindow?.totalRows ?? 0}>
					<div aria-hidden="true" style={{ height: (displayWindow?.start ?? 0) * rowHeight }} />
					{displayWindow?.rows.map((row) => (
						<div
							key={row.key}
							data-git-change-row={row.key}
							data-git-row-type={row.type}
							data-git-row-path={"path" in row ? row.path : undefined}
							style={{
								height: rowHeight,
								minHeight: rowHeight,
								overflow: "hidden",
							}}
						>
							{renderRow(row)}
						</div>
					))}
					<div
						aria-hidden="true"
						style={{
							height:
								Math.max(
									0,
									(displayWindow?.totalRows ?? 0) -
										(displayWindow?.start ?? 0) -
										(displayWindow?.rows.length ?? 0),
								) * rowHeight,
						}}
					/>
				</Box>
			</ScrollArea>
			{showRangeControls && (
				<Group
					px="xs"
					pb={4}
					gap={4}
					justify="center"
					wrap="nowrap"
					style={{ flexShrink: 0 }}
					data-testid="git-changes-range-controls"
				>
					{pages.isLoadingAll ? (
						<Button size="compact-xs" variant="subtle" onClick={pages.cancelLoadAll}>
							{t("pages.cancelLoadAll")}
						</Button>
					) : snapshotNeedsRefresh || pages.statusPagesReliable === false ? (
						<Button size="compact-xs" variant="subtle" onClick={pages.refresh}>
							{t("workspace.retry")}
						</Button>
					) : (
						pages.hasNextPage && (
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => {
									const generation = pages.queryGeneration;
									void pages.loadAll().catch((error: unknown) => {
										if (generationRef.current === generation)
											setScopeError(error instanceof Error ? error.message : String(error));
									});
								}}
							>
								{t("pages.loadAll")}
							</Button>
						)
					)}
				</Group>
			)}

			<GitFileDiff
				target={target}
				file={displayAllowed && diffScope === pages.displayScope ? diffFile : null}
				staged={diffStaged}
				onClose={() => setDiffFile(null)}
			/>
		</Box>
	);
}

/**
 * Status filter chips: one per kind of change present in the working tree.
 *
 * ── Why chips and not a Select ───────────────────────────────────────────────
 * The question is "which kinds do I want to see", which is multi-select and has
 * at most six answers. A dropdown hides both the current selection and the
 * per-kind counts behind a click; six toggles show them at a glance and cost one
 * click each. They also reuse the exact letter and colour the file rows already
 * render, so the chip and the badge it filters on are visibly the same thing.
 *
 * Renders nothing when there is only one kind of change: a filter that can only
 * show everything or nothing is noise, and it would take a row of height away
 * from the file list in the common single-kind case.
 */
function StatusFilterBar({
	chars,
	counts,
	countsKnown = true,
	selected,
	onToggle,
	onClear,
	t,
}: {
	chars: readonly GitStatusFilterChar[];
	counts: ReadonlyMap<GitStatusFilterChar, number>;
	countsKnown?: boolean;
	selected: ReadonlySet<GitStatusFilterChar>;
	onToggle: (char: GitStatusFilterChar) => void;
	onClear: () => void;
	t: Translate;
}) {
	const { t: tCommon } = useTranslation("common");
	if (chars.length < 2 && selected.size === 0) return null;
	const active = selected.size > 0;

	return (
		<Group
			gap={4}
			wrap="wrap"
			px="xs"
			pb="xs"
			style={{ flexShrink: 0 }}
			role="group"
			aria-label={t("filter.label")}
		>
			{/*
			 * The leading filter glyph doubles as the clear control. A separate
			 * trailing "clear" button only appeared while filtering, and an
			 * ActionIcon is taller than the chips — the whole bar jumped in height
			 * every time the filter toggled. One fixed-size slot that only changes
			 * state keeps the bar's shape identical in both modes.
			 */}
			<Tooltip label={active ? t("filter.clear") : t("filter.label")}>
				<ActionIcon
					size="sm"
					variant="subtle"
					color={active ? "indigo" : "gray"}
					aria-label={active ? t("filter.clear") : t("filter.label")}
					aria-pressed={active}
					disabled={!active}
					onClick={onClear}
					style={{ flexShrink: 0 }}
				>
					{active ? <IconFilterOff size={12} /> : <IconFilter size={12} />}
				</ActionIcon>
			</Tooltip>
			{chars.map((char) => {
				const entry = statusRegistry.gitFileStatus(char);
				const on = selected.has(char);
				const count = counts.get(char) ?? 0;
				// The chip names the KIND ("Modified"), not just the letter: the letter is
				// the compact form the rows use, but a filter control has room to say what
				// it means, and `C` / `R` are not guessable.
				const name = entry.i18nKey ? tCommon(entry.i18nKey) : char;
				return (
					<Badge
						key={char}
						size="sm"
						variant={on ? "filled" : "outline"}
						color={entry.color}
						component="button"
						type="button"
						// `aria-pressed` rather than a checkbox role: these are toggle buttons,
						// and it is also the only way a test (or a screen reader) can read the
						// selection without inspecting Mantine's variant classes.
						aria-pressed={on}
						data-git-status-filter={char}
						aria-label={countsKnown ? t("filter.toggle", { name, count }) : name}
						onClick={() => onToggle(char)}
						style={{ cursor: "pointer", textTransform: "none" }}
					>
						{char}
						{countsKnown ? ` ${count}` : ""}
					</Badge>
				);
			})}
		</Group>
	);
}

function DirectoryRow({
	row,
	ctx,
}: {
	row: Extract<GitChangesRow, { type: "directory" }>;
	ctx: TreeContext;
}) {
	const { expanded, depth, path } = row;
	const tooLarge = row.fileCount > GIT_FILE_ACTION_MAX_FILES;
	const blocked = !ctx.rangeComplete || tooLarge;
	const reason = tooLarge
		? ctx.t("pages.rangeTooLarge", { count: row.fileCount, limit: GIT_FILE_ACTION_MAX_FILES })
		: ctx.rangeReason;
	// Folder rows reuse the file wording: the action is the same, only the scope differs.
	const actionLabel =
		ctx.actionLabel ?? (ctx.action === "stage" ? ctx.t("stageFile") : ctx.t("unstageFile"));

	return (
		<TreeRow
			depth={depth}
			expanded={expanded}
			label={
				expanded ? ctx.t("collapseFolder", { path: path }) : ctx.t("expandFolder", { path: path })
			}
			onActivate={() => ctx.onToggle(path)}
		>
			<DirectoryGlyph expanded={expanded} />
			<Text
				size="xs"
				fw={600}
				lineClamp={1}
				style={{ flex: 1, minWidth: 0 }}
				ff="monospace"
				title={path}
			>
				{clampGitFilePath(row.label)}
			</Text>
			<Badge
				size="xs"
				variant="light"
				color="gray"
				title={ctx.displayRangeComplete ? undefined : ctx.rangeReason}
				style={{ flexShrink: 0 }}
			>
				{row.fileCount}
				{ctx.displayRangeComplete ? "" : "+"}
			</Badge>
			<LineStats added={row.added} removed={row.removed} refreshing={row.statsRefreshing} />
			<span title={blocked ? reason : actionLabel} style={{ display: "inline-flex" }}>
				<ActionIcon
					size="xs"
					variant="subtle"
					aria-label={actionLabel}
					disabled={!ctx.canWrite || blocked}
					onClick={(e) => {
						e.stopPropagation();
						ctx.onDirectoryAction(path);
					}}
				>
					{ctx.action === "stage" ? <IconPlus size={12} /> : <IconMinus size={12} />}
				</ActionIcon>
			</span>
		</TreeRow>
	);
}

function FileRow({
	file,
	depth,
	ctx,
	children,
}: {
	file: DisplayFile;
	depth: number;
	ctx: TreeContext;
	children: string;
}) {
	// The badge shows what KIND of change this is; which SECTION the row is in
	// already carries the staged/unstaged axis. Passing the section is what keeps
	// `AM` from rendering as a two-letter gray blob.
	const statusChar = gitFileBadgeChar(file.status, ctx.section);
	const color = statusRegistry.gitFileStatus(statusChar).color;
	const actionLabel =
		ctx.actionLabel ?? (ctx.action === "stage" ? ctx.t("stageFile") : ctx.t("unstageFile"));

	return (
		<TreeRow
			depth={depth}
			label={ctx.t("viewDiffOf", { path: file.path })}
			onActivate={() => ctx.onOpenFile(file.path)}
		>
			<AttributionHoverCard
				intent={ctx.attributionHover}
				target={ctx.target}
				filePath={file.path}
				section={ctx.section}
				t={ctx.t}
			>
				<Badge
					size="xs"
					color={color}
					variant="filled"
					w={STATUS_BADGE_WIDTH}
					style={{ flexShrink: 0 }}
				>
					{statusChar}
				</Badge>
			</AttributionHoverCard>
			<Text
				size="xs"
				lineClamp={1}
				style={{ flex: 1, minWidth: 0 }}
				ff="monospace"
				title={file.path}
			>
				{clampGitFilePath(children)}
			</Text>
			<LineStats
				added={file.displayLinesAdded}
				removed={file.displayLinesRemoved}
				refreshing={file.statsRefreshing}
			/>
			{ctx.onDiscard && (
				<ActionIcon
					size="xs"
					variant="subtle"
					color="red"
					className={classes.touchAction}
					disabled={!ctx.canWrite}
					aria-label={ctx.t("discardFile")}
					title={ctx.t("discardFile")}
					onClick={(event) => {
						event.stopPropagation();
						ctx.onDiscard?.(file.path);
					}}
				>
					<IconTrash size={12} />
				</ActionIcon>
			)}
			<ActionIcon
				size="xs"
				variant="subtle"
				className={classes.touchAction}
				aria-label={actionLabel}
				title={actionLabel}
				disabled={!ctx.canWrite}
				onClick={(e) => {
					e.stopPropagation();
					ctx.onAction(file.oldPath ? [file.oldPath, file.path] : [file.path]);
				}}
			>
				{ctx.action === "stage" ? <IconPlus size={12} /> : <IconMinus size={12} />}
			</ActionIcon>
		</TreeRow>
	);
}

function sameRowContext(left: TreeContext, right: TreeContext) {
	return (
		left.generation === right.generation &&
		left.attributionHover === right.attributionHover &&
		left.actionEpoch === right.actionEpoch &&
		left.target === right.target &&
		left.t === right.t &&
		left.canWrite === right.canWrite &&
		left.section === right.section &&
		left.action === right.action &&
		left.actionLabel === right.actionLabel &&
		left.t === right.t
	);
}

// Worker window DTOs are cloned. Retain unchanged row subtrees across fetch-state
// commits while always updating their actions for a new generation or target.
const MemoizedFileRow = memo(
	FileRow,
	(left, right) =>
		sameRowContext(left.ctx, right.ctx) &&
		left.depth === right.depth &&
		left.children === right.children &&
		left.file.path === right.file.path &&
		left.file.oldPath === right.file.oldPath &&
		left.file.status === right.file.status &&
		left.file.displayLinesAdded === right.file.displayLinesAdded &&
		left.file.displayLinesRemoved === right.file.displayLinesRemoved &&
		left.file.statsComplete === right.file.statsComplete &&
		left.file.statsEpoch === right.file.statsEpoch &&
		left.file.statsRefreshing === right.file.statsRefreshing,
);
const MemoizedDirectoryRow = memo(
	DirectoryRow,
	(left, right) =>
		sameRowContext(left.ctx, right.ctx) &&
		left.ctx.rangeComplete === right.ctx.rangeComplete &&
		left.ctx.displayRangeComplete === right.ctx.displayRangeComplete &&
		left.ctx.rangeReason === right.ctx.rangeReason &&
		left.row.path === right.row.path &&
		left.row.label === right.row.label &&
		left.row.depth === right.row.depth &&
		left.row.expanded === right.row.expanded &&
		left.row.fileCount === right.row.fileCount &&
		left.row.added === right.row.added &&
		left.row.removed === right.row.removed &&
		left.row.statsComplete === right.row.statsComplete &&
		left.row.statsEpoch === right.row.statsEpoch &&
		left.row.statsRefreshing === right.row.statsRefreshing,
);

function formatAttributionTime(value: string): string {
	try {
		return formatLocaleDateTime(value, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		return value;
	}
}

function AttributionHoverCard({
	intent,
	target,
	filePath,
	section,
	t,
	children,
}: {
	intent: { current: string | null };
	target: GitTarget;
	filePath: string;
	section: GitFileSection;
	t: Translate;
	children: ReactNode;
}) {
	const intentKey = JSON.stringify([section, filePath]);
	const [activated, setActivated] = useState(intent.current === intentKey);
	const pointerInside = useRef(intent.current === intentKey);
	const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (pending.current != null) clearTimeout(pending.current);
		},
		[],
	);
	// Browsing a window needs only the badge. Instantiate floating-card controllers
	// after a deliberate hover; virtual row removal also cancels the pending open.
	const badge = (
		// biome-ignore lint/a11y/noStaticElementInteractions: This passive badge delays a hover card; the file row owns click and keyboard activation.
		<span
			data-attribution-hover-target="true"
			onMouseEnter={(event) => {
				pointerInside.current = true;
				if (activated) {
					intent.current = intentKey;
					return;
				}
				const element = event.currentTarget;
				if (pending.current != null) clearTimeout(pending.current);
				pending.current = setTimeout(() => {
					pending.current = null;
					if (element.isConnected && document.visibilityState !== "hidden") {
						intent.current = intentKey;
						setActivated(true);
					}
				}, 120);
			}}
			onMouseLeave={() => {
				pointerInside.current = false;
				if (intent.current === intentKey) intent.current = null;
				if (pending.current != null) clearTimeout(pending.current);
				pending.current = null;
			}}
			style={{
				display: "inline-flex",
				flexShrink: 0,
				width: rem(STATUS_BADGE_WIDTH),
				cursor: "help",
			}}
		>
			{children}
		</span>
	);
	if (!activated) return badge;
	return (
		<HoverCard
			initiallyOpened={pointerInside.current && document.visibilityState !== "hidden"}
			width={320}
			shadow="md"
			withArrow
			openDelay={120}
			closeDelay={120}
			withinPortal
		>
			<HoverCard.Target>{badge}</HoverCard.Target>
			{/* Dropdown children mount only while the card is open, so a closed row holds no
			    query observer and closing the card aborts its in-flight read. */}
			<HoverCard.Dropdown p="xs">
				<ForegroundAttributionDetails target={target} filePath={filePath} section={section} t={t} />
			</HoverCard.Dropdown>
		</HoverCard>
	);
}

/** A hidden page unmounts the query (aborting its read) and remounts it on return. */
function ForegroundAttributionDetails(props: {
	target: GitTarget;
	filePath: string;
	section: GitFileSection;
	t: Translate;
}) {
	const [hidden, setHidden] = useState(false);
	useEffect(
		() =>
			observePageLifecycle({
				onHidden: () => setHidden(true),
				onForeground: () => setHidden(false),
			}),
		[],
	);
	return hidden ? null : <AttributionDetails {...props} />;
}

/**
 * Latest observed actor plus historical participants. None is claimed to own the current
 * diff: v1 timestamp hints have no verified baseline fingerprint or workspace epoch.
 * No recorded observation is a short empty note, not a claim that no one changed the file.
 */
function AttributionDetails({
	target,
	filePath,
	section,
	t,
}: {
	target: GitTarget;
	filePath: string;
	section: GitFileSection;
	t: Translate;
}) {
	const query = useGitFileModifications(target, filePath);
	if (!query.data) {
		if (query.isError)
			return (
				// The dropdown is portalled, but React still bubbles click and Enter/Space to the
				// row, whose handlers would open the diff instead of retrying.
				<Group
					gap="xs"
					wrap="nowrap"
					justify="space-between"
					onKeyDown={(event) => event.stopPropagation()}
				>
					<Text size="xs" c="dimmed">
						{t("attributionLoadFailedShort")}
					</Text>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={(event) => {
							event.stopPropagation();
							void query.refetch();
						}}
					>
						{t("attributionRetry")}
					</Button>
				</Group>
			);
		return (
			<Group gap="xs" wrap="nowrap">
				<Loader size="xs" />
				<Text size="xs" c="dimmed">
					{t("attributionLoadingShort")}
				</Text>
			</Group>
		);
	}

	const currentDiff = query.data.currentDiff;
	const observed = currentDiff?.byFile.find((file) => file.filePath === filePath)?.[
		section === "staged" ? "index" : "worktree"
	];
	// Evidence being re-read after a Git change is no longer a confirmed current claim.
	const refreshing = query.isFetching && query.isStale;
	const current: CurrentDiffTarget | undefined =
		observed && currentDiff?.baselineStatus === "stable" && !refreshing
			? observed
			: observed
				? {
						...observed,
						status: "unknown",
						actor: null,
						effectId: null,
						reason: refreshing
							? null
							: currentDiff?.baselineStatus === "stale"
								? "stale"
								: "unavailable",
					}
				: undefined;
	const history = query.data.byFile.find((group) => group.filePath === filePath);
	const showCurrent = !!current && current.status !== "clean";
	const recentEvents = history?.recentEvents ?? [];
	if (!showCurrent && recentEvents.length === 0)
		return (
			<Text size="xs" c="dimmed">
				{t("attributionEmptyShort")}
			</Text>
		);

	const hasCurrentEvidence =
		current?.status === "matching_evidence" &&
		current.actor &&
		!!current.baselineVersion &&
		!current.reason;
	const currentLabel = hasCurrentEvidence
		? buildAttributionLabels(current.actor, t).detail
		: refreshing && current
			? t("attributionRefreshingShort")
			: t("attributionCurrentUnknownShort");
	const currentTitle = current
		? t("attributionCurrentEvidenceShort")
		: t("attributionLastObservedShort");
	// History is treated as always incomplete; only surface actionable current-diff reasons.
	const reason =
		current?.reason && current.reason !== "history_incomplete"
			? t(`attributionCurrentReasonShort.${current.reason}`)
			: null;

	return (
		<Stack gap={6}>
			{current?.status !== "clean" && (
				<div>
					<Text size="xs" c="dimmed">
						{currentTitle}
					</Text>
					<Text size="sm" fw={600} lineClamp={1} title={currentLabel}>
						{currentLabel}
					</Text>
					{reason && (
						<Text size="xs" c="dimmed" lineClamp={2}>
							{reason}
						</Text>
					)}
				</div>
			)}

			{recentEvents.length > 0 && (
				<div>
					<Text size="xs" c="dimmed" mb={2}>
						{t("attributionHistoryShort")}
					</Text>
					{/* Mantine default item gap is spacing-xl; hover history wants a dense list. */}
					<Timeline
						bulletSize={8}
						lineWidth={1}
						styles={{
							item: { marginTop: 4, paddingTop: 0, paddingBottom: 0 },
							itemTitle: { marginBottom: 0, lineHeight: 1.3 },
							itemBody: { paddingTop: 0, paddingBottom: 0 },
						}}
					>
						{recentEvents.map((event) => {
							const labels = buildAttributionLabels(event.actor, t);
							const added = event.linesAdded;
							const removed = event.linesRemoved;
							const hasLineStats = typeof added === "number" || typeof removed === "number";
							const showLineStats = hasLineStats && !((added ?? 0) === 0 && (removed ?? 0) === 0);
							return (
								<Timeline.Item
									key={event.id}
									title={
										<Text size="xs" fw={500} lineClamp={1} title={labels.detail}>
											{labels.detail}
										</Text>
									}
								>
									<Group gap={6} wrap="nowrap" justify="space-between">
										<Text size="xs" c="dimmed" lineClamp={1}>
											{t(`attributionAction.${event.action}`)} ·{" "}
											{formatAttributionTime(event.changedAt)}
										</Text>
										{showLineStats && (
											<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
												{typeof added === "number" && added > 0 && (
													<Text size="xs" c="green" ff="monospace">
														+{added}
													</Text>
												)}
												{typeof removed === "number" && removed > 0 && (
													<Text size="xs" c="red" ff="monospace">
														-{removed}
													</Text>
												)}
											</Group>
										)}
									</Group>
								</Timeline.Item>
							);
						})}
					</Timeline>
				</div>
			)}
		</Stack>
	);
}
