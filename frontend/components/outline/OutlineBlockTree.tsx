/**
 * The read-only tree of an outline page: the blocks under the view's root as an indented list.
 *
 * What is open is the page's default view with the reader's own folding over it
 * (`@shared/outline-fold`), the same as the live editor and the mind map: finished tasks, subagent
 * reports and the details under a task are closed behind ONE preview line (the first line of
 * what they hold, and how much more there is); a closed row counts the questions, pending
 * changes and locks it hides. The controls are an outline plan's (`plan/OutlinePlanTree.tsx`,
 * `fold-controls.ts`): the arrow flips one row, Alt on it or the row's quick control everything
 * inside, a preview line opens everything inside its row, and the tree's own control the page.
 * Nothing is hover-only: every control is drawn on touch too.
 */
import { Anchor, Badge, Box, Popover, Stack, Text, Tooltip } from "@mantine/core";
import { blockTitle } from "@shared/outline";
import type {
	OutlineBlockViewResponse,
	OutlineQuestionMark,
	OutlineTaskStatus,
	OutlineViewBlock,
} from "@shared/outline-api";
import {
	FOLD_MARK_KEYS,
	type FoldAction,
	type FoldMarkKey,
	type FoldPreview,
	type FoldTree,
	type FoldView,
	foldPageControl,
	foldPreviewLine,
	foldQuestionsUnder,
	visibleFoldRows,
} from "@shared/outline-fold";
import { IconFoldDown, IconFoldUp } from "@tabler/icons-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { reportLineDisplay } from "../../lib/outline-report-line";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import { viewFoldSource, viewFoldTree } from "../../lib/outline-view";
import { ownKeys, plainClick, spokenLabel } from "./fold-controls";
import classes from "./Outline.module.css";
import { OutlineBlockBody } from "./OutlineBlockBody";
import { OutlineStatusChip, OutlineStatusIcon } from "./OutlineStatusIcon";
import { FOCUS_ICON, FOLD_ICONS, QUESTION_ICON, rowMarker } from "./outline-icons";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

/** Indentation stops growing past this depth so deep outlines stay inside a phone's width. */
const MAX_INDENT_DEPTH = 8;
const INDENT_PX = 18;

/**
 * A task's status: the state's badge, the same one the live editor's frame draws
 * (`outline-icons.ts`).
 */
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

/**
 * The mark of a question put to a person (`Ask`) where a task has its checkbox: a question is
 * answered or withdrawn, never checked off.
 */
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

function FoldIcon({ collapsed }: { collapsed: boolean }) {
	const { Icon } = FOLD_ICONS[collapsed ? "collapsed" : "expanded"];
	return <Icon size={14} />;
}

function FocusIcon() {
	const { Icon } = FOCUS_ICON;
	return <Icon size={14} />;
}

/** What a closed row hides that must not be missed, as chips with counts. */
const HIDDEN_MARK: Record<
	FoldMarkKey,
	{ key: string; status?: "waiting" | "locked" | "newly_done" }
> = {
	question: { key: "fold.hiddenQuestion" },
	pending: { key: "fold.hiddenPending", status: "waiting" },
	locked: { key: "fold.hiddenLocked", status: "locked" },
	fresh: { key: "fold.hiddenFresh", status: "newly_done" },
};

/** The label of a preview line: how much more there is behind it, or nothing. */
export function foldPreviewLabel(
	t: (key: string, options?: Record<string, unknown>) => string,
	preview: Pick<FoldPreview, "kind" | "rest" | "total" | "more">,
): string | null {
	if (preview.kind === "report") return t("fold.reportAll", { count: preview.total });
	if (preview.rest > 0) return t("fold.more", { count: preview.rest });
	return preview.more ? t("fold.open") : null;
}

interface RowProps {
	block: OutlineViewBlock;
	depth: number;
	/** Pixels per level, and the depth past which indentation stops growing. */
	indentStep: number;
	indentMax: number;
	hasChildren: boolean;
	open: boolean;
	/** The row's preview line, flattened so an unchanged row is not rendered again. */
	previewKind: FoldPreview["kind"] | null;
	previewText: string;
	previewRest: number;
	previewTotal: number;
	previewMore: boolean;
	subtree: "expand" | "collapse" | null;
	/** Counts of what the closed row hides, in {@link FOLD_MARK_KEYS}' order ("" for none). */
	hidden: string;
	factsView: boolean;
	spaceId: string;
	search: OutlineBlockSearch;
	onFold: (action: FoldAction) => void;
	/** The row's count of hidden unanswered questions was used. */
	onQuestions: (id: string) => void;
}

const OutlineRow = memo(function OutlineRow({
	block,
	depth,
	indentStep,
	indentMax,
	hasChildren,
	open,
	previewKind,
	previewText,
	previewRest,
	previewTotal,
	previewMore,
	subtree,
	hidden,
	factsView,
	spaceId,
	search,
	onFold,
	onQuestions,
}: RowProps) {
	const { t, i18n } = useTranslation("outline");
	const collapsed = hasChildren && !open;
	const done = block.task?.status === "done" || block.task?.status === "cancelled";
	// One marker per row: a task's checkbox or a question's mark, else the bullet. The bullet is
	// also how a block is focused, so a row without one gets a focus handle at its end.
	const marker = rowMarker({ task: !!block.task, question: !!block.question });
	// A subagent report's container line reads in the viewer's language and time zone, and says
	// who wrote it when the server may tell.
	const reportLine = reportLineDisplay(block.content, {
		t,
		locale: i18n?.language,
		from: block.reportFrom,
	});
	const title = (reportLine ?? blockTitle(block.content)).slice(0, 80) || t("fold.untitled");
	const arrowRef = useRef<HTMLButtonElement>(null);
	const quickRef = useRef<HTMLButtonElement>(null);
	// A preview line goes away when it is used: focus moves to the row's own control.
	const focusAfterPreview = useRef(false);
	useLayoutEffect(() => {
		if (!focusAfterPreview.current || previewKind) return;
		focusAfterPreview.current = false;
		(quickRef.current ?? arrowRef.current)?.focus();
	}, [previewKind]);
	const id = block.id;
	const toggleNode = () => onFold({ kind: "node", id });
	const toggleSubtree = () => onFold({ kind: "subtree", id, open: subtree !== "collapse" });
	const openPreview = () => {
		focusAfterPreview.current = true;
		onFold({ kind: "subtree", id, open: true });
	};
	const focusLink = (children: React.ReactNode, className: string, label?: string) => (
		<OutlineLink
			to={outlineBlockTarget(spaceId, block.id, search.view, search.asOf)}
			className={className}
			aria-label={label}
		>
			{children}
		</OutlineLink>
	);
	const arrowAction = t(collapsed ? "page.expand" : "page.collapse");
	const subtreeAction = t(subtree === "collapse" ? "fold.subtreeCollapse" : "fold.subtreeExpand");
	const hiddenCounts = hidden ? hidden.split(",").map(Number) : [];
	const previewLabel = previewKind
		? foldPreviewLabel(t, {
				kind: previewKind,
				rest: previewRest,
				total: previewTotal,
				more: previewMore,
			})
		: null;
	const indent = Math.min(depth, indentMax) * indentStep;
	return (
		<>
			<div
				className={classes.row}
				data-block-id={block.id}
				data-marker={marker}
				data-fold={hasChildren ? (open ? "open" : "closed") : undefined}
			>
				<span className={classes.indent} style={{ width: indent }} />
				<span className={classes.toggle}>
					{hasChildren && (
						<button
							type="button"
							className={`${classes.toggleButton} mantine-focus-auto`}
							ref={arrowRef}
							aria-label={`${arrowAction} · ${title}`}
							aria-expanded={!collapsed}
							title={`${arrowAction} · ${t("fold.altHint")}`}
							data-fold-toggle=""
							onClick={(e: React.MouseEvent) => {
								if (!plainClick(e)) return;
								if (e.altKey) toggleSubtree();
								else toggleNode();
							}}
							onKeyDown={ownKeys((alt) => (alt ? toggleSubtree() : toggleNode()))}
						>
							<FoldIcon collapsed={collapsed} />
						</button>
					)}
				</span>
				{marker === "bullet" &&
					focusLink(
						<span className={classes.bulletDot} data-collapsed={collapsed} />,
						classes.bullet,
						t("page.focus"),
					)}
				{marker === "task" && block.task && <OutlineTaskIcon status={block.task.status} />}
				{marker === "question" && block.question && (
					<OutlineQuestionIcon state={block.question.state} proceed={block.question.proceed} />
				)}
				<div className={classes.content} data-done={done}>
					{reportLine !== null ? (
						<span className="nf-type-scope" data-testid="outline-report-line" title={block.content}>
							{reportLine}
						</span>
					) : (
						<OutlineBlockBody content={block.content} />
					)}
					{(block.alias ||
						block.tags.length > 0 ||
						block.task?.assignee ||
						block.task?.due ||
						(factsView && block.processHidden > 0) ||
						block.lock ||
						block.pending.length > 0 ||
						hidden !== "" ||
						block.hidden > 0) && (
						<div className={classes.meta}>
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
							{factsView && block.openTasks > 0 && (
								<InProgressMarker block={block} spaceId={spaceId} search={search} />
							)}
							{factsView && block.openTasks === 0 && block.processHidden > 0 && (
								<Tooltip label={t("page.hiddenUnderHint")} openDelay={300}>
									<Badge
										size="xs"
										variant="light"
										color="gray"
										tt="none"
										data-testid="outline-hidden-under"
									>
										{t("page.hiddenUnder", { count: block.processHidden })}
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
							{FOLD_MARK_KEYS.map((kind, i) => {
								const count = hiddenCounts[i] ?? 0;
								if (count <= 0) return null;
								const mark = HIDDEN_MARK[kind];
								const label = t(mark.key, { count });
								const props = {
									title: label,
									"aria-label": label,
									"data-testid": "outline-fold-hidden",
									"data-kind": kind,
								};
								return mark.status ? (
									<OutlineStatusChip key={kind} status={mark.status} {...props}>
										{count}
									</OutlineStatusChip>
								) : (
									// The questions it hides are one step away: the count opens them and
									// where they are answered.
									<Badge
										key={kind}
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
							{block.hidden > 0 &&
								!collapsed &&
								focusLink(t("page.more", { count: block.hidden }), classes.more)}
						</div>
					)}
				</div>
				{subtree && (
					<button
						ref={quickRef}
						type="button"
						className={`${classes.foldAll} mantine-focus-auto`}
						aria-expanded={subtree === "collapse"}
						aria-label={t("fold.subtree", { title })}
						title={subtreeAction}
						data-fold-subtree={subtree}
						onClick={(e) => {
							if (plainClick(e)) toggleSubtree();
						}}
						onKeyDown={ownKeys(() => toggleSubtree())}
					>
						{subtree === "collapse" ? <IconFoldUp size={14} /> : <IconFoldDown size={14} />}
					</button>
				)}
				{marker !== "bullet" && focusLink(<FocusIcon />, classes.focusHandle, t("page.focus"))}
			</div>
			{previewKind && (
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
					data-fold-preview={previewKind}
					data-fold-of={block.id}
					onClick={(e) => {
						if (plainClick(e)) openPreview();
					}}
					onKeyDown={ownKeys(() => openPreview())}
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

/**
 * The "in progress" marker of a fact (design §3.1): the open tasks under it; opening it lists them
 * (title, state, who, whether a change to it waits for confirmation), each focusable.
 */
function InProgressMarker({
	block,
	spaceId,
	search,
}: {
	block: OutlineViewBlock;
	spaceId: string;
	search: OutlineBlockSearch;
}) {
	const { t } = useTranslation("outline");
	return (
		<Popover position="bottom-start" withinPortal shadow="sm" width={300}>
			<Popover.Target>
				<Badge
					size="xs"
					variant="dot"
					color="yellow"
					tt="none"
					component="button"
					style={{ cursor: "pointer" }}
					aria-label={t("page.inProgressHint")}
					data-testid="outline-in-progress"
				>
					{t("page.inProgress", { count: block.openTasks })}
				</Badge>
			</Popover.Target>
			<Popover.Dropdown p={4}>
				<Text size="xs" c="dimmed" px={6} pb={2}>
					{t("page.inProgressHint")}
				</Text>
				<InProgressList block={block} spaceId={spaceId} search={search} />
			</Popover.Dropdown>
		</Popover>
	);
}

/**
 * The tasks and questions put to people in progress under a block (the "in progress" marker's
 * list): a question shows its mark, a task its checkbox.
 */
export function InProgressList({
	block,
	spaceId,
	search,
}: {
	block: OutlineViewBlock;
	spaceId: string;
	search: OutlineBlockSearch;
}) {
	const { t } = useTranslation("outline");
	return (
		<Stack gap={0}>
			{block.inProgress.map((item) => (
				<OutlineLink
					key={item.id}
					to={outlineBlockTarget(spaceId, item.id, search.view, search.asOf)}
					className={classes.listItem}
				>
					<Box style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
						{item.question ? (
							<OutlineQuestionIcon state="open" />
						) : (
							<OutlineTaskIcon status={item.status} />
						)}
						<Text size="sm" className={classes.ellipsis}>
							{item.title || item.sid}
						</Text>
					</Box>
					{(item.assignee || item.waiting) && (
						<Text size="xs" c="dimmed" className={classes.ellipsis}>
							{[
								item.assignee ? `@${item.assignee}` : null,
								item.waiting ? t("page.waitingConfirmation") : null,
							]
								.filter(Boolean)
								.join(" · ")}
						</Text>
					)}
				</OutlineLink>
			))}
			{block.openTasks > block.inProgress.length && (
				<OutlineLink
					to={outlineBlockTarget(spaceId, block.id, "all", search.asOf)}
					className={classes.listItem}
				>
					<Text size="xs" c="dimmed">
						{t("page.inProgressMore", {
							count: block.openTasks - block.inProgress.length,
						})}
					</Text>
				</OutlineLink>
			)}
		</Stack>
	);
}

export interface OutlineBlockTreeProps {
	view: OutlineBlockViewResponse;
	/** The reader's own folding of the page (what they opened and what they closed). */
	fold: FoldView;
	search: OutlineBlockSearch;
	/** The reader folds: the tree as it is shown, and what they did. */
	onFold: (tree: FoldTree, action: FoldAction) => void;
	/**
	 * The reader used a closed row's count of unanswered questions: they are on screen now, and
	 * the host takes the reader to where they are answered (`under`: the block the first is
	 * under, whose page holds its answer form).
	 */
	onOpenQuestions?: (ids: string[], under: string | null) => void;
	/**
	 * Indentation: pixels per level and the depth past which it stops growing. A page opened
	 * inside the connected outline (`tree/OutlineTree.tsx`) is already indented by the tree.
	 */
	indent?: { step: number; max: number };
}

/**
 * The blocks under the view's root, as an indented list with the default folding, the reader's
 * own over it, and focus.
 */
export function OutlineBlockTree({
	view,
	fold,
	search,
	onFold,
	onOpenQuestions,
	indent,
}: OutlineBlockTreeProps) {
	const indentStep = indent?.step ?? INDENT_PX;
	const indentMax = indent?.max ?? MAX_INDENT_DEPTH;
	const { t } = useTranslation("outline");
	const byId = useMemo(() => new Map(view.blocks.map((b) => [b.id, b])), [view]);
	const source = useMemo(() => viewFoldSource(view), [view]);
	const tree = useMemo(() => viewFoldTree(view, source, fold), [view, source, fold]);
	const rows = useMemo(() => visibleFoldRows(tree, source).rows, [tree, source]);
	// Stable for the memoized rows: the tree of the moment is read when a row acts.
	const latest = useRef({ tree, source, onFold, onOpenQuestions });
	latest.current = { tree, source, onFold, onOpenQuestions };
	const act = useCallback(
		(action: FoldAction) => latest.current.onFold(latest.current.tree, action),
		[],
	);
	const questions = useCallback((id: string) => {
		const now = latest.current;
		const ids = foldQuestionsUnder(now.tree, now.source, id);
		// (Opening is by each block's own default, so the tree as it was serves them all.)
		for (const q of ids) now.onFold(now.tree, { kind: "reveal", id: q });
		if (ids.length > 0)
			now.onOpenQuestions?.(ids, now.tree.nodes.get(ids[0] as string)?.parent ?? null);
	}, []);
	const root = byId.get(view.rootId);
	if (rows.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{view.view === "facts" && view.hiddenByView > 0 ? t("page.factsEmpty") : t("page.empty")}
			</Text>
		);
	}
	const all = foldPageControl(tree, fold);
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
					onClick={() => act({ kind: "all", open: all === "expand" })}
					onKeyDown={ownKeys(() => act({ kind: "all", open: all === "expand" }))}
					data-testid="outline-fold-all"
					data-fold-all={all}
				>
					{t(all === "expand" ? "fold.expandAll" : "fold.collapseAll")}
				</Anchor>
			)}
			{rows.map((row) => {
				const block = byId.get(row.node.id);
				if (!block) return null;
				const preview = row.preview;
				const text = preview ? byId.get(preview.textId) : undefined;
				// A row a folded read left blocks out under (`fold: "default"`): how much is behind
				// it is what the server counted, not what this read holds.
				const cut = block.fold && !row.node.open ? block.fold : null;
				return (
					<OutlineRow
						key={block.id}
						block={block}
						depth={row.depth}
						indentStep={indentStep}
						indentMax={indentMax}
						hasChildren={row.node.kids.length > 0}
						open={row.node.open}
						previewKind={preview?.kind ?? null}
						previewText={text ? foldPreviewLine(blockTitle(text.content)) : ""}
						previewRest={cut ? cut.kids - 1 : (preview?.rest ?? 0)}
						previewTotal={cut ? cut.size : (preview?.total ?? 0)}
						previewMore={cut ? cut.size > 1 : (preview?.more ?? false)}
						subtree={row.subtree ?? (cut && cut.size > cut.kids ? "expand" : null)}
						hidden={row.hidden ? FOLD_MARK_KEYS.map((k) => row.hidden?.[k] ?? 0).join(",") : ""}
						factsView={view.view === "facts"}
						spaceId={view.space.id}
						search={search}
						onFold={act}
						onQuestions={questions}
					/>
				);
			})}
			{root && root.hidden > 0 && (
				<Text size="xs" c="dimmed" mt={4}>
					{t("page.moreAtRoot", { count: root.hidden })}
				</Text>
			)}
		</Box>
	);
}
