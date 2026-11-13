/**
 * A search drawn as a tree (readability F, design §2.8): the matches with what they are under —
 * their space, their page, their ancestors — and nothing else, in place of the tree while a
 * query is typed.
 *
 *   ▾ Project A
 *       ▾ Tasks
 *           ▾ Fix the refresh race
 *               • The reader's cache        … the **race** is in the reader's cache …
 *
 * A match's title is a button: it shows the match in the tree itself ("locate": the host clears
 * the search and hands the tree the block). Its focus handle opens the page instead. The rows
 * that only lead to matches are links that focus them. Every row has its arrow; the same roles
 * and keys as the tree (`OutlineTree.tsx`). Bounded: pages of the server's search, the next one
 * read only when asked for.
 */
import { Alert, Anchor, Badge, Loader, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import type { OutlineSearchHitView } from "@shared/outline-api";
import { IconFileText } from "@tabler/icons-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSearchPages } from "../../../hooks/useOutline";
import { reportLineDisplay } from "../../../lib/outline-report-line";
import { plainClick } from "../fold-controls";
import classes from "../Outline.module.css";
import { useOutlineSpaceName } from "../OutlineSpaceName";
import { FOCUS_ICON, FOLD_ICONS } from "../outline-icons";
import { OutlineLink, outlineBlockTarget } from "../outline-nav";
import { onTreeKeyDown, SPACE_ICON } from "./OutlineTree";
import { buildSearchTree, markTerms, type SearchTreeNode, searchTerms } from "./search-tree";
import type { TreeLocateTarget } from "./tree-locate";

const NARROW_PX = 480;
const MAX_INDENT = 4;

/** What "locate" needs of a hit. */
export function locateTargetOfHit(hit: OutlineSearchHitView): TreeLocateTarget {
	return {
		spaceId: hit.spaceId,
		pageId: hit.pageId,
		blockId: hit.blockId,
		pathIds: hit.pathIds ?? [],
		pageTitle: hit.pageId === hit.blockId ? hit.title : (hit.path[0] ?? ""),
	};
}

function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
	const parts = markTerms(text, terms);
	let offset = 0;
	return (
		<>
			{parts.map((part) => {
				const key = offset;
				offset += part.text.length;
				return part.match ? <mark key={key}>{part.text}</mark> : part.text;
			})}
		</>
	);
}

function SearchRow({
	node,
	depth,
	step,
	terms,
	closed,
	onToggle,
	onLocate,
}: {
	node: SearchTreeNode;
	depth: number;
	step: number;
	terms: readonly string[];
	closed: ReadonlySet<string>;
	onToggle: (key: string) => void;
	onLocate: (hit: OutlineSearchHitView) => void;
}) {
	const { t, i18n } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	const rowKey = `${node.spaceId}:${node.key}`;
	const parent = node.children.length > 0;
	const open = parent && !closed.has(rowKey);
	const { Icon: Arrow } = FOLD_ICONS[open ? "expanded" : "collapsed"];
	const raw =
		node.kind === "space"
			? node.space
				? spaceName(node.space)
				: t("space.sessionUnnamed")
			: node.title;
	// A subagent report's container line reads as it does on its page.
	const title =
		(node.kind === "space"
			? raw
			: (reportLineDisplay(raw, { t, locale: i18n?.language }) ?? raw)) ||
		t("tree.search.untitled");
	const action = t(open ? "page.collapse" : "page.expand");
	const indent = Math.min(depth, MAX_INDENT) * step;
	const hit = node.hit;
	let icon: ReactNode;
	if (node.kind === "space") {
		const Icon = SPACE_ICON[node.space?.kind ?? "session"];
		icon = <Icon size={16} />;
	} else if (node.kind === "page") {
		icon = <IconFileText size={16} />;
	} else {
		icon = <span className={classes.bulletDot} />;
	}
	const target = node.blockId ? outlineBlockTarget(node.spaceId, node.blockId) : null;
	return (
		<div
			role="treeitem"
			tabIndex={-1}
			aria-level={depth + 1}
			aria-expanded={parent ? open : undefined}
			aria-selected={false}
			data-tree-item=""
		>
			<div
				className={classes.treeRow}
				data-tree-node={`search:${rowKey}`}
				data-tree-kind={node.kind}
				data-open={open}
				data-search-hit={hit ? hit.blockId : undefined}
				style={{ paddingInlineStart: indent }}
			>
				<span className={classes.toggle}>
					{/* Always drawn: a row without children has nothing to open, and says so. */}
					<button
						type="button"
						tabIndex={-1}
						className={`${classes.toggleButton} mantine-focus-auto`}
						aria-expanded={parent ? open : undefined}
						aria-label={`${action} · ${title}`}
						title={action}
						disabled={!parent}
						data-tree-toggle=""
						onClick={(event) => {
							if (plainClick(event)) onToggle(rowKey);
						}}
					>
						<Arrow size={14} />
					</button>
				</span>
				<span className={classes.treeIcon} aria-hidden="true">
					{icon}
				</span>
				{hit ? (
					<button
						type="button"
						className={`${classes.treeTitle} ${classes.treeHitTitle} mantine-focus-auto`}
						title={t("tree.search.locate", { title })}
						aria-label={t("tree.search.locate", { title })}
						onClick={() => onLocate(hit)}
						data-tree-title=""
					>
						<Marked text={title} terms={terms} />
					</button>
				) : node.kind === "space" ? (
					<OutlineLink
						to={{ kind: "space", spaceId: node.spaceId }}
						className={classes.treeTitle}
						title={title}
						data-tree-title=""
					>
						{title}
					</OutlineLink>
				) : (
					target && (
						<OutlineLink
							to={target}
							className={`${classes.treeTitle} ${classes.treePathTitle}`}
							title={title}
							data-tree-title=""
						>
							{title}
						</OutlineLink>
					)
				)}
				{hit && (
					<span className={classes.treeMeta}>
						{hit.process && (
							<Badge size="xs" variant="light" color="yellow" tt="none">
								{t("home.process")}
							</Badge>
						)}
						{target && (
							<OutlineLink
								to={target}
								className={classes.focusHandle}
								aria-label={`${t("tree.openPage")} · ${title}`}
								title={t("tree.openPage")}
							>
								<FOCUS_ICON.Icon size={14} />
							</OutlineLink>
						)}
					</span>
				)}
			</div>
			{hit?.snippet && hit.snippet !== hit.title && (
				<div
					className={classes.treeSnippet}
					style={{ paddingInlineStart: indent + 48 }}
					data-search-snippet=""
				>
					<Marked text={hit.snippet} terms={terms} />
				</div>
			)}
			{open && (
				// biome-ignore lint/a11y/useSemanticElements: a tree item's children, not a form's fields
				<div role="group">
					{node.children.map((child) => (
						<SearchRow
							key={child.key}
							node={child}
							depth={depth + 1}
							step={step}
							terms={terms}
							closed={closed}
							onToggle={onToggle}
							onLocate={onLocate}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function OutlineSearchTree({
	query,
	spaceId,
	enabled = true,
	onLocate,
}: {
	query: string;
	/** Search within one space; null: every outline the reader can read. */
	spaceId: string | null;
	enabled?: boolean;
	/** A match was chosen: show it in the tree. */
	onLocate: (target: TreeLocateTarget) => void;
}) {
	const { t } = useTranslation("outline");
	const search = useOutlineSearchPages(query, spaceId, enabled);
	const { ref, width } = useElementSize();
	const step = width > 0 && width < NARROW_PX ? 12 : 18;
	const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
	const pages = search.data?.pages;
	const roots = useMemo(
		() =>
			buildSearchTree(
				pages?.flatMap((page) => page.hits) ?? [],
				pages?.flatMap((page) => page.spaces ?? []) ?? [],
			),
		[pages],
	);
	const terms = useMemo(() => searchTerms(query), [query]);
	const toggle = (key: string) =>
		setClosed((now) => {
			const next = new Set(now);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	return (
		<div ref={ref} className={classes.tree} data-testid="outline-search-tree">
			{search.isLoading && <Loader size="xs" />}
			{search.isError && (
				<Alert color="red" variant="light">
					{t("loadFailed")}
				</Alert>
			)}
			{pages && roots.length === 0 && (
				<Text size="sm" c="dimmed">
					{t("home.noResults")}
				</Text>
			)}
			{roots.length > 0 && (
				<>
					<Text size="xs" c="dimmed" mb={4} className={classes.ellipsis}>
						{t("tree.search.hint")}
					</Text>
					<div role="tree" aria-label={t("tree.search.label")} onKeyDown={onTreeKeyDown}>
						{roots.map((root) => (
							<SearchRow
								key={root.key}
								node={root}
								depth={0}
								step={step}
								terms={terms}
								closed={closed}
								onToggle={toggle}
								onLocate={(hit) => onLocate(locateTargetOfHit(hit))}
							/>
						))}
						{search.hasNextPage && (
							<div
								role="treeitem"
								tabIndex={-1}
								aria-level={1}
								aria-selected={false}
								className={classes.treeNote}
								style={{ paddingInlineStart: 24 }}
							>
								<Anchor
									component="button"
									type="button"
									size="sm"
									onClick={() => void search.fetchNextPage()}
									disabled={search.isFetchingNextPage}
									data-tree-more=""
								>
									{t("tree.search.more")}
								</Anchor>
								{search.isFetchingNextPage && <Loader size={12} ml={6} />}
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
