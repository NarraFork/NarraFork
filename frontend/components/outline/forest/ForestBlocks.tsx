/**
 * The blocks of one space as the forest draws them (pageless outline, F1), in READ mode: a
 * lazily loaded, windowed list of rows under one root — the space's top level, or one block
 * (the focused view). The data is `forest-model.ts`; this file is its rows and its wiring to
 * the routes, the block watch and the reader's viewport.
 *
 * A row is what the read-only tree's row was: the arrow (always drawn; faint and inert on a
 * row with nothing under it), one marker (a task's badge, a question's mark, else the bullet,
 * which focuses the block), the block's text, its facts (who, due, alias, tags, lock, a change
 * waiting), and on a closed row one preview line and the counts of what it hides. No tools: it
 * reads. Double-clicking a row's text asks the host to edit there (`onEdit`).
 *
 * Only the rows near the viewport are in the DOM (`use-windowed-rows.ts`), in the scroller the
 * host already has.
 */
import { Anchor, Badge, Loader, Paper, Text, Tooltip } from "@mantine/core";
import { blockTitle } from "@shared/outline";
import type { OutlineQuestionMark, OutlineTaskStatus, OutlineViewMode } from "@shared/outline-api";
import { isOutlineReportBlockId } from "@shared/outline-report-line";
import type { OutlineSubtreeMarks, OutlineTreeBlock } from "@shared/outline-subtree-api";
import { IconPinned, IconPointFilled } from "@tabler/icons-react";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { REMOTE_BUILD } from "../../../lib/build-target";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { outlineBlockWatch } from "../../../lib/outline-block-watch";
import { reportLineDisplay } from "../../../lib/outline-report-line";
import { ownKeys, plainClick, spokenLabel } from "../fold-controls";
import classes from "../Outline.module.css";
import { OutlineBlockBody } from "../OutlineBlockBody";
import { OutlineQuestionsForm } from "../OutlineQuestions";
import { OutlineStatusChip, OutlineStatusIcon } from "../OutlineStatusIcon";
import { FOCUS_ICON, FOLD_ALL_ICONS, FOLD_ICONS, QUESTION_ICON, rowMarker } from "../outline-icons";
import { OutlineLink, outlineBlockTarget } from "../outline-nav";
import {
	type ForestBlockRow,
	type ForestIO,
	type ForestMoreRow,
	type ForestRow,
	type ForestStatus,
	SpaceForest,
} from "./forest-model";
import { useWindowedRows } from "./use-windowed-rows";

/** Characters of a preview line (one visual line shows far fewer). */
const PREVIEW_CHARS = 240;
const SEEN_PREFIX = "narrafork_outline_seen:";

/** A task's status: the state's badge, the same one the live editor's frame draws. */
export function OutlineTaskIcon({ status }: { status: OutlineTaskStatus }) {
	const { t } = useTranslation("outline");
	return (
		<Tooltip label={t(`page.task.${status}`)} openDelay={400}>
			<span className={classes.taskIcon} role="img" aria-label={t(`page.task.${status}`)}>
				<OutlineStatusIcon status={status} />
			</span>
		</Tooltip>
	);
}

const QUESTION_COLORS: Record<OutlineQuestionMark["state"], string> = {
	open: "var(--mantine-color-teal-5)",
	answered: "var(--mantine-color-green-6)",
	withdrawn: "var(--mantine-color-dimmed)",
};

/** The mark of a question put to a person where a task has its checkbox. */
export function OutlineQuestionIcon({
	state,
	proceed = false,
}: {
	state: OutlineQuestionMark["state"];
	proceed?: boolean;
}) {
	const { t } = useTranslation("outline");
	const label = t(`page.question.${state}${state === "open" && proceed ? "Proceeded" : ""}`);
	const { Icon } = QUESTION_ICON;
	return (
		<Tooltip label={label} openDelay={400}>
			<span
				className={classes.taskIcon}
				role="img"
				aria-label={label}
				data-testid="outline-question-mark"
				data-state={state}
				style={{ color: QUESTION_COLORS[state] }}
			>
				<Icon size={16} />
			</span>
		</Tooltip>
	);
}

/** The reader's last visit of a space in this browser (a commit seq), for "changed since". */
function readSeen(spaceId: string): number | undefined {
	try {
		const value = Number(localStorage.getItem(SEEN_PREFIX + spaceId));
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeSeen(spaceId: string, seq: number): void {
	try {
		if (seq > 0) localStorage.setItem(SEEN_PREFIX + spaceId, String(seq));
	} catch {
		// A convenience: without storage nothing is marked as changed.
	}
}

const defaultIO: ForestIO = {
	subtree: (spaceId, rootId, params) => api.getOutlineSubtree(spaceId, rootId, params),
	children: (spaceId, params) => api.getOutlineChildren(spaceId, params),
	marks: (spaceId, keys, since) => api.getOutlineMarks(spaceId, keys, since),
	getFold: (spaceId) => api.getOutlineFoldState(spaceId),
	putFold: (spaceId, changes, keepalive) =>
		api.putOutlineFoldState(spaceId, { changes }, keepalive),
};

interface RowViewProps {
	row: ForestBlockRow;
	spaceId: string;
	view: OutlineViewMode;
	asOf: number | undefined;
	indent: number;
	previewText: string;
	/** Counts of what the row hides: questions, pending, locked ("" when none or unknown). */
	hidden: string;
	openTasks: number;
	processHidden: number;
	changed: "self" | "below" | "both" | "";
	located: boolean;
	onToggle: (id: string, inside: boolean, open: boolean) => void;
	onQuestions: (id: string) => void;
	onEdit?: (id: string) => void;
}

const HIDDEN_KINDS = [
	{ kind: "question", key: "fold.hiddenQuestion", status: null },
	{ kind: "pending", key: "fold.hiddenPending", status: "waiting" },
	{ kind: "locked", key: "fold.hiddenLocked", status: "locked" },
] as const;

const BlockRowView = memo(function BlockRowView({
	row,
	spaceId,
	view,
	asOf,
	indent,
	previewText,
	hidden,
	openTasks,
	processHidden,
	changed,
	located,
	onToggle,
	onQuestions,
	onEdit,
}: RowViewProps) {
	const { t, i18n } = useTranslation("outline");
	const block = row.block;
	const id = block.id;
	const collapsed = row.hasChildren && !row.open;
	const done = block.task?.status === "done" || block.task?.status === "cancelled";
	const marker = rowMarker({ task: !!block.task, question: !!block.question });
	const reportLine = reportLineDisplay(block.content, {
		t,
		locale: i18n?.language,
		from: block.reportFrom,
	});
	const title = (reportLine ?? blockTitle(block.content)).slice(0, 80) || t("fold.untitled");
	const { Icon: Arrow } = FOLD_ICONS[collapsed || !row.hasChildren ? "collapsed" : "expanded"];
	const arrowAction = t(collapsed ? "page.expand" : "page.collapse");
	const subtreeAction = t(
		row.subtree === "collapse" ? "fold.subtreeCollapse" : "fold.subtreeExpand",
	);
	const toggle = (inside: boolean) =>
		inside
			? onToggle(id, true, row.subtree !== "collapse" || collapsed)
			: onToggle(id, false, collapsed);
	const focusLink = (children: React.ReactNode, className: string, label?: string) => (
		<OutlineLink
			to={outlineBlockTarget(spaceId, id, view, asOf)}
			className={className}
			aria-label={label}
			data-tree-title=""
		>
			{children}
		</OutlineLink>
	);
	const counts = hidden ? hidden.split(",").map(Number) : [];
	const previewLabel =
		row.previewKind === "report" ? t("forest.reportAll") : row.previewMore ? t("fold.open") : null;
	const facts = view === "facts";
	const SubtreeIcon = FOLD_ALL_ICONS[row.subtree === "collapse" ? "collapse" : "expand"].Icon;
	const hasMeta =
		block.alias ||
		block.tags.length > 0 ||
		block.task?.assignee ||
		block.task?.due ||
		block.lock ||
		block.pending.length > 0 ||
		hidden !== "" ||
		row.pinned ||
		changed !== "" ||
		(facts && (openTasks > 0 || processHidden > 0));
	return (
		<>
			<div
				className={classes.row}
				data-block-id={id}
				data-tree-node={`block:${id}`}
				data-tree-kind="block"
				data-open={row.open}
				data-marker={marker}
				data-fold={row.hasChildren ? (row.open ? "open" : "closed") : undefined}
				data-located={located ? "" : undefined}
				data-pinned={row.pinned || undefined}
			>
				<span className={classes.indent} style={{ width: indent }} />
				<span className={classes.toggle}>
					{row.hasChildren ? (
						<button
							type="button"
							tabIndex={-1}
							className={`${classes.toggleButton} mantine-focus-auto`}
							aria-label={`${arrowAction} · ${title}`}
							aria-expanded={!collapsed}
							title={`${arrowAction} · ${t("fold.altHint")}`}
							data-fold-toggle=""
							data-tree-toggle=""
							onClick={(e) => {
								if (plainClick(e)) toggle(e.altKey);
							}}
							onKeyDown={ownKeys((alt) => toggle(alt))}
						>
							<Arrow size={14} />
						</button>
					) : (
						// Always drawn: a row with nothing under it has a faint arrow that says nothing.
						<span
							className={classes.toggleButton}
							style={{ opacity: 0.35, cursor: "default" }}
							aria-hidden="true"
							data-tree-toggle=""
							data-tree-leaf=""
						>
							<Arrow size={14} />
						</span>
					)}
				</span>
				{marker === "bullet" &&
					focusLink(
						<span className={classes.bulletDot} data-collapsed={collapsed} />,
						classes.bullet,
						`${t("page.focus")} · ${title}`,
					)}
				{marker === "task" && block.task && <OutlineTaskIcon status={block.task.status} />}
				{marker === "question" && block.question && (
					<OutlineQuestionIcon state={block.question.state} proceed={block.question.proceed} />
				)}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: a second way into editing; the visible control is the host's */}
				<div
					className={classes.content}
					data-done={done}
					data-forest-text=""
					onDoubleClick={onEdit ? () => onEdit(id) : undefined}
				>
					{reportLine !== null ? (
						<span className="nf-type-scope" data-testid="outline-report-line" title={block.content}>
							{reportLine}
						</span>
					) : (
						<OutlineBlockBody content={block.content} />
					)}
					{hasMeta && (
						<div className={classes.meta}>
							{row.pinned && (
								<Badge
									size="xs"
									variant="outline"
									color="gray"
									tt="none"
									leftSection={<IconPinned size={10} aria-hidden />}
									title={t("forest.pinnedHint")}
									data-testid="forest-pinned"
								>
									{t("forest.pinned")}
								</Badge>
							)}
							{block.task?.assignee && (
								<Badge size="xs" variant="light" color="gray" tt="none">
									@{block.task.assignee}
								</Badge>
							)}
							{block.task?.due && (
								<Badge size="xs" variant="light" color="gray" tt="none">
									{t("page.due", { date: block.task.due })}
								</Badge>
							)}
							{block.alias && (
								<Badge size="xs" variant="outline" color="gray" tt="none">
									{t("page.alias", { alias: block.alias })}
								</Badge>
							)}
							{block.tags.map((tag) => (
								<Badge key={tag} size="xs" variant="light" color="indigo" tt="none">
									#{tag}
								</Badge>
							))}
							{facts && openTasks > 0 && (
								<Badge
									size="xs"
									variant="dot"
									color="yellow"
									tt="none"
									title={t("forest.inProgressHint")}
									data-testid="outline-in-progress"
									renderRoot={(props) => (
										<OutlineLink {...props} to={outlineBlockTarget(spaceId, id, "all", asOf)} />
									)}
								>
									{t("page.inProgress", { count: openTasks })}
								</Badge>
							)}
							{facts && openTasks === 0 && processHidden > 0 && (
								<Tooltip label={t("page.hiddenUnderHint")} openDelay={300}>
									<Badge
										size="xs"
										variant="light"
										color="gray"
										tt="none"
										data-testid="outline-hidden-under"
									>
										{t("page.hiddenUnder", { count: processHidden })}
									</Badge>
								</Tooltip>
							)}
							{block.lock && (
								<OutlineStatusChip status="locked" data-testid="outline-lock-badge">
									{t("lock.badge", {
										name:
											block.lock.by.kind === "human"
												? (block.lock.by.name ?? t("lock.someone"))
												: block.lock.by.name
													? t("lock.session", { title: block.lock.by.name })
													: t("lock.untitledSession"),
									})}
								</OutlineStatusChip>
							)}
							{block.pending.length > 0 && (
								<Badge
									size="xs"
									variant="light"
									color="orange"
									tt="none"
									data-testid="outline-pending-badge"
								>
									{t("pending.badge")}
								</Badge>
							)}
							{HIDDEN_KINDS.map((mark, i) => {
								const count = counts[i] ?? 0;
								if (count <= 0) return null;
								const label = t(mark.key, { count });
								const props = {
									title: label,
									"aria-label": label,
									"data-testid": "outline-fold-hidden",
									"data-kind": mark.kind,
								};
								return mark.status ? (
									<OutlineStatusChip key={mark.kind} status={mark.status} {...props}>
										{count}
									</OutlineStatusChip>
								) : (
									// The questions it hides are one step away: the count opens them and
									// where they are answered.
									<Badge
										key={mark.kind}
										component="button"
										type="button"
										size="xs"
										variant="light"
										color="teal"
										tt="none"
										style={{ cursor: "pointer" }}
										leftSection={<QUESTION_ICON.Icon size={10} aria-hidden />}
										onClick={(e: React.MouseEvent) => {
											if (plainClick(e)) onQuestions(id);
										}}
										onKeyDown={ownKeys(() => onQuestions(id))}
										{...props}
									>
										{count}
									</Badge>
								);
							})}
							{changed !== "" && (
								<Badge
									size="xs"
									variant="light"
									color="indigo"
									tt="none"
									px={3}
									title={t(changed === "self" ? "forest.changedSelf" : "forest.changedBelow")}
									aria-label={t(changed === "self" ? "forest.changedSelf" : "forest.changedBelow")}
									data-testid="forest-changed"
									data-changed={changed}
								>
									<IconPointFilled size={10} aria-hidden style={{ display: "block" }} />
								</Badge>
							)}
						</div>
					)}
				</div>
				{row.subtree && (
					<button
						type="button"
						className={`${classes.foldAll} mantine-focus-auto`}
						aria-expanded={row.subtree === "collapse"}
						aria-label={t("fold.subtree", { title })}
						title={subtreeAction}
						data-fold-subtree={row.subtree}
						onClick={(e) => {
							if (plainClick(e)) toggle(true);
						}}
						onKeyDown={ownKeys(() => toggle(true))}
					>
						<SubtreeIcon size={14} />
					</button>
				)}
				{marker !== "bullet" &&
					focusLink(
						<FOCUS_ICON.Icon size={14} />,
						classes.focusHandle,
						`${t("page.focus")} · ${title}`,
					)}
			</div>
			{collapsed && row.previewKind && (
				// biome-ignore lint/a11y/useSemanticElements: a line of text that opens its row, laid out as one
				<div
					role="button"
					tabIndex={0}
					aria-expanded={false}
					aria-label={`${t("fold.showInside")}: ${previewText || title}${
						previewLabel ? ` (${spokenLabel(previewLabel)})` : ""
					}`}
					className={`${classes.preview} mantine-focus-auto`}
					style={{ "--nf-fold-indent": `${indent}px` } as React.CSSProperties}
					data-fold-preview={row.previewKind}
					data-fold-of={id}
					onClick={(e) => {
						if (plainClick(e)) onToggle(id, true, true);
					}}
					onKeyDown={ownKeys(() => onToggle(id, true, true))}
				>
					{previewText && (
						<span className={classes.previewText} data-fold-preview-text="">
							{previewText}
						</span>
					)}
					{previewLabel && (
						<span className={classes.previewLabel} data-fold-preview-label="">
							{previewLabel}
						</span>
					)}
				</div>
			)}
		</>
	);
});

function MoreRowView({
	row,
	indent,
	onMore,
}: {
	row: ForestMoreRow;
	indent: number;
	onMore: (parentKey: string, mode: ForestMoreRow["mode"]) => void;
}) {
	const { t } = useTranslation("outline");
	const label =
		row.mode === "more"
			? t("loadMore")
			: row.mode === "next"
				? t("forest.next")
				: row.mode === "prev"
					? t("forest.prev")
					: t(row.failed ? "forest.retry" : "forest.load");
	return (
		<div
			className={classes.treeNote}
			style={{ paddingInlineStart: indent + 24 }}
			data-forest-more={row.mode}
			data-forest-parent={row.parentKey}
		>
			{row.mode === "loading" ? (
				<Loader size={12} />
			) : (
				<>
					<Anchor
						component="button"
						type="button"
						size="sm"
						disabled={row.busy}
						onClick={() => onMore(row.parentKey, row.mode)}
						data-tree-more=""
					>
						{label}
					</Anchor>
					{(row.mode === "next" || row.mode === "prev") && (
						<Text span size="xs" c="dimmed" ml={8} data-forest-paged="">
							{t("forest.paged", { from: row.before + 1, to: row.before + row.shown })}
						</Text>
					)}
					{row.failed && row.mode !== "load" && (
						<Text span size="xs" c="dimmed" ml={8}>
							{t("loadFailed")}
						</Text>
					)}
					{row.busy && <Loader size={12} ml={6} />}
				</>
			)}
		</div>
	);
}

function changedOf(
	marks: OutlineSubtreeMarks | undefined,
	closed: boolean,
): RowViewProps["changed"] {
	const changed = marks?.changed;
	if (!changed) return "";
	// What changed below an open row is on screen under it: only a closed row says so.
	const below = closed && changed.below;
	return changed.self && below ? "both" : changed.self ? "self" : below ? "below" : "";
}

export interface ForestBlocksHandle {
	forest: SpaceForest;
}

export interface ForestBlocksProps {
	spaceId: string;
	/** The block the forest is focused on; null: the space's top level. */
	rootId: string | null;
	view: OutlineViewMode;
	/** Commit seq to read as of (read only, not live); absent: now, kept fresh by the watch. */
	asOf?: number;
	/** Pixels the rows start at, pixels per level, and the depth past which indentation stops. */
	indent?: { base?: number; step: number; max: number };
	/**
	 * A block to bring on screen: what it is under opens (for this visit) and the list scrolls
	 * to it. A new `nonce` locates again; `onLocated` says how it ended.
	 */
	locate?: { blockId: string; answer?: boolean; nonce: number } | null;
	onLocated?: (nonce: number, found: boolean) => void;
	/** The reader double-clicked a row's text (the host may start editing there). */
	onEdit?: (blockId: string) => void;
	/** The model, once made (the host reads its path, its controls, what the view left out). */
	onForest?: (forest: SpaceForest | null) => void;
	/** Requests; the app's API when absent (tests pass an in-memory outline). */
	io?: ForestIO;
	/** Watch the space's changes (default true; false in a hidden panel). */
	live?: boolean;
}

/** The model of one forest: made, loaded, watched and disposed with the component. */
function useForest(props: ForestBlocksProps): SpaceForest | null {
	const { spaceId, rootId, view, asOf, io = defaultIO, live = true } = props;
	const [forest, setForest] = useState<SpaceForest | null>(null);
	useEffect(() => {
		const made = new SpaceForest({ spaceId, rootId, view, asOf, io, since: readSeen(spaceId) });
		setForest(made);
		void made.load();
		return () => {
			// The next visit marks what changed after this one.
			if (asOf === undefined && made.status === "ready") writeSeen(spaceId, made.knownSeq);
			made.dispose();
			setForest((now) => (now === made ? null : now));
		};
	}, [spaceId, rootId, view, asOf, io]);
	// The block watch: the levels near the viewport and the visible closed rows.
	useEffect(() => {
		if (REMOTE_BUILD || !live || asOf !== undefined || !forest) return;
		const handle = outlineBlockWatch(() => narratorWSManager).open(spaceId, {
			onWatching: (seq, added) => forest.onWatching(seq, added),
			onChanged: (frame) => forest.onChanged(frame),
			onPending: () => forest.onPending(),
			onError: (code) => {
				if (code === "access_denied") forest.onDenied();
			},
		});
		const send = () => {
			const keys = forest.watchKeys();
			handle.set(keys.levels, keys.subtrees);
		};
		const offKeys = forest.onWatchKeys(send);
		const offRows = forest.subscribe(send);
		send();
		return () => {
			offKeys();
			offRows();
			handle.dispose();
		};
	}, [forest, spaceId, asOf, live]);
	return forest;
}

const NO_ROWS: ForestRow[] = [];
const noSubscribe = () => () => {};
const zero = () => 0;

export function ForestBlocks(props: ForestBlocksProps) {
	const { spaceId, view, asOf, indent, locate, onLocated, onEdit, onForest } = props;
	const { t } = useTranslation("outline");
	const forest = useForest(props);
	useEffect(() => {
		onForest?.(forest);
		return () => onForest?.(null);
	}, [forest, onForest]);
	useSyncExternalStore(
		forest?.subscribe ?? noSubscribe,
		forest?.getVersion ?? zero,
		forest?.getVersion ?? zero,
	);
	const status: ForestStatus = forest?.status ?? "loading";
	const rows = forest && status === "ready" ? forest.getView().rows : NO_ROWS;
	const keys = useMemo(() => rows.map((row) => row.key), [rows]);
	const win = useWindowedRows(keys);
	const step = indent?.step ?? 18;
	const maxIndent = indent?.max ?? 8;
	const base = indent?.base ?? 0;
	const indentOf = (depth: number) => base + Math.min(depth, maxIndent) * step;

	// What is on screen is what is watched, kept fresh and marked.
	const { visibleStart, visibleEnd, start, end } = win;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the same window holds other rows once they change
	useEffect(() => {
		if (status !== "ready" || !forest) return;
		if (visibleStart < 0) forest.setViewport(start, end - 1);
		else forest.setViewport(visibleStart, visibleEnd - 1);
	}, [forest, status, visibleStart, visibleEnd, start, end, rows]);

	const onToggle = useCallback(
		(id: string, inside: boolean, open: boolean) => {
			if (inside) forest?.foldInside(id, open);
			else forest?.toggle(id);
		},
		[forest],
	);
	const onQuestions = useCallback((id: string) => forest?.openQuestions(id), [forest]);
	const onMore = useCallback(
		(parentKey: string, mode: ForestMoreRow["mode"]) => {
			if (!forest) return;
			void forest.more(parentKey, mode).then(() => {
				// Another window of a paged level: the reader is taken to where it starts.
				if (mode === "next" || mode === "prev") setJump({ parentKey });
			});
		},
		[forest],
	);

	// Locating: the block's ancestors are read (one small read), opened, and its row scrolled to.
	const [located, setLocated] = useState<string | null>(null);
	const scrollTo = useRef<string | null>(null);
	const io = props.io ?? defaultIO;
	const locateNonce = locate?.nonce;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce is a new request
	useEffect(() => {
		if (!locate || status !== "ready" || !forest) return;
		let cancelled = false;
		const finish = (found: boolean) => {
			if (cancelled) return;
			if (found) {
				scrollTo.current = locate.blockId;
				setLocated(locate.blockId);
			}
			onLocated?.(locate.nonce, found);
		};
		void io
			.subtree(spaceId, locate.blockId, {
				...(asOf !== undefined ? { asOf } : {}),
				view: "all",
				blocks: 2,
			})
			.then((read) =>
				read.pathTruncated
					? false
					: forest.locate(
							read.path.map((ancestor) => ancestor.id),
							locate.blockId,
							locate.answer === true,
						),
			)
			.then(finish, () => finish(false));
		return () => {
			cancelled = true;
		};
	}, [locateNonce, status, forest]);
	const { scrollToIndex } = win;
	const [jump, setJump] = useState<{ parentKey: string } | null>(null);
	useLayoutEffect(() => {
		if (!jump || !forest) return;
		setJump(null);
		const at = forest.getView().indexOf.get(jump.parentKey);
		scrollToIndex(at === undefined ? 0 : at + 1);
	}, [jump, forest, scrollToIndex]);
	useLayoutEffect(() => {
		const id = scrollTo.current;
		if (!id || !forest) return;
		const index = forest.getView().indexOf.get(id);
		if (index === undefined) return;
		scrollTo.current = null;
		scrollToIndex(index);
		// Heights above it are estimates until drawn: once more when they are measured.
		const again = requestAnimationFrame(() => {
			const at = forest.getView().indexOf.get(id);
			if (at !== undefined) scrollToIndex(at);
		});
		const fade = setTimeout(() => setLocated((now) => (now === id ? null : now)), 2400);
		return () => {
			cancelAnimationFrame(again);
			clearTimeout(fade);
		};
	});

	if (status === "loading" || !forest) {
		return (
			<div
				className={classes.treeNote}
				style={{ paddingInlineStart: base + 24 }}
				data-forest-loading=""
			>
				<Loader size={12} />
			</div>
		);
	}
	if (status !== "ready") {
		return (
			<div
				className={classes.treeNote}
				style={{ paddingInlineStart: base + 24 }}
				data-forest-status={status}
			>
				<Text span size="xs" c="dimmed">
					{t(
						status === "missing"
							? "tree.gone"
							: status === "unavailable"
								? "forest.historyUnavailable"
								: "loadFailed",
					)}
				</Text>
				{status === "error" && (
					<Anchor
						component="button"
						type="button"
						size="xs"
						ml={8}
						onClick={() => void forest.load()}
					>
						{t("forest.retry")}
					</Anchor>
				)}
			</div>
		);
	}

	const drawn: React.ReactNode[] = [];
	for (let i = win.start; i < win.end; i++) {
		const row = rows[i] as ForestRow;
		let body: React.ReactNode;
		let level = row.depth + 1;
		if (row.kind === "block") {
			const marks = forest.marksOf(row.id);
			const closed = row.hasChildren && !row.open;
			const hidden =
				closed && marks && marks.questions + marks.pending + marks.locked > 0
					? `${marks.questions},${marks.pending},${marks.locked}`
					: "";
			const preview = row.previewId ? forest.blockOf(row.previewId) : undefined;
			body = (
				<BlockRowView
					row={row}
					spaceId={spaceId}
					view={view}
					asOf={asOf}
					indent={indentOf(row.depth)}
					previewText={preview ? previewLine(preview, t) : ""}
					hidden={hidden}
					openTasks={marks ? marks.tasks.todo + marks.tasks.doing : 0}
					processHidden={row.open ? (forest.levelOf(row.id)?.processHidden ?? 0) : 0}
					changed={changedOf(marks, closed)}
					located={located === row.id}
					onToggle={onToggle}
					onQuestions={onQuestions}
					onEdit={onEdit}
				/>
			);
		} else if (row.kind === "more") {
			body = <MoreRowView row={row} indent={indentOf(row.depth)} onMore={onMore} />;
		} else if (row.kind === "note") {
			body = (
				<div
					className={classes.treeNote}
					style={{ paddingInlineStart: indentOf(row.depth) + 24 }}
					data-forest-note={row.note}
				>
					<Text span size="xs" c="dimmed">
						{row.note === "hidden" ? t("page.factsEmpty") : t("forest.empty")}
					</Text>
				</div>
			);
		} else {
			level = row.depth + 2;
			body = (
				<Paper
					withBorder
					p="sm"
					my="xs"
					ml={indentOf(row.depth) + 24}
					data-testid="outline-tree-questions"
				>
					<OutlineQuestionsForm blockId={row.under} showOpenLink={false} live={false} />
				</Paper>
			);
		}
		drawn.push(
			<div
				key={row.key}
				ref={win.rowRef(row.key)}
				role="treeitem"
				tabIndex={-1}
				aria-level={level}
				aria-selected={false}
				aria-expanded={row.kind === "block" && row.hasChildren ? row.open : undefined}
				data-forest-row={row.kind}
			>
				{body}
			</div>,
		);
	}
	return (
		<div
			ref={win.listRef}
			className={classes.rows}
			data-testid="outline-forest-blocks"
			data-forest-space={spaceId}
			data-forest-rows={rows.length}
			data-forest-seq={forest.knownSeq}
		>
			<div ref={win.topRef} style={{ height: win.padTop }} aria-hidden="true" />
			{drawn}
			<div ref={win.bottomRef} style={{ height: win.padBottom }} aria-hidden="true" />
		</div>
	);
}

function previewLine(
	block: OutlineTreeBlock,
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	const line = isOutlineReportBlockId(block.id)
		? (reportLineDisplay(block.content, { t }) ?? blockTitle(block.content))
		: blockTitle(block.content);
	const chars = Array.from(line.replace(/\s+/g, " ").trim());
	return chars.length <= PREVIEW_CHARS
		? chars.join("")
		: `${chars.slice(0, PREVIEW_CHARS - 1).join("")}…`;
}
