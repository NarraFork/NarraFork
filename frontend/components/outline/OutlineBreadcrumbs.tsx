import { Anchor, Breadcrumbs, Text } from "@mantine/core";
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import { useTranslation } from "react-i18next";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { useOutlineSpaceName } from "./OutlineSpaceName";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

/**
 * Outline › space › page › … › the focused block. Every ancestor is a link that focuses it,
 * keeping the view and the time the page is shown at. While the page is edited live, `path`
 * comes from the live page (it follows focus at once, before the read of the block lands).
 */
export function OutlineBreadcrumbs({
	view,
	rootTitle,
	search,
	path,
}: {
	view: OutlineBlockViewResponse;
	rootTitle: string;
	search: OutlineBlockSearch;
	path?: OutlineBlockViewResponse["path"];
}) {
	const { t } = useTranslation("outline");
	const spaceName = useOutlineSpaceName();
	return (
		<Breadcrumbs separatorMargin={4} className={classes.breadcrumbs} style={{ flexWrap: "wrap" }}>
			<Anchor
				size="sm"
				className={classes.crumb}
				renderRoot={(props) => <OutlineLink {...props} to={{ kind: "home" }} />}
			>
				{t("title")}
			</Anchor>
			<Anchor
				size="sm"
				className={classes.crumb}
				renderRoot={(props) => (
					<OutlineLink {...props} to={{ kind: "space", spaceId: view.space.id }} />
				)}
			>
				{spaceName(view.space)}
			</Anchor>
			{(path ?? view.path).map((ancestor) => (
				<Anchor
					key={ancestor.id}
					size="sm"
					className={classes.crumb}
					title={ancestor.title}
					renderRoot={(props) => (
						<OutlineLink
							{...props}
							to={outlineBlockTarget(view.space.id, ancestor.id, search.view, search.asOf)}
						/>
					)}
				>
					{ancestor.title || ancestor.sid}
				</Anchor>
			))}
			<Text
				size="sm"
				fw={500}
				className={classes.crumb}
				title={rootTitle}
				data-testid="outline-crumb-here"
			>
				{rootTitle}
			</Text>
		</Breadcrumbs>
	);
}
