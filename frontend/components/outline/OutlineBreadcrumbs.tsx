import { Menu, UnstyledButton } from "@mantine/core";
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { planCrumbs } from "../../lib/outline-crumbs";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { useOutlineSpaceName } from "./OutlineSpaceName";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

type Ancestor = OutlineBlockViewResponse["path"][number];

/**
 * Outline › space › page › … › the focused block's parent: where the page is, not what it is. The
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
	const { t } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	const plan = planCrumbs(path ?? view.path);
	const targetOf = (ancestor: Ancestor) =>
		outlineBlockTarget(view.space.id, ancestor.id, search.view, search.asOf);
	const crumb = (ancestor: Ancestor, last: boolean) => (
		<OutlineLink
			to={targetOf(ancestor)}
			className={classes.crumb}
			data-last={last || undefined}
			title={ancestor.title}
		>
			{ancestor.title || ancestor.sid}
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
									<span className={classes.crumbMenuItem}>{ancestor.title || ancestor.sid}</span>
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
