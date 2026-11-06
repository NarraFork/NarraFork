import { Button, Group, Loader, Stack, Text } from "@mantine/core";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionHits } from "../../hooks/useSearch";
import type { SearchRequest, SessionSearchHit, SessionSearchResult } from "../../lib/api";
import { formatSmartTime } from "../../lib/format";
import { highlightSearchText, searchHighlightTerms } from "../../lib/search-utils";
import classes from "./Search.module.css";
import { SearchResultFrame } from "./SearchResultFrame";

const linkStyle = { textDecoration: "none", color: "inherit" } as const;
/** Long excerpts are cut before highlighting so a huge message cannot stall rendering. */
const MAX_SNIPPET_CHARS = 2_000;
/** The "who · when" column in front of each matching message. */
const HIT_LABEL_WIDTH = 128;

/**
 * Where a hit's link lands: a tool call's own row for a hit inside one, else the message,
 * with the first query term as the needle that picks the right row of a message rendered
 * as several (text, thinking, tools).
 */
export function hitLinkTarget(hit: SessionSearchHit, query: string) {
	const needle = searchHighlightTerms(query)[0];
	return {
		hash: `msg-${hit.toolUseId ?? hit.id}`,
		search: needle ? { find: needle } : {},
	};
}

/**
 * A hit's time for the narrow label column: relative within a day, then the date alone
 * (`10-14`, with the year only when it is not this one). The full time is on the session.
 */
function compactHitTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	if (Date.now() - date.getTime() < 86_400_000) return formatSmartTime(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return date.getFullYear() === new Date().getFullYear() ? day : `${date.getFullYear()}-${day}`;
}

/** "Assistant · 2h" or "Tool · Grep · 10-14": who said it, and when. */
function hitLabel(hit: SessionSearchHit, t: TFunction<"search">): string {
	const who = hit.toolUseId
		? hit.toolName
			? t("toolHitNamed", { tool: hit.toolName })
			: t("toolHit")
		: hit.messageRole
			? t(`messageRole_${hit.messageRole}`, { defaultValue: hit.messageRole })
			: "";
	const when = hit.createdAt ? compactHitTime(hit.createdAt) : "";
	return [who, when].filter(Boolean).join(" · ");
}

function HitRow({
	narratorId,
	hit,
	query,
}: {
	narratorId: string;
	hit: SessionSearchHit;
	query: string;
}) {
	const { t } = useTranslation("search");
	const target = hitLinkTarget(hit, query);
	return (
		<Link
			to="/narrators/$narratorId"
			params={{ narratorId }}
			hash={target.hash}
			search={target.search as never}
			className={classes.hit}
		>
			<Text size="xs" c="dimmed" w={HIT_LABEL_WIDTH} truncate style={{ flexShrink: 0 }}>
				{hitLabel(hit, t)}
			</Text>
			<Text size="sm" lineClamp={2} style={{ minWidth: 0, flex: 1 }}>
				{highlightSearchText(hit.snippet.slice(0, MAX_SNIPPET_CHARS), query)}
			</Text>
		</Link>
	);
}

/**
 * One session matching the search: its title, one line of where and when, and the
 * matching messages newest first. The card shows the latest few; expanding it pages
 * further back through the session's matches.
 */
export function SessionResultCard({
	result,
	request,
}: {
	result: SessionSearchResult;
	request: SearchRequest;
}) {
	const { t } = useTranslation("search");
	const [expanded, setExpanded] = useState(false);
	const more = useSessionHits(result.id, request, expanded);
	const loaded = more.data?.pages.flatMap((page) => page.hits);
	const hits = expanded && loaded ? loaded : result.hits;
	const hidden = Math.max(0, result.hitCount - result.hits.length);
	const meta = [
		result.projectName,
		result.narratorType === "subagent"
			? result.subagentType
				? t("subagentWithType", { type: result.subagentType })
				: t("subagent")
			: undefined,
		result.status === "archived" ? t("archived") : undefined,
		result.lastActivityAt ? formatSmartTime(result.lastActivityAt) : undefined,
	];

	return (
		<SearchResultFrame
			title={
				<Link
					to="/narrators/$narratorId"
					params={{ narratorId: result.id }}
					style={{ ...linkStyle, minWidth: 0 }}
					className={classes.resultTitle}
				>
					<Text fw={500} truncate>
						{highlightSearchText(
							result.title || t("resultUntitled", { id: result.id.slice(0, 8) }),
							request.q,
						)}
					</Text>
				</Link>
			}
			aside={result.hitCount > 0 ? t("hitCount", { count: result.hitCount }) : undefined}
			meta={meta}
		>
			{hits.length > 0 && (
				<Stack gap={2} mt={8}>
					{hits.map((hit) => (
						<HitRow key={hit.id} narratorId={result.id} hit={hit} query={request.q} />
					))}
				</Stack>
			)}

			{(hidden > 0 || expanded) && (
				<Group gap="xs" mt={4} ml={HIT_LABEL_WIDTH + 12 - 8}>
					{!expanded ? (
						<Button
							size="compact-xs"
							variant="subtle"
							leftSection={<IconChevronDown size={14} />}
							onClick={() => setExpanded(true)}
						>
							{t("expandHits", { count: hidden })}
						</Button>
					) : (
						<>
							{more.isFetching && <Loader size="xs" />}
							{more.hasNextPage && (
								<Button
									size="compact-xs"
									variant="subtle"
									loading={more.isFetchingNextPage}
									onClick={() => more.fetchNextPage()}
								>
									{t("loadMoreHits")}
								</Button>
							)}
							<Button
								size="compact-xs"
								variant="subtle"
								color="gray"
								leftSection={<IconChevronUp size={14} />}
								onClick={() => setExpanded(false)}
							>
								{t("collapseHits")}
							</Button>
						</>
					)}
				</Group>
			)}
		</SearchResultFrame>
	);
}
