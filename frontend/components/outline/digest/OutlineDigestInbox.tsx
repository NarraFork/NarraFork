/**
 * The inbox's digest row expanded (汇报, P2 PR 11; owner decision Q4 = A): the latest unread
 * report in its compact form (every section's count, the first few items of each, and every
 * decision made in the person's name, each with undo), links to the other unread reports, the
 * confirmations agents made in the person's name not yet acknowledged (P2 PR 7's list, without those the
 * report already lists; one undone here stays shown as undone), "Open the full report", and "Got
 * it", which marks every unread report and those confirmations read.
 *
 * Reads: the list's first page (heads), one report's detail, the live confirmations (at most 50).
 */
import { Anchor, Badge, Button, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import type { OutlineDigestItem } from "@shared/outline-api";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useMarkOutlineDigestSeen,
	useMarkOutlineReportsSeen,
	useOutlineDigest,
} from "../../../hooks/useOutline";
import { useOutlineReport, useOutlineReportList } from "../../../hooks/useOutlineReports";
import { formatSmartTime } from "../../../lib/format";
import { OpenInOutline } from "../OpenInOutline";
import { OutlineHrefLink } from "../outline-nav";
import { type DigestDayEntry, dayEntries, reportPath } from "./digest-model";
import { DecisionUndo, OutlineDigestView } from "./OutlineDigestView";
import { useDigestDayLabel } from "./report-format";

/** A confirmation an agent made in the person's name that they have not acknowledged yet. */
function LiveConfirmation({
	item,
	onOpen,
	onUndone,
}: {
	item: OutlineDigestItem;
	onOpen?: () => void;
	onUndone: () => void;
}) {
	const { t } = useTranslation("outline");
	return (
		<Paper withBorder p="xs" radius="sm" data-testid={`outline-digest-${item.pendingId}`}>
			<Stack gap={4}>
				<Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
					<Badge size="xs" variant="light" color="orange" tt="none">
						{t("report.kind.confirmation")}
					</Badge>
					<Badge size="xs" variant="outline" color="gray" tt="none">
						{item.label}
					</Badge>
					<Text size="sm" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
						{item.summary || t("digest.changes", { count: item.opCount })}
					</Text>
				</Group>
				<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
					{[
						item.decidedBy.hidden
							? t("digest.confirmedByHidden")
							: t("digest.confirmedBy", {
									title: item.decidedBy.title ?? item.decidedBy.narratorId ?? "?",
								}),
						item.decidedAt ? formatSmartTime(item.decidedAt) : null,
					]
						.filter(Boolean)
						.join(" · ")}
				</Text>
				{item.rootBlockId && (
					<Group>
						<OpenInOutline spaceId={item.spaceId} blockId={item.rootBlockId} onOpen={onOpen} />
					</Group>
				)}
				<DecisionUndo
					commitId={item.commitId}
					spaceId={item.spaceId}
					kind="confirmation"
					stands
					canUndo={item.canRevert}
					onUndone={onUndone}
				/>
			</Stack>
		</Paper>
	);
}

export function OutlineDigestInbox({
	reportIds,
	onOpen,
}: {
	/** The row's unread reports, latest first. */
	reportIds: readonly string[];
	/** A link was followed: the drawer closes. */
	onOpen?: () => void;
}) {
	const { t } = useTranslation("outline");
	const dayLabel = useDigestDayLabel();
	const confirmations = useOutlineDigest();
	const list = useOutlineReportList({ enabled: reportIds.length > 0 });
	const byId = useMemo(
		() => new Map(dayEntries(list.data?.pages).map((entry) => [entry.head.id, entry])),
		[list.data],
	);
	const latestId = reportIds[0] ?? null;
	const latest: DigestDayEntry | null = latestId ? (byId.get(latestId) ?? null) : null;
	// A report older than the list's first page is still read (its head is not at hand).
	const head = latestId
		? latest
			? latest.head
			: list.isSuccess
				? { id: latestId, createdAt: "" }
				: null
		: null;
	const detail = useOutlineReport(head);
	const seen = useMarkOutlineDigestSeen();
	const reportsSeen = useMarkOutlineReportsSeen();

	// One undone here leaves the list (undoing acknowledges it); it stays shown, as undone.
	const [undone, setUndone] = useState<OutlineDigestItem[]>([]);
	const listed = new Set((detail.data?.delegated ?? []).map((d) => d.link.commitId));
	const current = confirmations.data?.items ?? [];
	const live = [
		...current,
		...undone.filter((u) => !current.some((item) => item.pendingId === u.pendingId)),
	].filter((item) => !item.commitId || !listed.has(item.commitId));
	const others = reportIds.slice(1).map((id) => ({ id, entry: byId.get(id) ?? null }));
	const gotIt = () => {
		const pendingIds = (confirmations.data?.items ?? []).map((i) => i.pendingId);
		if (pendingIds.length > 0) seen.mutate(pendingIds);
		// Every unread report, not only those the row names.
		if (reportIds.length > 0) reportsSeen.mutate();
	};
	const loading =
		confirmations.isLoading || (reportIds.length > 0 && (list.isLoading || detail.isLoading));
	if (loading) return <Loader size="xs" />;
	if (reportIds.length === 0 && live.length === 0)
		return (
			<Text size="xs" c="dimmed">
				{t("digest.empty")}
			</Text>
		);
	const fullDay = latest?.key ?? null;
	return (
		<Stack gap="sm" data-testid="outline-digest" style={{ minWidth: 0 }}>
			{latestId && (
				<Stack gap="xs" style={{ minWidth: 0 }}>
					<Group justify="space-between" gap="xs" wrap="wrap">
						<Text size="sm" fw={600}>
							{latest ? t("report.dayOf", { day: dayLabel(latest.key) }) : t("report.title")}
						</Text>
						{detail.data && (
							<Text size="xs" c="dimmed">
								{t("report.items", { count: detail.data.digest.itemCount })}
							</Text>
						)}
					</Group>
					{detail.isError && (
						<Text size="xs" c="red">
							{t("report.loadFailed")}
						</Text>
					)}
					{detail.data && <OutlineDigestView detail={detail.data} compact onOpen={onOpen} />}
				</Stack>
			)}
			{others.length > 0 && (
				<Group gap={6} wrap="wrap" data-testid="outline-report-other-unread">
					<Text size="xs">{t("report.otherUnread", { count: others.length })}</Text>
					{others.map(({ id, entry }) =>
						entry ? (
							<Anchor
								key={id}
								component={OutlineHrefLink}
								path={reportPath({ d: entry.key })}
								size="xs"
								onClick={() => onOpen?.()}
							>
								{dayLabel(entry.key)} ({t("report.items", { count: entry.head.itemCount })})
							</Anchor>
						) : null,
					)}
				</Group>
			)}
			{live.length > 0 && (
				<Stack gap="xs" data-testid="outline-digest-live">
					<Text size="xs" fw={600}>
						{t("report.unacknowledged")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("digest.intro")}
					</Text>
					{live.map((item) => (
						<LiveConfirmation
							key={item.pendingId}
							item={item}
							onOpen={onOpen}
							onUndone={() => setUndone((all) => [...all, item])}
						/>
					))}
				</Stack>
			)}
			<Group gap="xs" wrap="wrap">
				{latestId && (
					<Button
						size="compact-sm"
						variant="light"
						component={OutlineHrefLink}
						path={reportPath({ d: fullDay })}
						onClick={() => onOpen?.()}
						data-testid="outline-report-open-full"
					>
						{t("report.openFull")}
					</Button>
				)}
				<Button
					size="compact-sm"
					variant="default"
					loading={seen.isPending || reportsSeen.isPending}
					onClick={gotIt}
					data-testid="outline-digest-seen"
				>
					{t("report.gotIt")}
				</Button>
			</Group>
		</Stack>
	);
}
