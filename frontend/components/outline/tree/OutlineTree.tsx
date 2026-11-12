/**
 * The connected outline (readability E, D53): the whole outline as one tree by ownership, read
 * continuously without leaving it.
 *
 *   ▸ Recently visited (5)
 *   ▾ My notes                         my space, always first
 *       ▸ page…
 *   ▾ Project A                        project spaces, latest commit first
 *       ▸ page…                        its pages, in order
 *       ▾ Sessions (12)                the sessions whose project is A, latest commit first
 *           ▾ Session a1
 *               ▾ Tasks                a page, opened in place: READ-ONLY
 *                   ◐ a task …         its blocks, folded by the page's default (PR C)
 *           12 more ▸
 *   ▸ Sessions outside projects (3)
 *   ▸ Spaces without an owner (2)      admins only
 *
 * Every row has its arrow (always drawn, touch included). A node's children are read when it is
 * opened, a page at a time (`/outline/tree…`, the space's page list); a page opened in place is
 * one read of at most {@link OUTLINE_TREE_LIMITS.pageBlocks} blocks /
 * {@link OUTLINE_TREE_LIMITS.pageBytes} bytes, shown by the read-only block tree with the
 * reader's own folding (stored per page, shared with the focused page). What does not fit is a
 * link to the page focused, where the live editor is. Nothing here edits: the title of a space
 * or page (and a block's bullet) focuses it.
 *
 * LIMITS: what is open is kept per browser (`tree-open-state.ts`: 500 nodes, 12 pages with their
 * content, the newest 8 of them subscribed to their page's commits); lists grow only when the
 * reader asks for the next page. The DOM is so bounded by what the reader opened: at most 12
 * pages of 200 blocks, plus the rows of the lists loaded.
 *
 * Router-free, like the surface: links go through the host's renderer (`outline-nav.tsx`), so
 * the outline route and a dock panel show the same tree.
 */
import { Alert, Anchor, Badge, Box, Button, Group, Loader, Paper, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { blockTitle } from "@shared/outline";
import {
	OUTLINE_TREE_LIMITS,
	type OutlinePageSummary,
	type OutlineSpaceSummary,
	type OutlineTreeSpace,
} from "@shared/outline-api";
import type { FoldAction, FoldTree, FoldView } from "@shared/outline-fold";
import {
	IconClock,
	IconFileText,
	IconFolder,
	IconFolders,
	IconMessages,
	IconUser,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
	outlineKeys,
	useEnsurePersonalOutlineSpace,
	useOutlineBlock,
	useOutlinePages,
	useOutlineQuestions,
	useOutlineTree,
	useOutlineTreePageLive,
	useOutlineTreeSpaces,
	useOutlineViewStateSync,
} from "../../../hooks/useOutline";
import { ApiError } from "../../../lib/api";
import { formatSmartTime } from "../../../lib/format";
import { readOutlineRecents } from "../../../lib/outline-recents";
import { reportLineDisplay } from "../../../lib/outline-report-line";
import classes from "../Outline.module.css";
import { OutlineBlockBody } from "../OutlineBlockBody";
import { OutlineBlockTree, OutlineTaskIcon } from "../OutlineBlockTree";
import { OutlineQuestionsForm } from "../OutlineQuestions";
import { useOutlineSpaceName } from "../OutlineSpaceName";
import { FOLD_ICONS } from "../outline-icons";
import { OutlineLink, outlineBlockTarget } from "../outline-nav";
import { OutlineViewState } from "../view-state";
import {
	type TreeHost,
	TreeOpenState,
	treeCountLabel,
	treeOpenStorageKey,
} from "./tree-open-state";

/** Tree levels indentation grows for; deeper rows line up with the last. */
const MAX_TREE_INDENT = 4;
/** Below this width the tree is narrow: smaller steps (a phone, a narrow dock panel). */
const NARROW_PX = 480;

interface TreeContextValue {
	open: TreeOpenState;
	/** Pixels per level. */
	step: number;
	/** A phone or a narrow panel: indentation, tree and page together, stops at 4 levels. */
	narrow: boolean;
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTree(): TreeContextValue {
	const value = useContext(TreeContext);
	if (!value) throw new Error("OutlineTree: no tree");
	return value;
}

function useNodeOpen(key: string): [boolean, () => void] {
	const { open } = useTree();
	const isOpen = useSyncExternalStore(open.subscribe, () => open.isOpen(key));
	const toggle = useCallback(() => open.toggle(key), [open, key]);
	return [isOpen, toggle];
}

function indentOf(depth: number, step: number): number {
	return Math.min(depth, MAX_TREE_INDENT) * step;
}

const SPACE_ICON = { personal: IconUser, project: IconFolder, session: IconMessages } as const;

/** One row of the tree: its arrow, icon, title (a link that focuses it), and what it says. */
function TreeRow({
	nodeKey,
	depth,
	open,
	onToggle,
	icon,
	title,
	to,
	meta,
	kind,
	children,
}: {
	nodeKey: string;
	depth: number;
	open: boolean;
	onToggle: () => void;
	icon: ReactNode;
	title: string;
	/** Where the title goes (focus); a group's title opens it instead. */
	to?: Parameters<typeof OutlineLink>[0]["to"];
	meta?: ReactNode;
	kind: "space" | "page" | "group";
	/** What the node holds, shown (in its group) while it is open. */
	children?: ReactNode;
}) {
	const { t } = useTranslation("outline");
	const { step } = useTree();
	const { Icon: Arrow } = FOLD_ICONS[open ? "expanded" : "collapsed"];
	const action = t(open ? "page.collapse" : "page.expand");
	// The tree item holds its line and, open, its group: what it owns is nested in it.
	return (
		<div
			role="treeitem"
			// Focusable for assistive technology; the keyboard's tab stop is the title.
			tabIndex={-1}
			aria-level={depth + 1}
			aria-expanded={open}
			aria-selected={false}
			data-tree-item=""
		>
			<div
				className={classes.treeRow}
				data-tree-node={nodeKey}
				data-tree-kind={kind}
				data-open={open}
				style={{ paddingInlineStart: indentOf(depth, step) }}
			>
				<span className={classes.toggle}>
					{/* One tab stop per row (its title): the arrow is for the pointer, the arrow keys
				    open and close from the title. */}
					<button
						type="button"
						tabIndex={-1}
						className={`${classes.toggleButton} mantine-focus-auto`}
						aria-expanded={open}
						aria-label={`${action} · ${title}`}
						title={action}
						data-tree-toggle=""
						onClick={onToggle}
					>
						<Arrow size={14} />
					</button>
				</span>
				<span className={classes.treeIcon} aria-hidden="true">
					{icon}
				</span>
				{to ? (
					<OutlineLink to={to} className={classes.treeTitle} title={title} data-tree-title="">
						{title}
					</OutlineLink>
				) : (
					<button
						type="button"
						className={`${classes.treeTitle} ${classes.treeGroupTitle} mantine-focus-auto`}
						onClick={onToggle}
						data-tree-title=""
					>
						{title}
					</button>
				)}
				{meta && <span className={classes.treeMeta}>{meta}</span>}
			</div>
			{open && children !== undefined && (
				// biome-ignore lint/a11y/useSemanticElements: a tree item's children, not a form's fields
				<div role="group">{children}</div>
			)}
		</div>
	);
}

/** A line under a node: loading, empty, gone, or the next page. */
function TreeNote({ depth, children }: { depth: number; children: ReactNode }) {
	const { step } = useTree();
	// A leaf of the tree, so that the tree holds nothing but its items.
	return (
		<div
			role="treeitem"
			tabIndex={-1}
			aria-level={depth + 1}
			aria-selected={false}
			className={classes.treeNote}
			style={{ paddingInlineStart: indentOf(depth, step) + 24 }}
			data-tree-note=""
		>
			{children}
		</div>
	);
}

function MoreButton({
	depth,
	label,
	loading,
	onClick,
}: {
	depth: number;
	label: string;
	loading: boolean;
	onClick: () => void;
}) {
	return (
		<TreeNote depth={depth}>
			<Anchor
				component="button"
				type="button"
				size="sm"
				onClick={onClick}
				disabled={loading}
				data-tree-more=""
			>
				{label}
			</Anchor>
			{loading && <Loader size={12} ml={6} />}
		</TreeNote>
	);
}

function notFound(error: unknown): boolean {
	return error instanceof ApiError && error.status === 404;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spaces and groups
// ─────────────────────────────────────────────────────────────────────────────

function SpaceNode({ space, depth }: { space: OutlineTreeSpace; depth: number }) {
	const { t } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	const key = `space:${space.id}`;
	const [open, toggle] = useNodeOpen(key);
	const Icon = SPACE_ICON[space.kind];
	return (
		<TreeRow
			nodeKey={key}
			kind="space"
			depth={depth}
			open={open}
			onToggle={toggle}
			icon={<Icon size={16} />}
			title={spaceName(space)}
			to={{ kind: "space", spaceId: space.id }}
			meta={
				<>
					{space.orphaned && (
						<Badge size="xs" variant="light" color="orange" tt="none">
							{t("space.orphaned")}
						</Badge>
					)}
					{space.lastCommitAt && (
						<Text span size="xs" c="dimmed" data-tree-time="">
							{formatSmartTime(space.lastCommitAt)}
						</Text>
					)}
				</>
			}
		>
			<SpaceChildren
				space={space}
				depth={depth + 1}
				sessions={space.kind === "project" ? (space.sessions ?? null) : null}
			/>
		</TreeRow>
	);
}

/** A space's pages, then (a project) the group of its sessions. */
export function SpaceChildren({
	space,
	depth,
	sessions,
}: {
	space: Pick<OutlineSpaceSummary, "id" | "kind" | "projectId">;
	depth: number;
	/** How many sessions the project has (up to the cap); null: not counted. */
	sessions: number | null;
}) {
	return (
		<>
			<PageList spaceId={space.id} depth={depth} />
			{space.kind === "project" && space.projectId && sessions !== 0 && (
				<SessionsGroup projectId={space.projectId} count={sessions} depth={depth} />
			)}
		</>
	);
}

function SessionsGroup({
	projectId,
	count,
	depth,
}: {
	projectId: string;
	count: number | null;
	depth: number;
}) {
	const { t } = useTranslation("outline");
	const key = `group:sessions:${projectId}`;
	const [open, toggle] = useNodeOpen(key);
	const title =
		count === null
			? t("tree.sessionsUncounted")
			: t("tree.sessions", { count: treeCountLabel(count, OUTLINE_TREE_LIMITS.countCap) });
	return (
		<TreeRow
			nodeKey={key}
			kind="group"
			depth={depth}
			open={open}
			onToggle={toggle}
			icon={<IconFolders size={16} />}
			title={title}
		>
			<SpaceList group={{ kind: "project", projectId }} count={count} depth={depth + 1} />
		</TreeRow>
	);
}

/** A group of spaces (the loose sessions, the orphaned spaces) at the tree's root. */
function SpacesGroup({ kind, count }: { kind: "loose" | "orphaned"; count: number }) {
	const { t } = useTranslation("outline");
	const key = `group:${kind}`;
	const [open, toggle] = useNodeOpen(key);
	return (
		<TreeRow
			nodeKey={key}
			kind="group"
			depth={0}
			open={open}
			onToggle={toggle}
			icon={<IconFolders size={16} />}
			title={t(`tree.${kind}`, {
				count: treeCountLabel(count, OUTLINE_TREE_LIMITS.countCap),
			})}
		>
			<SpaceList group={{ kind }} count={count} depth={1} />
		</TreeRow>
	);
}

function SpaceList({
	group,
	count,
	depth,
}: {
	group: { kind: "project"; projectId: string } | { kind: "loose" | "orphaned" };
	count: number | null;
	depth: number;
}) {
	const { t } = useTranslation("outline");
	const list = useOutlineTreeSpaces(group, true);
	const spaces = list.data?.pages.flatMap((page) => page.spaces) ?? [];
	if (list.isLoading) {
		return (
			<TreeNote depth={depth}>
				<Loader size={12} />
			</TreeNote>
		);
	}
	if (list.isError) {
		return (
			<TreeNote depth={depth}>
				<Text span size="xs" c="dimmed">
					{t(notFound(list.error) ? "tree.gone" : "loadFailed")}
				</Text>
			</TreeNote>
		);
	}
	const rest =
		count !== null && count < OUTLINE_TREE_LIMITS.countCap ? count - spaces.length : null;
	return (
		<>
			{spaces.length === 0 && (
				<TreeNote depth={depth}>
					<Text span size="xs" c="dimmed">
						{t("tree.noSessions")}
					</Text>
				</TreeNote>
			)}
			{spaces.map((space) => (
				<SpaceNode key={space.id} space={space} depth={depth} />
			))}
			{list.hasNextPage && (
				<MoreButton
					depth={depth}
					loading={list.isFetchingNextPage}
					onClick={() => void list.fetchNextPage()}
					label={rest !== null && rest > 0 ? t("tree.moreSpaces", { count: rest }) : t("loadMore")}
				/>
			)}
		</>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages
// ─────────────────────────────────────────────────────────────────────────────

function PageList({ spaceId, depth }: { spaceId: string; depth: number }) {
	const { t } = useTranslation("outline");
	const pages = useOutlinePages(spaceId, true);
	const all = pages.data?.pages.flatMap((page) => page.pages) ?? [];
	if (pages.isLoading) {
		return (
			<TreeNote depth={depth}>
				<Loader size={12} />
			</TreeNote>
		);
	}
	if (pages.isError) {
		return (
			<TreeNote depth={depth}>
				<Text span size="xs" c="dimmed">
					{t(notFound(pages.error) ? "tree.gone" : "loadFailed")}
				</Text>
			</TreeNote>
		);
	}
	return (
		<>
			{all.length === 0 && (
				<TreeNote depth={depth}>
					<Text span size="xs" c="dimmed">
						{t("tree.noPages")}
					</Text>
				</TreeNote>
			)}
			{all.map((page) => (
				<PageNode key={page.id} spaceId={spaceId} page={page} depth={depth} />
			))}
			{pages.hasNextPage && (
				<MoreButton
					depth={depth}
					loading={pages.isFetchingNextPage}
					onClick={() => void pages.fetchNextPage()}
					label={t("loadMore")}
				/>
			)}
		</>
	);
}

function PageNode({
	spaceId,
	page,
	depth,
}: {
	spaceId: string;
	page: OutlinePageSummary;
	depth: number;
}) {
	const { t } = useTranslation("outline");
	const { open: state } = useTree();
	const key = `page:${page.id}`;
	const [open, toggle] = useNodeOpen(key);
	const live = useSyncExternalStore(state.subscribe, () => state.isLive(key));
	return (
		<TreeRow
			nodeKey={key}
			kind="page"
			depth={depth}
			open={open}
			onToggle={toggle}
			icon={page.isTask ? <OutlineTaskIcon status="todo" /> : <IconFileText size={16} />}
			title={page.title || page.sid}
			to={outlineBlockTarget(spaceId, page.id)}
			meta={
				page.alias ? (
					<Badge size="xs" variant="outline" color="gray" tt="none">
						{t("page.alias", { alias: page.alias })}
					</Badge>
				) : undefined
			}
		>
			<OpenPage spaceId={spaceId} pageId={page.id} depth={depth + 1} live={live} />
		</TreeRow>
	);
}

/**
 * A page opened in place: one bounded read, shown read-only by the block tree with the page's
 * default folding and the reader's own (stored per page, shared with the focused page).
 */
function OpenPage({
	spaceId,
	pageId,
	depth,
	live,
}: {
	spaceId: string;
	pageId: string;
	depth: number;
	/** Kept fresh by the page's subscription (the newest open pages only). */
	live: boolean;
}) {
	const { t, i18n } = useTranslation("outline");
	const { step, narrow, open: openState } = useTree();
	// Shown: it counts toward the open pages' limits until it is not (its parent closed).
	useEffect(() => openState.showPage(`page:${pageId}`), [openState, pageId]);
	// Everything the page holds, tasks included: reading the whole outline is reading what is
	// being done too, folded so that what is finished takes one line.
	const query = useOutlineBlock(spaceId, pageId, {
		view: "all",
		blocks: OUTLINE_TREE_LIMITS.pageBlocks,
		bytes: OUTLINE_TREE_LIMITS.pageBytes,
	});
	const view = query.data;
	// This page's own read, and nothing else, when a commit reaches it; and the questions of the
	// answer form it shows (see below).
	const queryClient = useQueryClient();
	const askingUnder = useRef<string | null>(null);
	const refreshQuestions = useCallback(() => {
		const under = askingUnder.current;
		if (!under) return;
		void queryClient.invalidateQueries({ queryKey: outlineKeys.questions(under) });
		void queryClient.invalidateQueries({ queryKey: ["human-attention"] });
	}, [queryClient]);
	// The reader's folding of the page: their own, stored per page.
	const [state] = useState(() => new OutlineViewState(pageId));
	useOutlineViewStateSync(pageId, state);
	const [version, bump] = useReducer((n: number) => n + 1, 0);
	useEffect(
		() =>
			state.on((part) => {
				if (part === "collapsed" || part === "stored") bump();
			}),
		[state],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version says the sets changed
	const fold = useMemo<FoldView>(
		() => ({ expanded: new Set(state.expanded), collapsed: new Set(state.collapsed) }),
		[state, version],
	);
	const onFold = useCallback(
		(tree: FoldTree, action: FoldAction) => {
			state.fold(tree, action);
		},
		[state],
	);
	// The count of unanswered questions on a closed row: they are opened in the tree, and the
	// form that answers them (those under the block the first is under) comes up in the page,
	// without leaving the tree.
	const host = useRef<HTMLDivElement>(null);
	const [asking, setAsking] = useState<{ ids: string[]; under: string } | null>(null);
	askingUnder.current = asking?.under ?? null;
	// Subscribed while it is among the newest open pages, or while its answer form is open.
	useOutlineTreePageLive(view, query.isFetching, live || asking !== null, refreshQuestions);
	const onOpenQuestions = useCallback(
		(ids: string[], under: string | null) => setAsking({ ids, under: under ?? pageId }),
		[pageId],
	);
	// Once nothing is left to answer, the form goes (a later question does not bring it back).
	const questions = useOutlineQuestions(asking?.under ?? null, asking !== null);
	const answered =
		questions.isSuccess &&
		(questions.data?.questions ?? []).every((question) => question.state !== "open");
	useEffect(() => {
		if (answered) setAsking(null);
	}, [answered]);
	useEffect(() => {
		const root = host.current;
		if (!asking || !root) return;
		const focusForm = (): boolean => {
			for (const id of asking.ids) {
				const card = root.querySelector<HTMLElement>(`[data-testid="outline-question-${id}"]`);
				if (!card) continue;
				card.scrollIntoView({ block: "nearest" });
				card.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled)")?.focus();
				return true;
			}
			return false;
		};
		if (focusForm()) return;
		// The form arrives with its read (bounded: a few seconds, then quiet).
		const watch = new MutationObserver(() => {
			if (focusForm()) watch.disconnect();
		});
		watch.observe(root, { childList: true, subtree: true });
		const timer = setTimeout(() => watch.disconnect(), 8000);
		return () => {
			clearTimeout(timer);
			watch.disconnect();
		};
	}, [asking]);

	const pad = indentOf(depth, step);
	if (query.isLoading) {
		return (
			<TreeNote depth={depth}>
				<Loader size={12} />
			</TreeNote>
		);
	}
	if (!view) {
		return (
			<TreeNote depth={depth}>
				<Text span size="xs" c="dimmed">
					{t(notFound(query.error) ? "tree.gone" : "loadFailed")}
				</Text>
			</TreeNote>
		);
	}
	const root = view.blocks.find((b) => b.id === view.rootId);
	const title = root ? blockTitle(root.content) : "";
	const body = root && root.content.trim() !== title.trim() ? root.content : null;
	const partial = view.blocks.some((b) => b.hidden > 0) || view.pageTruncated;
	return (
		<div
			ref={host}
			className={classes.treePage}
			style={{ paddingInlineStart: pad }}
			data-tree-page={pageId}
			data-live={live || undefined}
		>
			{body && root && (
				<Box className={classes.content} mb={4} pl={24}>
					{reportLineDisplay(root.content, { t, locale: i18n?.language }) ?? (
						<OutlineBlockBody content={body} />
					)}
				</Box>
			)}
			<OutlineBlockTree
				view={view}
				fold={fold}
				search={{}}
				onFold={onFold}
				onOpenQuestions={onOpenQuestions}
				indent={{
					step,
					// Narrow: the tree and the page together indent at most 4 levels (one more for
					// a page already that deep, so its rows still nest).
					max: narrow
						? Math.max(1, MAX_TREE_INDENT - Math.min(depth, MAX_TREE_INDENT))
						: MAX_TREE_INDENT * 2,
				}}
			/>
			{partial && (
				<Text size="xs" c="dimmed" mt={2} pl={24} data-tree-partial="">
					{t("tree.partial", { count: view.blocks.length })}{" "}
					<OutlineLink to={outlineBlockTarget(spaceId, pageId)} className={classes.more}>
						{t("tree.openPage")}
					</OutlineLink>
				</Text>
			)}
			{asking && view.current && (
				<Paper withBorder p="sm" my="sm" ml={24} data-testid="outline-tree-questions">
					<OutlineQuestionsForm blockId={asking.under} showOpenLink={false} live={false} />
				</Paper>
			)}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The tree
// ─────────────────────────────────────────────────────────────────────────────

function RecentGroup() {
	const { t, i18n } = useTranslation("outline");
	const [open, toggle] = useNodeOpen("group:recent");
	const recents = useMemo(() => readOutlineRecents(), []);
	if (recents.length === 0) return null;
	return (
		<TreeRow
			nodeKey="group:recent"
			kind="group"
			depth={0}
			open={open}
			onToggle={toggle}
			icon={<IconClock size={16} />}
			title={t("tree.recent", { count: recents.length })}
		>
			{recents.map((recent) => (
				<TreeNote key={recent.blockId} depth={1}>
					<OutlineLink
						to={outlineBlockTarget(recent.spaceId, recent.blockId)}
						className={classes.treeRecent}
					>
						<span className={classes.ellipsis}>
							{reportLineDisplay(recent.title, { t, locale: i18n?.language }) ?? recent.title}
						</span>
						<Text span size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{formatSmartTime(new Date(recent.visitedAt).toISOString())}
						</Text>
					</OutlineLink>
				</TreeNote>
			))}
		</TreeRow>
	);
}

function RootChildren() {
	const { t } = useTranslation("outline");
	const { mutate: ensurePersonal } = useEnsurePersonalOutlineSpace();
	const ensured = useRef(false);
	useEffect(() => {
		if (ensured.current) return;
		ensured.current = true;
		ensurePersonal();
	}, [ensurePersonal]);
	const tree = useOutlineTree();
	if (tree.isLoading) return <Loader size="sm" />;
	if (tree.isError || !tree.data) {
		return (
			<Alert color="red" variant="light">
				{t("loadFailed")}
			</Alert>
		);
	}
	const first = tree.data.pages[0];
	const projects = tree.data.pages.flatMap((page) => page.projects);
	const empty = !first?.personal && projects.length === 0 && !first?.loose && !first?.orphaned;
	return (
		<>
			<RecentGroup />
			{first?.personal && <SpaceNode space={first.personal} depth={0} />}
			{projects.map((space) => (
				<SpaceNode key={space.id} space={space} depth={0} />
			))}
			{tree.hasNextPage && (
				<MoreButton
					depth={0}
					loading={tree.isFetchingNextPage}
					onClick={() => void tree.fetchNextPage()}
					label={t("tree.moreProjects")}
				/>
			)}
			{(first?.loose ?? 0) > 0 && <SpacesGroup kind="loose" count={first?.loose ?? 0} />}
			{(first?.orphaned ?? 0) > 0 && <SpacesGroup kind="orphaned" count={first?.orphaned ?? 0} />}
			{empty && (
				<Text size="sm" c="dimmed">
					{t("home.noSpaces")}
				</Text>
			)}
		</>
	);
}

export interface OutlineTreeProps {
	/**
	 * The tree's root: the whole outline, or one space (its pages and, a project, its sessions;
	 * the host shows the space itself above).
	 */
	root: { kind: "all" } | { kind: "space"; space: OutlineSpaceSummary };
	/** Where it is shown: the outline page and the dock panels keep their own open nodes. */
	host?: TreeHost;
}

/** The arrow keys on a row's title (design §2.5): move between rows, open and close. */
function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	const target = event.target as HTMLElement;
	if (!target.matches("[data-tree-title]")) return;
	const row = target.closest<HTMLElement>("[data-tree-node]");
	if (!row) return;
	const titles = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-title]")];
	const at = titles.indexOf(target);
	const move = (to: number) => {
		const next = titles[Math.max(0, Math.min(titles.length - 1, to))];
		next?.focus();
	};
	const toggle = () => row.querySelector<HTMLButtonElement>("[data-tree-toggle]")?.click();
	const open = row.dataset.open === "true";
	switch (event.key) {
		case "ArrowDown":
			move(at + 1);
			break;
		case "ArrowUp":
			move(at - 1);
			break;
		case "Home":
			move(0);
			break;
		case "End":
			move(titles.length - 1);
			break;
		case "ArrowRight":
			if (open) move(at + 1);
			else toggle();
			break;
		case "ArrowLeft": {
			if (open) {
				toggle();
				break;
			}
			// Closed, or a leaf: to the row it is under.
			const parent = row
				.closest("[role=treeitem]")
				?.parentElement?.closest<HTMLElement>("[role=treeitem]")
				?.querySelector<HTMLElement>("[data-tree-title]");
			parent?.focus();
			break;
		}
		default:
			return;
	}
	event.preventDefault();
}

export function OutlineTree({ root, host = "page" }: OutlineTreeProps) {
	const { t } = useTranslation("outline");
	const [open] = useState(() => new TreeOpenState(treeOpenStorageKey(host)));
	const { ref, width } = useElementSize();
	const narrow = width > 0 && width < NARROW_PX;
	const step = narrow ? 12 : 18;
	const value = useMemo(() => ({ open, step, narrow }), [open, step, narrow]);
	const anyOpen = useSyncExternalStore(open.subscribe, () => open.snapshot().length > 0);
	return (
		<TreeContext.Provider value={value}>
			<Box ref={ref} className={classes.tree} data-testid="outline-tree" data-narrow={narrow}>
				<Group justify="space-between" gap="xs" wrap="nowrap" mb={4}>
					<Text size="xs" c="dimmed" className={classes.ellipsis}>
						{t("tree.hint")}
					</Text>
					{anyOpen && (
						<Button
							size="compact-xs"
							variant="subtle"
							color="gray"
							onClick={() => open.clear()}
							data-testid="outline-tree-collapse-all"
						>
							{t("tree.collapseAll")}
						</Button>
					)}
				</Group>
				<div role="tree" aria-label={t("title")} onKeyDown={onTreeKeyDown}>
					{root.kind === "all" ? (
						<RootChildren />
					) : (
						<SpaceChildren space={root.space} depth={0} sessions={null} />
					)}
				</div>
			</Box>
		</TreeContext.Provider>
	);
}
