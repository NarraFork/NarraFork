/**
 * THE FOREST (pageless outline, F1): the one component that draws the outline as a tree,
 * wherever it is read. There are no pages in it: a space holds blocks, and what used to be a
 * page is a top-level block like any other.
 *
 *   root "all"                          root "space"                 root "block" (focus)
 *   ▸ Recently visited (5)              ▸ • A top-level block        ▾ • A child of the root
 *   ▾ My notes                          ▾ • Another                      • …
 *       ▸ • A top-level block               ▸ ◐ a task …             ▸ ◐ a task …
 *   ▾ Project A                         ▾ Sessions (12)
 *       ▾ • Decisions                       ▸ Session a1
 *           • a block …
 *       ▾ Sessions (12)
 *           ▾ Session a1
 *               ▸ • Tasks
 *   ▸ Sessions outside projects (3)
 *
 * The rows of spaces and groups are the connected outline's (their lists are read a page of
 * the list at a time; what is open is kept per browser, `tree-open-state.ts`). The BLOCKS of
 * each open space are one lazily loaded, windowed list (`ForestBlocks.tsx` over
 * `forest-model.ts`): any block opens in place, level by level; a long level continues with
 * "more"; a level with more than 2,000 children is paged in place; what a reader opened and
 * closed is their own, stored per block on the server; a commit re-reads only the levels it
 * concerns (the block watch). Focusing a block is the same list with that block as its only
 * root: the host draws the block's title and its ancestors' path above it.
 *
 * READ MODE only here (L4–L6 add editing to the same component): nothing edits; a block's
 * bullet (or its focus handle) focuses it, and `onEdit` tells the host the reader
 * double-clicked a row's text.
 *
 * Every row has its arrow (always drawn, touch included). Alt on an arrow (Alt+Enter on a
 * row's link) opens everything inside the row, or returns it to the default view. A block is
 * LOCATED by opening what it is under (its space's place in the tree, then its ancestors, for
 * this visit) and scrolling to it (`tree-locate.ts`), and the tree comes back where the reader
 * left it (`tree-scroll.ts`).
 *
 * Router-free: links go through the host's renderer (`outline-nav.tsx`), so the outline route,
 * a dock panel and a session's side panel show the same forest.
 */
import { Alert, Anchor, Badge, Box, Button, Group, Loader, Text } from "@mantine/core";
import { useElementSize, useMergedRef } from "@mantine/hooks";
import {
	OUTLINE_TREE_LIMITS,
	type OutlineSpaceSummary,
	type OutlineTreeSpace,
	type OutlineViewMode,
} from "@shared/outline-api";
import { IconClock, IconFolder, IconFolders, IconMessages, IconUser } from "@tabler/icons-react";
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
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
	outlineKeys,
	useEnsurePersonalOutlineSpace,
	useOutlineTree,
	useOutlineTreeSpaces,
} from "../../../hooks/useOutline";
import { ApiError, api } from "../../../lib/api";
import { formatSmartTime } from "../../../lib/format";
import { readOutlineRecents } from "../../../lib/outline-recents";
import { reportLineDisplay } from "../../../lib/outline-report-line";
import { ownKeys, plainClick } from "../fold-controls";
import classes from "../Outline.module.css";
import { useOutlineSpaceName } from "../OutlineSpaceName";
import { OutlineStatusChip, OutlineStatusIcon } from "../OutlineStatusIcon";
import { FOLD_ICONS, QUESTION_ICON } from "../outline-icons";
import { OutlineLink, outlineBlockTarget } from "../outline-nav";
import { locateKeys, type TreeLocateTarget, takeTreeLocate } from "../tree/tree-locate";
import {
	type TreeHost,
	TreeOpenState,
	treeCountLabel,
	treeOpenStorageKey,
} from "../tree/tree-open-state";
import { useTreeTabStops } from "../tree/tree-roving";
import {
	captureTreeAnchor,
	readTreeAnchor,
	restoreTreeAnchor,
	scrollParentOf,
	TREE_SCROLL_WAIT_MS,
	writeTreeAnchor,
} from "../tree/tree-scroll";
import { ForestBlocks } from "./ForestBlocks";
import type { ForestIO, SpaceForest } from "./forest-model";

/** How long a locate waits for its row before saying it could not be shown. */
const LOCATE_WAIT_MS = 10_000;
/** Tree levels indentation grows for; deeper rows line up with the last. */
const MAX_TREE_INDENT = 4;
/** Levels a block's indentation grows for where there is room. */
const MAX_BLOCK_INDENT = 8;
/** Below this width the tree is narrow: smaller steps (a phone, a narrow dock panel). */
const NARROW_PX = 480;

/** Space rows shown although their list has not loaded them (a located block's space). */
interface TreePins {
	/** By the list they are in: `root`, or a group's key. */
	spaces: ReadonlyMap<string, OutlineTreeSpace>;
}

const NO_PINS: TreePins = { spaces: new Map() };

/** A block being located: its space's forest opens its ancestors and scrolls to it. */
interface ActiveLocate extends TreeLocateTarget {
	nonce: number;
}

interface TreeContextValue {
	open: TreeOpenState;
	/** Pixels per level. */
	step: number;
	/** A phone or a narrow panel: indentation, spaces and blocks together, stops at 4 levels. */
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
	/** Requests of the block lists (tests pass an in-memory outline). */
	io: ForestIO | undefined;
	onEdit: ((spaceId: string, blockId: string) => void) | undefined;
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
 * everything inside. Closed, or with something closed inside: the node and the rows of spaces
 * and groups loaded under it open (blocks keep the reader's own folding), and the rows one
 * level down open as they load. All open: the node and everything under it close.
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
			const inner = inside.filter((k) => !k.startsWith("block:"));
			if (open.isOpen(key) && inner.every((k) => open.isOpen(k))) {
				wishes.delete(key);
				open.setMany([...inner, key], false);
			} else {
				wishes.add(key);
				open.setMany([key, ...inner], true);
			}
		},
		[open, key, rootRef, wishes],
	);
	return [isOpen, toggle];
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
	kind: "space" | "group";
	/** What the node holds, shown (in its group) while it is open. */
	children?: ReactNode;
}) {
	const { t } = useTranslation("outline");
	const { step, narrow, wishes } = useTree();
	const { Icon: Arrow } = FOLD_ICONS[open ? "expanded" : "collapsed"];
	const action = t(open ? "page.collapse" : "page.expand");
	// Loaded under a node asked to open everything inside it: this row opens too.
	const parentKey = useContext(ParentKeyContext);
	const wished = useRef(parentKey !== null && wishes.has(parentKey) && !open);
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
					<OutlineLink
						to={to}
						className={classes.treeTitle}
						title={title}
						data-tree-title=""
						data-tree-nav=""
					>
						{title}
					</OutlineLink>
				) : (
					<button
						type="button"
						className={`${classes.treeTitle} ${classes.treeGroupTitle} mantine-focus-auto`}
						onClick={(event) => onToggle(event.altKey)}
						data-tree-title=""
						data-tree-nav=""
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

/** A line under a node: loading, empty, gone, or the rest of a list. */
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
				data-tree-nav=""
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
											locateTo({ spaceId: space.id, blockId: asks.blockId, answer: true }),
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

/** A space's blocks, then (a project) the group of its sessions. */
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
			<SpaceBlocks spaceId={space.id} depth={depth} />
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
// Blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The blocks of a space under its row: the space's top level, each block one line until the
 * reader opens it (the reader's own folding, stored per block).
 */
function SpaceBlocks({ spaceId, depth }: { spaceId: string; depth: number }) {
	const { step, narrow, locate, finishLocate, io, onEdit } = useTree();
	const mine = locate && locate.spaceId === spaceId ? locate : null;
	const request = useMemo(
		() => (mine ? { blockId: mine.blockId, answer: mine.answer, nonce: mine.nonce } : null),
		[mine],
	);
	const edit = useCallback((blockId: string) => onEdit?.(spaceId, blockId), [onEdit, spaceId]);
	return (
		<ForestBlocks
			spaceId={spaceId}
			rootId={null}
			// Everything a space holds, tasks included: reading the whole outline is reading
			// what is being done too, folded so that what is finished takes one line.
			view="all"
			indent={{
				base: indentOf(depth, step),
				step,
				// Narrow: spaces and blocks together indent at most 4 levels (one more for a
				// space already that deep, so its rows still nest).
				max: narrow
					? Math.max(1, MAX_TREE_INDENT - Math.min(depth, MAX_TREE_INDENT))
					: MAX_BLOCK_INDENT,
			}}
			locate={request}
			onLocated={finishLocate}
			onEdit={onEdit ? edit : undefined}
			io={io}
		/>
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

/**
 * The arrow keys on a row's title or a "more" control (design §2.5, `data-tree-nav`): move
 * between rows, open and close. The tree is one tab stop (`tree-roving.ts`).
 */
export function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
	if (event.ctrlKey || event.metaKey || event.shiftKey) return;
	const target = event.target as HTMLElement;
	if (!target.matches("[data-tree-nav]")) return;
	// A "more" control is not a row: it moves, it does not open or close.
	const row = target.matches("[data-tree-title]")
		? target.closest<HTMLElement>("[data-tree-node]")
		: null;
	if (event.altKey) {
		if (!row) return;
		// Alt+Enter: everything inside the row, as Alt on its arrow (PR C's controls).
		if (event.key !== "Enter" || event.repeat) return;
		event.preventDefault();
		event.stopPropagation();
		row
			.querySelector<HTMLButtonElement>("button[data-tree-toggle]")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
		return;
	}
	const titles = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-nav]")];
	const at = titles.indexOf(target);
	const move = (to: number) => {
		const next = titles[Math.max(0, Math.min(titles.length - 1, to))];
		next?.focus();
	};
	const toggle = () => row?.querySelector<HTMLButtonElement>("button[data-tree-toggle]")?.click();
	const open = row?.dataset.open === "true";
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
			if (open || !row) move(at + 1);
			else toggle();
			break;
		case "ArrowLeft": {
			if (open && row) {
				toggle();
				break;
			}
			// Closed, or a leaf: to the row it is under (the nearest row above with a lower
			// level: block rows are a flat list, so nesting in the DOM does not say it).
			const level = Number(target.closest("[role=treeitem]")?.getAttribute("aria-level") ?? 1);
			for (let i = at - 1; i >= 0; i--) {
				const above = titles[i] as HTMLElement;
				const aboveLevel = Number(
					above.closest("[role=treeitem]")?.getAttribute("aria-level") ?? 1,
				);
				if (aboveLevel < level) {
					above.focus();
					break;
				}
			}
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

export interface OutlineForestProps {
	/**
	 * What the forest shows: the whole outline; one space (its top-level blocks and, a project,
	 * its sessions; the host shows the space itself above); or one block focused (what is under
	 * it; the host shows its title and its ancestors' path above).
	 */
	root:
		| { kind: "all" }
		| { kind: "space"; space: OutlineSpaceSummary }
		| {
				kind: "block";
				spaceId: string;
				blockId: string;
				/** Facts (the default) or everything. */
				view?: OutlineViewMode;
				/** Commit seq to show it as of (read only, not live); absent: now. */
				asOf?: number;
		  };
	/** Where it is shown: the outline page and the dock panels keep their own open nodes. */
	host?: TreeHost;
	/**
	 * A block to bring on screen (a search hit): what it is under opens, and the tree scrolls to
	 * it. A new object locates again. A request left by a focused view (`requestTreeLocate`) is
	 * taken when the tree mounts.
	 */
	locate?: TreeLocateTarget | null;
	/**
	 * Kept but not shown (a search is drawn in its place): what is open stays, and it comes back
	 * where the reader left it.
	 */
	hidden?: boolean;
	/** The reader double-clicked a row's text: the host may start editing there (L6's entry). */
	onEdit?: (spaceId: string, blockId: string) => void;
	/** The focused root's model, once made (what the view left out, the path). */
	onForest?: (forest: SpaceForest | null) => void;
	/** Not watching while out of sight (a hidden dock panel). Default true. */
	live?: boolean;
	/** Requests of the block lists; the app's API when absent (tests). */
	io?: ForestIO;
}

/** A block focused: what is under it, with the control for all of it. */
function FocusedForest({
	root,
	onEdit,
	onForest,
	live,
	io,
}: {
	root: Extract<OutlineForestProps["root"], { kind: "block" }>;
	onEdit?: (spaceId: string, blockId: string) => void;
	onForest?: (forest: SpaceForest | null) => void;
	live?: boolean;
	io?: ForestIO;
}) {
	const { t } = useTranslation("outline");
	const [forest, setForest] = useState<SpaceForest | null>(null);
	const took = useCallback(
		(made: SpaceForest | null) => {
			setForest(made);
			onForest?.(made);
		},
		[onForest],
	);
	const version = useSyncExternalStore(
		forest?.subscribe ?? noSubscribe,
		forest?.getVersion ?? zero,
		forest?.getVersion ?? zero,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the version says the rows changed
	const all = useMemo(
		() => (forest?.status === "ready" ? forest.getView().all : null),
		[forest, version],
	);
	const { spaceId } = root;
	const edit = useCallback((blockId: string) => onEdit?.(spaceId, blockId), [onEdit, spaceId]);
	const act = () => forest?.foldInside(null, all === "expand");
	const treeRef = useRef<HTMLDivElement | null>(null);
	useTreeTabStops(treeRef);
	return (
		<Box className={classes.rows} data-testid="outline-block-tree">
			{/* Only when there is something to open or to return to. */}
			{all && (
				<Anchor
					component="button"
					type="button"
					size="xs"
					className={classes.foldPage}
					title={all === "collapse" ? t("fold.collapseAllHint") : undefined}
					onClick={act}
					onKeyDown={ownKeys(act)}
					data-testid="outline-fold-all"
					data-fold-all={all}
				>
					{t(all === "expand" ? "fold.expandAll" : "fold.collapseAll")}
				</Anchor>
			)}
			<div ref={treeRef} role="tree" aria-label={t("title")} onKeyDown={onTreeKeyDown}>
				<ForestBlocks
					spaceId={root.spaceId}
					rootId={root.blockId}
					view={root.view ?? "facts"}
					asOf={root.asOf}
					indent={{ step: 18, max: MAX_BLOCK_INDENT }}
					onForest={took}
					onEdit={onEdit ? edit : undefined}
					live={live}
					io={io}
				/>
			</div>
		</Box>
	);
}

const noSubscribe = () => () => {};
const zero = () => 0;

export function OutlineForest(props: OutlineForestProps) {
	if (props.root.kind === "block") {
		return (
			<FocusedForest
				root={props.root}
				onEdit={props.onEdit}
				onForest={props.onForest}
				live={props.live}
				io={props.io}
			/>
		);
	}
	return <ConnectedForest {...props} root={props.root} />;
}

function ConnectedForest({
	root,
	host = "page",
	locate: asked = null,
	hidden = false,
	onEdit,
	io,
}: OutlineForestProps & { root: Exclude<OutlineForestProps["root"], { kind: "block" }> }) {
	const { t } = useTranslation("outline");
	const [open] = useState(() => new TreeOpenState(treeOpenStorageKey(host)));
	const { ref: sizeRef, width } = useElementSize();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const ref = useMergedRef(sizeRef, rootRef);
	const narrow = width > 0 && width < NARROW_PX;
	const step = narrow ? 12 : 18;
	const [wishes] = useState(() => new Set<string>());
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
	// A request left by a focused view, taken once as the tree mounts; then whatever is asked
	// last, by the host (a search hit) or from inside the tree (a row's "waiting for you").
	const [target, setTarget] = useState<TreeLocateTarget | null>(() => takeTreeLocate(host));
	useEffect(() => {
		if (asked) setTarget(asked);
	}, [asked]);
	// Where the space hangs (one read of it, one of its project's space for a session), the
	// nodes to open, and its rows pinned where their lists may not have loaded them. The block
	// itself is then located by its space's own list (`ForestBlocks`).
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
				setPins({ spaces });
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
	// The space's list may never come (the space is gone, a list did not load): the request
	// then ends, and says so.
	useEffect(() => {
		if (!locate) return;
		const timer = setTimeout(() => finishLocate(locate.nonce, false), LOCATE_WAIT_MS);
		return () => clearTimeout(timer);
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
			io,
			onEdit,
		}),
		[open, step, narrow, pins, locate, finishLocate, wishes, io, onEdit],
	);
	const anyOpen = useSyncExternalStore(open.subscribe, () => open.snapshot().length > 0);
	const treeRef = useRef<HTMLDivElement | null>(null);
	useTreeTabStops(treeRef);
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
				<div ref={treeRef} role="tree" aria-label={t("title")} onKeyDown={onTreeKeyDown}>
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
