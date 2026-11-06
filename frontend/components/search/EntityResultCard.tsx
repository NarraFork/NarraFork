import { Text } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { EntitySearchResult } from "../../lib/api";
import { formatSmartTime } from "../../lib/format";
import { highlightSearchText } from "../../lib/search-utils";
import classes from "./Search.module.css";
import { SearchResultFrame } from "./SearchResultFrame";

const linkStyle = { textDecoration: "none", color: "inherit", display: "block" } as const;
const MAX_SNIPPET_CHARS = 2_000;

function humanize(value: string): string {
	const normalized = value.replace(/[_-]+/g, " ").trim();
	return normalized ? normalized.replace(/\b\w/g, (char) => char.toUpperCase()) : value;
}

/** A knowledge entry hit; the whole card links to it. */
export function EntityResultCard({ result, query }: { result: EntitySearchResult; query: string }) {
	const { t } = useTranslation("search");
	const time = result.updatedAt ?? result.createdAt;
	// "Active" is every live entry's status; only a status worth noticing is shown.
	const status =
		result.status && result.status !== "active"
			? t(`status_${result.type}_${result.status}`, { defaultValue: humanize(result.status) })
			: undefined;
	return (
		<Link
			to="/knowledge/$entryId"
			params={{ entryId: result.id }}
			style={linkStyle}
			className={classes.resultLink}
		>
			<SearchResultFrame
				title={
					<Text fw={500} truncate className={classes.resultTitle}>
						{highlightSearchText(
							result.title || t("resultUntitled", { id: result.id.slice(0, 8) }),
							query,
						)}
					</Text>
				}
				meta={[
					result.collectionName ?? t(`label_${result.type}`),
					result.projectName,
					status,
					time ? formatSmartTime(time) : undefined,
				]}
			>
				{result.snippet && (
					<Text size="sm" lineClamp={2} mt={8}>
						{highlightSearchText(result.snippet.slice(0, MAX_SNIPPET_CHARS), query)}
					</Text>
				)}
			</SearchResultFrame>
		</Link>
	);
}
