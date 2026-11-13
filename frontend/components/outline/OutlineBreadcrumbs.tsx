import { Menu, UnstyledButton } from "@mantine/core";
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import { IconBinaryTree2 } from "@tabler/icons-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSpaceParent } from "../../hooks/useOutline";
import { planCrumbs } from "../../lib/outline-crumbs";
import { reportLineDisplay } from "../../lib/outline-report-line";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { useOutlineSpaceName } from "./OutlineSpaceName";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";
import { requestTreeLocate } from "./tree/tree-locate";
import type { TreeHost } from "./tree/tree-open-state";

type Ancestor = OutlineBlockViewResponse["path"][number];

/**
 * Outline › (a session's project ›) space › page › … › the focused block's parent: where the page
 * is, not what it is. A session space names its project when the reader may read it (the space's
 * `parent`, read once per space and kept: commits do not change it). The
 * focused block's own title is the page title right below (and the tab's name in a dock), so the
 * bar does not say it again. Every crumb is a link that focuses it, keeping the view and the
 * time the page is shown at. While the page is edited live, `path` comes from the live page (it
 * follows focus at once, before the read of the block lands).
 *
 * One line, always: crumbs truncate, and a deep path folds its middle into a "…" menu
 * (`planCrumbs`).
 */
export function OutlineBreadcrumbs({
	view,
	search,
	path,
}: {
	view: OutlineBlockViewResponse;
	search: OutlineBlockSearch;
	path?: OutlineBlockViewResponse["path"];
}) {
	const { t, i18n } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	const parent = useOutlineSpaceParent(view.space.id, view.space.kind === "session").data;
	const plan = planCrumbs(path ?? view.path);
	const targetOf = (ancestor: Ancestor) =>
		outlineBlockTarget(view.space.id, ancestor.id, search.view, search.asOf);
	// An ancestor that is a subagent report's container reads as on its own page.
	const labelOf = (ancestor: Ancestor) =>
		reportLineDisplay(ancestor.title, { t, locale: i18n?.language }) ??
		(ancestor.title || ancestor.sid);
	const crumb = (ancestor: Ancestor, last: boolean) => (
		<OutlineLink
			to={targetOf(ancestor)}
			className={classes.crumb}
			data-last={last || undefined}
			title={labelOf(ancestor)}
		>
			{labelOf(ancestor)}
		</OutlineLink>
	);
	const separator = (
		<span className={classes.crumbSeparator} aria-hidden="true">
			/
		</span>
	);
	const shown = [...plan.head, ...plan.tail];
	const lastId = shown.at(-1)?.id;
	return (
		<nav
			className={classes.breadcrumbs}
			aria-label={t("crumbs.label")}
			data-testid="outline-crumbs"
		>
			<OutlineLink to={{ kind: "home" }} className={classes.crumb} data-fixed>
				{t("title")}
			</OutlineLink>
			{separator}
			{parent && (
				<>
					<OutlineLink
						to={{ kind: "space", spaceId: parent.spaceId }}
						className={classes.crumb}
						title={parent.label ?? t("space.projectUnnamed")}
						data-testid="outline-crumb-project"
					>
						{parent.label ?? t("space.projectUnnamed")}
					</OutlineLink>
					{separator}
				</>
			)}
			<OutlineLink
				to={{ kind: "space", spaceId: view.space.id }}
				className={classes.crumb}
				data-last={shown.length === 0 || undefined}
				title={spaceName(view.space)}
			>
				{spaceName(view.space)}
			</OutlineLink>
			{plan.head.map((ancestor) => (
				<Fragment key={ancestor.id}>
					{separator}
					{crumb(ancestor, ancestor.id === lastId)}
				</Fragment>
			))}
			{plan.hidden.length > 0 && (
				<>
					{separator}
					<Menu position="bottom-start" withinPortal shadow="sm">
						<Menu.Target>
							<UnstyledButton
								className={classes.crumbFold}
								aria-label={t("crumbs.more", { count: plan.hidden.length })}
								data-testid="outline-crumbs-more"
							>
								…
							</UnstyledButton>
						</Menu.Target>
						<Menu.Dropdown>
							{plan.hidden.map((ancestor) => (
								<Menu.Item
									key={ancestor.id}
									renderRoot={(props) => <OutlineLink {...props} to={targetOf(ancestor)} />}
								>
									<span className={classes.crumbMenuItem}>{labelOf(ancestor)}</span>
								</Menu.Item>
							))}
						</Menu.Dropdown>
					</Menu>
				</>
			)}
			{plan.tail.map((ancestor) => (
				<Fragment key={ancestor.id}>
					{separator}
					{crumb(ancestor, ancestor.id === lastId)}
				</Fragment>
			))}
		</nav>
	);
}

/**
 * "Show in the outline tree" (readability F), beside the bar, among the page's controls: the
 * reader is taken to the tree, where what this block is under opens and the tree scrolls to it.
 * Not a crumb and not in the bar: the crumbs' one line is theirs alone.
 */
export function OutlineLocateLink({
	view,
	path,
	host,
	blockId,
	title,
}: {
	view: OutlineBlockViewResponse;
	path?: OutlineBlockViewResponse["path"];
	/** The host whose tree shows it (the outline page, a dock panel). */
	host: TreeHost;
	/** The focused block and its title. */
	blockId: string;
	title: string;
}) {
	const { t } = useTranslation("outline");
	const above = path ?? view.path;
	return (
		<OutlineLink
			to={{ kind: "home" }}
			className={classes.crumbLocate}
			aria-label={t("tree.locate")}
			title={t("tree.locate")}
			data-testid="outline-locate"
			onClick={(event) => {
				// Only a plain click goes to this host's tree (a new tab has its own).
				if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
					return;
				requestTreeLocate(host, {
					spaceId: view.space.id,
					pageId: above[0]?.id ?? blockId,
					blockId,
					pathIds: above.map((ancestor) => ancestor.id),
					pageTitle: above[0]?.title ?? title,
				});
			}}
		>
			<IconBinaryTree2 size={16} />
		</OutlineLink>
	);
}
