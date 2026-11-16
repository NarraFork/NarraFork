import { Alert, Badge, Group, Loader, Stack, Tabs, Text } from "@mantine/core";
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import { IconHistory, IconHourglass, IconLink } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineBacklinks, useOutlinePagePending } from "../../hooks/useOutline";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import { OutlineHistoryList } from "./history/OutlineHistoryList";
import classes from "./Outline.module.css";
import { OutlineLockSection, OutlinePendingList, pendingFor } from "./OutlinePendingPanel";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

type SideTab = "backlinks" | "history" | "pending";

/**
 * About the focused block, beside the outline: its lock (a focused task: lock or unlock it), the
 * changes to it waiting for confirmation (when there are any), what links to it, and the history
 * of its subtree (`history/OutlineHistoryList.tsx`). Picking a commit shows the block and what is
 * under it as of then.
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
	const pagePending = useOutlinePagePending(spaceId, view.pageId, view.current);
	const pending = useMemo(
		() => (view.current ? pendingFor(view, pagePending.data?.pending ?? []) : []),
		[view, pagePending.data],
	);
	const hasPending = pending.length > 0;
	// The tab goes when nothing waits any more.
	useEffect(() => {
		if (!hasPending && tab === "pending") setTab("backlinks");
	}, [hasPending, tab]);

	return (
		<>
			<OutlineLockSection view={view} />
			<Tabs value={tab} onChange={(value) => value && setTab(value as SideTab)} keepMounted={false}>
				<Tabs.List grow>
					{hasPending && (
						<Tabs.Tab
							value="pending"
							leftSection={<IconHourglass size={14} />}
							data-testid="outline-pending-tab"
						>
							{t("pending.tab")}
							<Badge size="xs" ml={4} color="orange" variant="light">
								{pending.length}
							</Badge>
						</Tabs.Tab>
					)}
					<Tabs.Tab value="backlinks" leftSection={<IconLink size={14} />}>
						{t("side.backlinks")}
					</Tabs.Tab>
					<Tabs.Tab value="history" leftSection={<IconHistory size={14} />}>
						{t("side.history")}
					</Tabs.Tab>
				</Tabs.List>
				{hasPending && (
					<Tabs.Panel value="pending" pt="xs">
						<OutlinePendingList spaceId={spaceId} pending={pending} />
					</Tabs.Panel>
				)}
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
					<OutlineHistoryList
						spaceId={spaceId}
						rootId={blockId}
						asOf={search.asOf}
						onViewAt={onViewAt}
					/>
				</Tabs.Panel>
			</Tabs>
		</>
	);
}
