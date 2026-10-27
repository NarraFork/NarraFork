import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Stack,
	Tabs,
	Text,
	UnstyledButton,
} from "@mantine/core";
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import { IconHistory, IconLink } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineBacklinks, useOutlineBlockHistory } from "../../hooks/useOutline";
import { formatFullLocaleDateTime, formatSmartTime } from "../../lib/format";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { commitActorLabel } from "./OutlineTimeline";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

type SideTab = "backlinks" | "history";

/**
 * About the focused block, beside the outline: what links to it, and its history. Picking a
 * version shows the page as of it.
 */
export function OutlineSidePanel({
	view,
	search,
	onViewAt,
}: {
	view: OutlineBlockViewResponse;
	search: OutlineBlockSearch;
	onViewAt: (seq: number) => void;
}) {
	const { t } = useTranslation("outline");
	const [tab, setTab] = useState<SideTab>("backlinks");
	const spaceId = view.space.id;
	const blockId = view.rootId;
	const backlinks = useOutlineBacklinks(spaceId, blockId, tab === "backlinks");
	const history = useOutlineBlockHistory(spaceId, blockId, tab === "history");
	const entries = useMemo(
		() => history.data?.pages.flatMap((page) => page.entries) ?? [],
		[history.data],
	);

	return (
		<Tabs value={tab} onChange={(value) => value && setTab(value as SideTab)} keepMounted={false}>
			<Tabs.List grow>
				<Tabs.Tab value="backlinks" leftSection={<IconLink size={14} />}>
					{t("side.backlinks")}
				</Tabs.Tab>
				<Tabs.Tab value="history" leftSection={<IconHistory size={14} />}>
					{t("side.history")}
				</Tabs.Tab>
			</Tabs.List>
			<Tabs.Panel value="backlinks" pt="xs">
				{backlinks.isLoading && <Loader size="sm" />}
				{backlinks.isError && (
					<Alert color="red" variant="light">
						{t("loadFailed")}
					</Alert>
				)}
				{backlinks.data && backlinks.data.links.length === 0 && (
					<Text size="sm" c="dimmed">
						{t("side.noBacklinks")}
					</Text>
				)}
				<Stack gap={2}>
					{backlinks.data?.links.map((link) => (
						<OutlineLink
							key={`${link.blockId}:${link.kind}`}
							to={outlineBlockTarget(link.spaceId, link.blockId, search.view)}
							className={classes.listItem}
						>
							<Group gap={6} wrap="nowrap">
								<Badge size="xs" variant="light" color="gray" tt="none">
									{t(`side.linkKind.${link.kind}`)}
								</Badge>
								<Text size="sm" className={classes.ellipsis}>
									{link.title || link.address}
								</Text>
							</Group>
							<Text size="xs" c="dimmed" className={classes.ellipsis}>
								{link.address}
							</Text>
						</OutlineLink>
					))}
				</Stack>
				{backlinks.data?.truncated && (
					<Text size="xs" c="dimmed" mt={4}>
						{t("side.backlinksTruncated", { count: backlinks.data.links.length })}
					</Text>
				)}
			</Tabs.Panel>
			<Tabs.Panel value="history" pt="xs">
				{history.isLoading && <Loader size="sm" />}
				{history.isError && (
					<Alert color="red" variant="light">
						{t("loadFailed")}
					</Alert>
				)}
				{history.isSuccess && entries.length === 0 && (
					<Text size="sm" c="dimmed">
						{t("side.noHistory")}
					</Text>
				)}
				<Stack gap={2}>
					{entries.map((entry) => (
						<UnstyledButton
							key={entry.seq}
							className={classes.listItem}
							data-selected={search.asOf === entry.seq}
							aria-current={search.asOf === entry.seq ? "true" : undefined}
							title={entry.commit ? formatFullLocaleDateTime(entry.commit.createdAt) : undefined}
							aria-label={t("side.viewAt", { seq: entry.seq })}
							onClick={() => onViewAt(entry.seq)}
						>
							<Group gap={4} wrap="wrap">
								<Text size="xs" fw={500}>
									{t("timeline.commit", { seq: entry.seq })}
								</Text>
								{entry.changes
									.filter((change) => change !== "page" || entry.changes.length === 1)
									.map((change) => (
										<Badge key={change} size="xs" variant="light" tt="none">
											{t(`side.change.${change}`)}
										</Badge>
									))}
							</Group>
							{entry.commit && (
								<Text size="xs" c="dimmed" className={classes.ellipsis}>
									{[
										commitActorLabel(entry.commit, t),
										formatSmartTime(entry.commit.createdAt),
										entry.commit.summary,
									].join(" · ")}
								</Text>
							)}
						</UnstyledButton>
					))}
				</Stack>
				{history.hasNextPage && (
					<Button
						variant="subtle"
						size="compact-xs"
						mt={4}
						loading={history.isFetchingNextPage}
						onClick={() => void history.fetchNextPage()}
					>
						{t("loadMore")}
					</Button>
				)}
			</Tabs.Panel>
		</Tabs>
	);
}
