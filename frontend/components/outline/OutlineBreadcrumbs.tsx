import { Anchor, Breadcrumbs, Text } from "@mantine/core";
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { useOutlineSpaceName } from "./OutlineSpaceName";

/**
 * Outline › space › page › … › the focused block. Every ancestor is a link that focuses it,
 * keeping the view and the time the page is shown at.
 */
export function OutlineBreadcrumbs({
	view,
	rootTitle,
	search,
}: {
	view: OutlineBlockViewResponse;
	rootTitle: string;
	search: OutlineBlockSearch;
}) {
	const { t } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	return (
		<Breadcrumbs separatorMargin={4} className={classes.breadcrumbs} style={{ flexWrap: "wrap" }}>
			<Anchor component={Link} to="/outline" size="sm" className={classes.crumb}>
				{t("title")}
			</Anchor>
			<Anchor
				size="sm"
				className={classes.crumb}
				renderRoot={(props) => (
					<Link {...props} to="/outline/$spaceId" params={{ spaceId: view.space.id }} />
				)}
			>
				{spaceName(view.space)}
			</Anchor>
			{view.path.map((ancestor) => (
				<Anchor
					key={ancestor.id}
					size="sm"
					className={classes.crumb}
					title={ancestor.title}
					renderRoot={(props) => (
						<Link
							{...props}
							to="/outline/$spaceId/$blockId"
							params={{ spaceId: view.space.id, blockId: ancestor.id }}
							search={search}
						/>
					)}
				>
					{ancestor.title || ancestor.sid}
				</Anchor>
			))}
			<Text size="sm" fw={500} className={classes.crumb} title={rootTitle}>
				{rootTitle}
			</Text>
		</Breadcrumbs>
	);
}
