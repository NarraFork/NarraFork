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
 * AT A GLANCE (readability F): a space's row says what waits for the reader first (questions put
 * to them that they may answer), then how many tasks are in progress, one line of what is being
 * done, and "read only" where they may not write. A page is read FOLDED (`fold: "default"`): the
 * server leaves out what is behind rows closed by the page's default and the reader's own stored
 * folding, so a big task page shows its open work; a row the reader opens whose blocks were left
 * out is stored open at once and the page read again. Alt+Enter on a row's title (Alt on its
 * arrow) opens everything inside it, or closes it all: a space or group its loaded rows (one
 * level is read per step), a page all of its blocks. A block is LOCATED by opening what it is
 * under and scrolling to it (`tree-locate.ts`), and the tree comes back where the reader left it
 * (`tree-scroll.ts`).
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
import { useElementSize, useMergedRef } from "@mantine/hooks";
import { blockTitle } from "@shared/outline";
import {
	OUTLINE_BLOCK_ID_RE,
	OUTLINE_TREE_LIMITS,
	OUTLINE_VIEW_STATE_LIMITS,
	type OutlinePageSummary,
	type OutlineSpaceSummary,
	type OutlineTreeSpace,
} from "@shared/outline-api";
import {
	boundedFoldView,
	type FoldAction,
	type FoldTree,
	type FoldView,
	foldPageControl,
} from "@shared/outline-fold";
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
	useLayoutEffect,
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
import { ApiError, api } from "../../../lib/api";
import { formatSmartTime } from "../../../lib/format";
import { readOutlineRecents } from "../../../lib/outline-recents";
import { reportLineDisplay } from "../../../lib/outline-report-line";
import { viewFoldSource, viewFoldTree } from "../../../lib/outline-view";
import { plainClick } from "../fold-controls";
import classes from "../Outline.module.css";
import { OutlineBlockBody } from "../OutlineBlockBody";
import { OutlineBlockTree, OutlineTaskIcon } from "../OutlineBlockTree";
import { OutlineQuestionsForm } from "../OutlineQuestions";
import { useOutlineSpaceName } from "../OutlineSpaceName";
import { OutlineStatusChip, OutlineStatusIcon } from "../OutlineStatusIcon";
import { FOLD_ICONS, QUESTION_ICON } from "../outline-icons";
import { OutlineLink, outlineBlockTarget } from "../outline-nav";
import { OutlineViewState } from "../view-state";
import { locateKeys, type TreeLocateTarget, takeTreeLocate } from "./tree-locate";
import {
	isPageKey,
	type TreeHost,
	TreeOpenState,
	treeCountLabel,
	treeOpenStorageKey,
} from "./tree-open-state";
import {
	captureTreeAnchor,
	readTreeAnchor,
	restoreTreeAnchor,
	scrollParentOf,
	TREE_SCROLL_WAIT_MS,
	writeTreeAnchor,
} from "./tree-scroll";

/** Reads one "everything inside" may follow (each brings the next level of what was left out). */
const OPEN_INSIDE_READS = 4;
/** How long a locate waits for its row before saying it could not be shown. */
const LOCATE_WAIT_MS = 10_000;
/** Reads one locate waits for inside a page before settling for the page's row. */
const LOCATE_READS = 4;
/** Tree levels indentation grows for; deeper rows line up with the last. */
const MAX_TREE_INDENT = 4;
/** Below this width the tree is narrow: smaller steps (a phone, a narrow dock panel). */
const NARROW_PX = 480;

/** Rows shown although their list has not loaded them: a located block's space and page. */
interface TreePins {
	/** By the list they are in: `root`, or a group's key. */
	spaces: ReadonlyMap<string, OutlineTreeSpace>;
	/** By space. */
	pages: ReadonlyMap<string, OutlinePageSummary>;
}

const NO_PINS: TreePins = { spaces: new Map(), pages: new Map() };

/** A block being located: its page's read opens its ancestors and scrolls to it. */
interface ActiveLocate extends TreeLocateTarget {
	nonce: number;
}

/**
 * "Everything inside" asked of a page's row before (or while) its content is there: the page's
 * own read applies it once it has its blocks.
 */
class PageCommands {
	private readonly waiting = new Set<string>();
	private readonly handlers = new Map<string, () => void>();

	foldAll(pageId: string): void {
		const handler = this.handlers.get(pageId);
		if (handler) handler();
		else this.waiting.add(pageId);
	}

	register(pageId: string, handler: () => void): () => void {
		this.handlers.set(pageId, handler);
		if (this.waiting.delete(pageId)) handler();
		return () => {
			if (this.handlers.get(pageId) === handler) this.handlers.delete(pageId);
		};
	}
}

interface TreeContextValue {
	open: TreeOpenState;
	/** Pixels per level. */
	step: number;
	/** A phone or a narrow panel: indentation, tree and page together, stops at 4 levels. */
	narrow: boolean;
	pins: TreePins;
	locate: ActiveLocate | null;
	/**
	 * The request is done: the block is on screen (`found`), or it could not be brought there
	 * (the tree says so in a line).
	 */
	finishLocate: (nonce: number, found?: boolean) => void;
	/** Locate a block from inside the tree (a row's "waiting for you"). */
	locateTo: (target: TreeLocateTarget) => void;
	/** The tree's element (rows are found in it by their key). */
	rootRef: { readonly current: HTMLDivElement | null };
	/** Nodes whose rows open as they load, one level down (Alt+Enter on a closed node). */
	wishes: Set<string>;
	commands: PageCommands;
}

/** The key of the row a row is under (its wish opens the row as it loads). */
const ParentKeyContext = createContext<string | null>(null);

const TreeContext = createContext<TreeContextValue | null>(null);

function useTree(): TreeContextValue {
	const value = useContext(TreeContext);
	if (!value) throw new Error("OutlineTree: no tree");
	return value;
}

function rowOf(root: HTMLElement | null, key: string): HTMLElement | null {
	if (!root) return null;
	for (const row of root.querySelectorAll<HTMLElement>("[data-tree-node]")) {
		if (row.dataset.treeNode === key) return row;
	}
	return null;
}

/**
 * Whether a node is open, and its toggle. With `alt` (Alt on the arrow, Alt+Enter on the title):
 * everything inside. Closed, or with something closed inside: the node and the rows loaded under
 * it open (pages keep their own limit and are left alone), and the rows one level down open as
 * they load. All open: the node and everything under it close.
 */
function useNodeOpen(key: string): [boolean, (alt?: boolean) => void] {
	const { open, rootRef, wishes } = useTree();
	const isOpen = useSyncExternalStore(open.subscribe, () => open.isOpen(key));
	const toggle = useCallback(
		(alt = false) => {
			if (!alt) {
				wishes.delete(key);
				open.toggle(key);
				return;
			}
			const item = rowOf(rootRef.current, key)?.closest("[role=treeitem]");
			const inside = [...(item?.querySelectorAll<HTMLElement>("[data-tree-node]") ?? [])]
				.map((row) => row.dataset.treeNode ?? "")
				.filter((k) => k !== "" && k !== key);
			const inner = inside.filter((k) => !isPageKey(k));
			if (open.isOpen(key) && inner.every((k) => open.isOpen(k))) {
				wishes.delete(key);
				open.setMany([...inside, key], false);
			} else {
				wishes.add(key);
				open.setMany([key, ...inner], true);
			}
		},
		[open, key, rootRef, wishes],
	);
	return [isOpen, toggle];
}

/** Bring a row on screen and mark it for a moment (a located block, a located page). */
function showLocated(element: HTMLElement): void {
	element.scrollIntoView({ block: "center" });
	element.setAttribute("data-located", "");
	setTimeout(() => element.removeAttribute("data-located"), 2400);
}

function indentOf(depth: number, step: number): number {
	return Math.min(depth, MAX_TREE_INDENT) * step;
}

export const SPACE_ICON = {
	personal: IconUser,
	project: IconFolder,
	session: IconMessages,
} as const;

/** One row of the tree: its arrow, icon, title (a link that focuses it), and what it says. */
function TreeRow({
	nodeKey,
	depth,
	open,
	onToggle,
	icon,
	title,
	to,
	summary,
	meta,
	kind,
	children,
}: {
	nodeKey: string;
	depth: number;
	open: boolean;
	/** `alt`: everything inside (Alt on the arrow, Alt+Enter on the title). */
	onToggle: (alt?: boolean) => void;
	icon: ReactNode;
	title: string;
	/** Where the title goes (focus); a group's title opens it instead. */
	to?: Parameters<typeof OutlineLink>[0]["to"];
	/** The row's one line: beside the title, or under it where the tree is narrow. */
	summary?: ReactNode;
	meta?: ReactNode;
	kind: "space" | "page" | "group";
	/** What the node holds, shown (in its group) while it is open. */
	children?: ReactNode;
}) {
	const { t } = useTranslation("outline");
	const { step, narrow, wishes } = useTree();
	const { Icon: Arrow } = FOLD_ICONS[open ? "expanded" : "collapsed"];
	const action = t(open ? "page.collapse" : "page.expand");
	// Loaded under a node asked to open everything inside it: this row opens too (not a page:
	// pages keep their own limit).
	const parentKey = useContext(ParentKeyContext);
	const wished = useRef(kind !== "page" && parentKey !== null && wishes.has(parentKey) && !open);
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, as the row arrives
	useEffect(() => {
		if (wished.current) onToggle(false);
	}, []);
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
						title={`${action} · ${t("fold.altHint")}`}
						data-tree-toggle=""
						onClick={(event) => {
							if (plainClick(event)) onToggle(event.altKey);
						}}
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
						onClick={(event) => onToggle(event.altKey)}
						data-tree-title=""
					>
						{title}
					</button>
				)}
				{summary && !narrow && (
					<span className={classes.treeSummary} data-tree-summary="">
						{summary}
					</span>
				)}
				{meta && <span className={classes.treeMeta}>{meta}</span>}
			</div>
			{summary && narrow && (
				<div
					className={classes.treeSummaryLine}
					style={{ paddingInlineStart: indentOf(depth, step) + 48 }}
					data-tree-summary=""
				>
					{summary}
				</div>
			)}
			{open && children !== undefined && (
				<ParentKeyContext.Provider value={nodeKey}>
					{/* biome-ignore lint/a11y/useSemanticElements: a tree item's children, not a form's fields */}
					<div role="group">{children}</div>
				</ParentKeyContext.Provider>
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
	const { narrow, locateTo } = useTree();
	const key = `space:${space.id}`;
	const [open, toggle] = useNodeOpen(key);
	const Icon = SPACE_ICON[space.kind];
	const waiting = space.waiting ?? 0;
	const doing = space.doing ?? 0;
	const waitingText = treeCountLabel(waiting, OUTLINE_TREE_LIMITS.countCap);
	const asks = waiting > 0 ? (space.waitingAt ?? null) : null;
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
			summary={
				space.summary ? (
					<>
						{space.summary.kind !== "note" && (
							<OutlineStatusIcon
								status={space.summary.kind === "doing" ? "doing" : "done"}
								size={12}
							/>
						)}
						<span className={classes.ellipsis} title={space.summary.text}>
							{space.summary.kind === "note"
								? space.summary.text
								: t(`tree.summary.${space.summary.kind}`, { text: space.summary.text })}
						</span>
					</>
				) : undefined
			}
			meta={
				<>
					{/* What waits for the reader comes first. */}
					{waiting > 0 && (
						<Badge
							// The first question waiting for the reader there: shown in the tree, its
							// answer form with it. (An older server does not say where: no button.)
							{...(asks
								? {
										component: "button" as const,
										type: "button" as const,
										style: { cursor: "pointer" },
										onClick: () =>
											locateTo({
												spaceId: space.id,
												pageId: asks.pageId,
												blockId: asks.blockId,
												pathIds: [],
												pageTitle: asks.pageTitle ?? "",
												answer: true,
											}),
									}
								: {})}
							size="xs"
							variant="light"
							color="teal"
							tt="none"
							leftSection={<QUESTION_ICON.Icon size={10} aria-hidden />}
							title={t(asks ? "tree.waitingAction" : "tree.waitingLabel", { count: waiting })}
							aria-label={t(asks ? "tree.waitingAction" : "tree.waitingLabel", {
								count: waiting,
							})}
							data-tree-count="waiting"
						>
							{narrow ? waitingText : t("tree.waiting", { n: waitingText })}
						</Badge>
					)}
					{doing > 0 && (
						<OutlineStatusChip
							status="doing"
							title={t("tree.doingLabel", { count: doing })}
							aria-label={t("tree.doingLabel", { count: doing })}
							data-tree-count="doing"
						>
							{treeCountLabel(doing, OUTLINE_TREE_LIMITS.countCap)}
						</OutlineStatusChip>
					)}
					{space.orphaned && (
						<Badge size="xs" variant="light" color="orange" tt="none">
							{t("space.orphaned")}
						</Badge>
					)}
					{space.canWrite === false && !space.orphaned && (
						<Badge size="xs" variant="outline" color="gray" tt="none" data-tree-read-only="">
							{t("space.readOnly")}
						</Badge>
					)}
					{space.lastCommitAt && !narrow && (
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
			<SpaceList
				group={{ kind: "project", projectId }}
				pinKey={key}
				count={count}
				depth={depth + 1}
			/>
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
			<SpaceList group={{ kind }} pinKey={key} count={count} depth={1} />
		</TreeRow>
	);
}

function SpaceList({
	group,
	pinKey,
	count,
	depth,
}: {
	group: { kind: "project"; projectId: string } | { kind: "loose" | "orphaned" };
	/** The group's node key: a located space not loaded yet is shown first. */
	pinKey: string;
	count: number | null;
	depth: number;
}) {
	const { t } = useTranslation("outline");
	const { pins } = useTree();
	const list = useOutlineTreeSpaces(group, true);
	const loaded = list.data?.pages.flatMap((page) => page.spaces) ?? [];
	const pinned = pins.spaces.get(pinKey);
	const spaces =
		pinned && !loaded.some((space) => space.id === pinned.id) ? [pinned, ...loaded] : loaded;
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
		count !== null && count < OUTLINE_TREE_LIMITS.countCap ? count - loaded.length : null;
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
	const { pins } = useTree();
	const pages = useOutlinePages(spaceId, true);
	const loaded = pages.data?.pages.flatMap((page) => page.pages) ?? [];
	// A located page past what the list has loaded is shown first.
	const pinned = pins.pages.get(spaceId);
	const all =
		pinned && !loaded.some((page) => page.id === pinned.id) ? [pinned, ...loaded] : loaded;
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
	const { open: state, commands } = useTree();
	const key = `page:${page.id}`;
	const [open, toggle] = useNodeOpen(key);
	const live = useSyncExternalStore(state.subscribe, () => state.isLive(key));
	// Alt: everything inside the page (its blocks), opening the page first when it is closed.
	const onToggle = useCallback(
		(alt = false) => {
			if (!alt) return toggle();
			if (!state.isOpen(key)) toggle();
			commands.foldAll(page.id);
		},
		[toggle, state, key, commands, page.id],
	);
	return (
		<TreeRow
			nodeKey={key}
			kind="page"
			depth={depth}
			open={open}
			onToggle={onToggle}
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
	const { step, narrow, open: openState, commands, locate, finishLocate } = useTree();
	// Shown: it counts toward the open pages' limits until it is not (its parent closed).
	useEffect(() => openState.showPage(`page:${pageId}`), [openState, pageId]);
	// Everything the page holds, tasks included: reading the whole outline is reading what is
	// being done too, folded so that what is finished takes one line. The read itself is folded
	// (the server knows the page's default and the reader's stored folding): its budget goes to
	// what is shown open, not to what is behind finished tasks and reports.
	const query = useOutlineBlock(spaceId, pageId, {
		view: "all",
		blocks: OUTLINE_TREE_LIMITS.pageBlocks,
		bytes: OUTLINE_TREE_LIMITS.pageBytes,
		fold: "default",
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
	// Until the stored folding is under what this page shows, nothing folds or writes on the
	// reader's behalf: the server folded the read by the STORED state, and a state that never
	// saw it would be written over it.
	const sync = useOutlineViewStateSync(pageId, state);
	const stored = sync === "applied";
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
	// "Everything inside" a row (or the page) whose blocks the folded read left out: what the
	// reader asked to see whole is opened again in each read that brings more of it, a few times.
	const openInside = useRef(new Map<string, number>());
	const onFold = useCallback(
		(tree: FoldTree, action: FoldAction) => {
			if ((action.kind === "subtree" || action.kind === "all") && action.open) {
				openInside.current.set(action.kind === "all" ? tree.rootId : action.id, OPEN_INSIDE_READS);
			} else if (action.kind !== "reveal") {
				// Closing anything is the reader's word against it.
				openInside.current.clear();
			}
			state.fold(tree, action);
		},
		[state],
	);
	const foldTree = useMemo(
		() => (view ? viewFoldTree(view, viewFoldSource(view), fold) : null),
		[view, fold],
	);
	// Rows the reader has open (and on screen) whose blocks the folded read left out: their
	// folding is stored now (not after the usual delay) and the page read again, which brings
	// them. The same rows left out twice means the server will not bring them (the view state's
	// own limits): they keep their link to the page focused.
	const missing = useMemo(() => {
		if (!view || !foldTree || !stored) return "";
		return view.blocks
			.filter((block) => {
				if (!block.fold) return false;
				const node = foldTree.nodes.get(block.id);
				return !!node && node.open && node.visible;
			})
			.map((block) => block.id)
			.join(",");
	}, [view, foldTree, stored]);
	const askedFor = useRef("");
	// Between storing the folding and the read that follows it.
	const [storing, setStoring] = useState(false);
	const alive = useRef(true);
	useEffect(
		() => () => {
			alive.current = false;
		},
		[],
	);
	const fetching = query.isFetching;
	useEffect(() => {
		if (missing === "") {
			askedFor.current = "";
			return;
		}
		if (fetching || askedFor.current === missing) return;
		askedFor.current = missing;
		setStoring(true);
		const ok = (ids: Iterable<string>) =>
			new Set([...ids].filter((id) => OUTLINE_BLOCK_ID_RE.test(id)));
		const folding = boundedFoldView(
			{ expanded: ok(state.expanded), collapsed: ok(state.collapsed) },
			OUTLINE_VIEW_STATE_LIMITS.maxCollapsed,
		);
		void api
			.putOutlineViewState(pageId, { ...folding, layout: state.layout })
			.catch(() => undefined)
			.then(() => {
				if (!alive.current) return;
				return queryClient.invalidateQueries({
					queryKey: outlineKeys.blocks(spaceId),
					predicate: (q) => q.queryKey[3] === pageId && q.queryKey[4] === null,
				});
			})
			.finally(() => {
				if (alive.current) setStoring(false);
			});
	}, [missing, fetching, state, pageId, spaceId, queryClient]);
	// A read arrived: what was asked to open whole opens in what came with it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per read, not per folding
	useEffect(() => {
		if (!foldTree || openInside.current.size === 0) return;
		for (const [id, reads] of [...openInside.current]) {
			const changed =
				reads > 0 && foldTree.nodes.has(id)
					? state.fold(foldTree, { kind: "subtree", id, open: true })
					: false;
			if (changed) openInside.current.set(id, reads - 1);
			else openInside.current.delete(id);
		}
	}, [view]);
	// Alt+Enter on the page's row: everything inside open, or back to the default view.
	const [allAsked, askAll] = useReducer((n: number) => n + 1, 0);
	useEffect(() => commands.register(pageId, askAll), [commands, pageId]);
	const allDone = useRef(0);
	useEffect(() => {
		if (allAsked === allDone.current || !foldTree || sync === "pending") return;
		allDone.current = allAsked;
		const control = foldPageControl(foldTree, fold);
		if (control) onFold(foldTree, { kind: "all", open: control === "expand" });
	}, [allAsked, foldTree, fold, onFold, sync]);
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

	// Locating a block of this page: everything it is under is opened at once (its ancestors by
	// id, in the read or not), so one stored folding and one read bring it however many closed
	// rows it was behind; then its row is scrolled to. A read that still does not hold it (the
	// budget) settles for the page's row.
	const locating = locate && locate.pageId === pageId && locate.blockId !== pageId ? locate : null;
	const locateReads = useRef<{ nonce: number; left: number; seen: unknown }>({
		nonce: 0,
		left: 0,
		seen: null,
	});
	useEffect(() => {
		if (!locating || !foldTree || !view || sync === "pending") return;
		const at = locateReads.current;
		if (at.nonce !== locating.nonce) {
			locateReads.current = { nonce: locating.nonce, left: LOCATE_READS, seen: null };
		}
		const done = (row: HTMLElement | null, found: boolean) => {
			if (row) showLocated(row);
			finishLocate(locating.nonce, found);
		};
		const pageRow = () =>
			host.current
				?.closest("[role=treeitem]")
				?.querySelector<HTMLElement>(":scope > [data-tree-node]") ?? null;
		const node = foldTree.nodes.get(locating.blockId);
		if (node?.visible) {
			let found: HTMLElement | null = null;
			for (const row of host.current?.querySelectorAll<HTMLElement>("[data-block-id]") ?? []) {
				if (row.dataset.blockId === locating.blockId) found = row;
			}
			if (found && locating.answer) onOpenQuestions([locating.blockId], node.parent);
			done(found ?? pageRow(), found !== null);
			return;
		}
		if (node) {
			// In the read, behind closed rows: open them.
			state.fold(foldTree, { kind: "reveal", id: locating.blockId });
			return;
		}
		if (fetching || storing || missing !== "") return;
		// Not in this read, and nothing is being read. Each read is one try: it opens every
		// ancestor that is closed (those the read does not hold are behind a closed row, so
		// they are opened by id; one open by default is left alone). Tried on this read
		// already, or nothing left to open: the block is past what one read holds (the
		// budget, not the folding), which is said at once.
		if (locateReads.current.seen === view) return done(pageRow(), false);
		locateReads.current.seen = view;
		if (locateReads.current.left-- <= 0) return done(pageRow(), false);
		let changed = false;
		for (const id of locating.pathIds) {
			if (id === pageId || state.expanded.has(id)) continue;
			const above = foldTree.nodes.get(id);
			if (above && (above.open || above.kids.length === 0) && !above.report) continue;
			state.expanded.add(id);
			state.collapsed.delete(id);
			changed = true;
		}
		if (changed) state.noteCollapsed();
		else done(pageRow(), false);
	}, [
		locating,
		foldTree,
		view,
		state,
		fetching,
		missing,
		finishLocate,
		sync,
		pageId,
		onOpenQuestions,
		storing,
	]);

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
	// What a closed row holds back is not "more than fits": opening the row reads it. A row that
	// is open and still without its blocks (they were asked for and did not come, or the stored
	// folding could not be laid under this page) is: the page focused shows them.
	const stuck =
		!fetching &&
		!storing &&
		view.blocks.some((b) => {
			if (!b.fold || b.hidden <= 0) return false;
			const node = foldTree?.nodes.get(b.id);
			return !!node && node.open && node.visible;
		}) &&
		(sync === "unseen" || (missing !== "" && askedFor.current === missing));
	// (`unseen`: the stored folding could not be read, so nothing is written for this page and
	// the server keeps folding by what is stored.)
	const partial = view.blocks.some((b) => b.hidden > 0 && !b.fold) || view.pageTruncated || stuck;
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
				<Text size="xs" c="dimmed" mt={2} pl={24} data-tree-partial={stuck ? "stuck" : ""}>
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
	const { pins } = useTree();
	if (tree.isLoading) return <Loader size="sm" />;
	if (tree.isError || !tree.data) {
		return (
			<Alert color="red" variant="light">
				{t("loadFailed")}
			</Alert>
		);
	}
	const first = tree.data.pages[0];
	const listed = tree.data.pages.flatMap((page) => page.projects);
	// A located project past what the root has loaded is shown first.
	const pinned = pins.spaces.get("root");
	const projects =
		pinned && pinned.id !== first?.personal?.id && !listed.some((s) => s.id === pinned.id)
			? [pinned, ...listed]
			: listed;
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
	/**
	 * A block to bring on screen (a search hit): what it is under opens, and the tree scrolls to
	 * it. A new object locates again. A request left by a focused page (`requestTreeLocate`) is
	 * taken when the tree mounts.
	 */
	locate?: TreeLocateTarget | null;
	/**
	 * Kept but not shown (a search is drawn in its place): what is open stays, and it comes back
	 * where the reader left it.
	 */
	hidden?: boolean;
}

/** The arrow keys on a row's title (design §2.5): move between rows, open and close. */
export function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
	if (event.ctrlKey || event.metaKey || event.shiftKey) return;
	const target = event.target as HTMLElement;
	if (!target.matches("[data-tree-title]")) return;
	const row = target.closest<HTMLElement>("[data-tree-node]");
	if (!row) return;
	if (event.altKey) {
		// Alt+Enter: everything inside the row, as Alt on its arrow (PR C's controls).
		if (event.key !== "Enter" || event.repeat) return;
		event.preventDefault();
		event.stopPropagation();
		row
			.querySelector<HTMLButtonElement>("[data-tree-toggle]")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
		return;
	}
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

/** Wait (bounded) until `find` returns an element of the tree, then hand it over. */
function whenThere(
	root: HTMLElement,
	find: () => HTMLElement | null,
	then: (element: HTMLElement | null) => void,
	waitMs: number,
): () => void {
	const now = find();
	if (now) {
		then(now);
		return () => {};
	}
	let done = false;
	const finish = (element: HTMLElement | null) => {
		if (done) return;
		done = true;
		watch.disconnect();
		clearTimeout(timer);
		then(element);
	};
	const watch = new MutationObserver(() => {
		const found = find();
		if (found) finish(found);
	});
	watch.observe(root, { childList: true, subtree: true });
	const timer = setTimeout(() => finish(null), waitMs);
	return () => {
		done = true;
		watch.disconnect();
		clearTimeout(timer);
	};
}

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * Keep the tree where the reader left it (`tree-scroll.ts`): the anchor is taken as the tree
 * goes (it unmounts, or a search is drawn in its place), and put back when the tree mounts or is
 * shown again, once its row has loaded; the reader scrolling (or locating a block) first wins.
 * Listens only on the tree and on what scrolls it (never the window or the document: the tree
 * may be one of several on screen).
 */
function useTreeScroll(
	rootRef: { readonly current: HTMLDivElement | null },
	name: string,
	hidden: boolean,
	skip: boolean,
): void {
	const skipped = useRef(skip);
	skipped.current = skip;
	// Going out of sight for a search: taken now, while the tree is still laid out.
	const wasHidden = useRef(hidden);
	if (hidden && !wasHidden.current && rootRef.current) {
		writeTreeAnchor(name, captureTreeAnchor(rootRef.current));
	}
	wasHidden.current = hidden;
	// Unmounting: taken before the tree's rows leave the document.
	useLayoutEffect(
		() => () => {
			const tree = rootRef.current;
			if (tree && !wasHidden.current) writeTreeAnchor(name, captureTreeAnchor(tree));
		},
		[rootRef, name],
	);
	// Restore, when shown (again).
	useEffect(() => {
		const tree = rootRef.current;
		const anchor = hidden ? null : readTreeAnchor(name);
		if (!tree || !anchor || skipped.current) return;
		// The reader scrolling themselves: a wheel or a touch over what scrolls the tree, a
		// scrolling key in the tree.
		const scroller = scrollParentOf(tree);
		const stop = whenThere(
			tree,
			() => (restoreTreeAnchor(tree, anchor) ? tree : null),
			() => off(),
			TREE_SCROLL_WAIT_MS,
		);
		const cancel = (event: Event) => {
			if (event.type === "keydown" && !SCROLL_KEYS.has((event as globalThis.KeyboardEvent).key))
				return;
			off();
		};
		const off = () => {
			stop();
			scroller.removeEventListener("wheel", cancel);
			scroller.removeEventListener("touchmove", cancel);
			tree.removeEventListener("keydown", cancel);
		};
		scroller.addEventListener("wheel", cancel, { passive: true });
		scroller.addEventListener("touchmove", cancel, { passive: true });
		tree.addEventListener("keydown", cancel);
		return off;
	}, [rootRef, name, hidden]);
}

export function OutlineTree({
	root,
	host = "page",
	locate: asked = null,
	hidden = false,
}: OutlineTreeProps) {
	const { t } = useTranslation("outline");
	const [open] = useState(() => new TreeOpenState(treeOpenStorageKey(host)));
	const { ref: sizeRef, width } = useElementSize();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const ref = useMergedRef(sizeRef, rootRef);
	const narrow = width > 0 && width < NARROW_PX;
	const step = narrow ? 12 : 18;
	const [wishes] = useState(() => new Set<string>());
	const [commands] = useState(() => new PageCommands());
	const [pins, setPins] = useState<TreePins>(NO_PINS);
	const [locate, setLocate] = useState<ActiveLocate | null>(null);
	// The request last brought to its end (found, or given up): the tree is the reader's again.
	const [settled, setSettled] = useState<TreeLocateTarget | null>(null);
	const latest = useRef<{ nonce: number; target: TreeLocateTarget | null }>({
		nonce: 0,
		target: null,
	});
	// The last request could not be shown: said in a line until the next one, or dismissed.
	const [failed, setFailed] = useState(false);
	const finishLocate = useCallback((nonce: number, found = true) => {
		setLocate((now) => (now?.nonce === nonce ? null : now));
		if (latest.current.nonce !== nonce) return;
		setSettled(latest.current.target);
		if (!found) setFailed(true);
	}, []);
	const queryClient = useQueryClient();
	const rootSpace = root.kind === "space" ? root.space : null;
	const rootSpaceId = rootSpace?.id ?? null;
	const rootProjectId = rootSpace?.projectId ?? null;
	// A request left by a focused page, taken once as the tree mounts; then whatever is asked
	// last, by the host (a search hit) or from inside the tree (a row's "waiting for you").
	const [target, setTarget] = useState<TreeLocateTarget | null>(() => takeTreeLocate(host));
	useEffect(() => {
		if (asked) setTarget(asked);
	}, [asked]);
	// Where the space hangs (one read of it, one of its project's space for a session), the
	// nodes to open, and its rows pinned where their lists may not have loaded them.
	useEffect(() => {
		if (!target) return;
		let cancelled = false;
		const mine = latest.current.nonce + 1;
		latest.current = { nonce: mine, target };
		setFailed(false);
		const giveUp = () => {
			if (cancelled) return;
			setPins(NO_PINS);
			setSettled(target);
			setFailed(true);
		};
		void (async () => {
			try {
				const space = (
					await queryClient.fetchQuery({
						queryKey: outlineKeys.space(target.spaceId),
						queryFn: () => api.getOutlineSpace(target.spaceId),
						staleTime: 60_000,
					})
				).space;
				let parent: { spaceId: string; projectId: string } | null = null;
				let parentSpace: OutlineSpaceSummary | null = null;
				if (space.kind === "session" && space.parent) {
					const parentId = space.parent.spaceId;
					const project = (
						await queryClient.fetchQuery({
							queryKey: outlineKeys.space(parentId),
							queryFn: () => api.getOutlineSpace(parentId),
							staleTime: 60_000,
						})
					).space;
					if (project.projectId) {
						parent = { spaceId: project.id, projectId: project.projectId };
						parentSpace = project;
					}
				}
				if (cancelled) return;
				const plan = locateKeys(
					space,
					parent,
					target.pageId,
					rootSpaceId ? { spaceId: rootSpaceId, projectId: rootProjectId } : null,
				);
				if (!plan) return giveUp();
				// One set of pins per request: the space's own row, and (a session) its project's
				// at the root, wherever their lists have not loaded them.
				const spaces = new Map<string, OutlineTreeSpace>();
				if (plan.pinIn) spaces.set(plan.pinIn, { ...space, lastCommitAt: null });
				if (plan.pinParentAtRoot && parentSpace) {
					spaces.set("root", { ...parentSpace, lastCommitAt: null });
				}
				setPins({
					spaces,
					pages: new Map([
						[
							target.spaceId,
							{
								id: target.pageId,
								sid: "",
								title: target.pageTitle,
								alias: null,
								isTask: false,
							},
						],
					]),
				});
				open.setMany(plan.keys, true);
				setLocate({ ...target, nonce: mine });
			} catch {
				// The space cannot be read (any more): there is nothing to locate.
				giveUp();
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [target, queryClient, open, rootSpaceId, rootProjectId]);
	// The page itself is located by its row; a block by its page's read (`OpenPage`). Either may
	// never come (the page is gone, a list did not load): the request then ends, and says so.
	useEffect(() => {
		const tree = rootRef.current;
		if (!locate || !tree) return;
		const key = `page:${locate.pageId}`;
		const ownRow = locate.blockId === locate.pageId;
		return whenThere(
			tree,
			() => (ownRow ? rowOf(tree, key) : null),
			(row) => {
				if (row) showLocated(row);
				finishLocate(locate.nonce, row !== null);
			},
			LOCATE_WAIT_MS,
		);
	}, [locate, finishLocate]);
	useTreeScroll(
		rootRef,
		`${host}:${rootSpaceId ?? "all"}`,
		hidden,
		locate !== null || (target !== null && target !== settled),
	);
	const value = useMemo(
		() => ({
			open,
			step,
			narrow,
			pins,
			locate,
			finishLocate,
			locateTo: setTarget,
			rootRef,
			wishes,
			commands,
		}),
		[open, step, narrow, pins, locate, finishLocate, wishes, commands],
	);
	const anyOpen = useSyncExternalStore(open.subscribe, () => open.snapshot().length > 0);
	return (
		<TreeContext.Provider value={value}>
			<Box
				ref={ref}
				className={classes.tree}
				data-testid="outline-tree"
				data-narrow={narrow}
				data-locating={locate ? "" : undefined}
				hidden={hidden}
			>
				<Group justify="space-between" gap="xs" wrap="nowrap" mb={4}>
					<Text size="xs" c="dimmed" className={classes.ellipsis}>
						{t("tree.hint")}
					</Text>
					{anyOpen && (
						<Button
							size="compact-xs"
							variant="subtle"
							color="gray"
							onClick={() => {
								wishes.clear();
								setPins(NO_PINS);
								open.clear();
							}}
							data-testid="outline-tree-collapse-all"
						>
							{t("tree.collapseAll")}
						</Button>
					)}
				</Group>
				{failed && (
					<Text size="xs" c="dimmed" mb={4} role="status" data-testid="outline-locate-failed">
						{t("tree.locateFailed")}{" "}
						<Anchor component="button" type="button" size="xs" onClick={() => setFailed(false)}>
							{t("tree.dismiss")}
						</Anchor>
					</Text>
				)}
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
