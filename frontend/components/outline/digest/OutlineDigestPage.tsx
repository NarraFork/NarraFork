/**
 * The reports page (`/outline/digest`, 汇报, P2 PR 11; design §5.2): browse the person's reports by
 * day, newest first ("today so far" on top), filter by space, and make "today so far" on demand.
 *
 *   - The list is heads only, a page of days at a time (cursor); going past the oldest loaded day,
 *     or opening a day by its address, reads the next page.
 *   - A report's detail is read when it is opened, and opening it marks it read.
 *   - "Make today so far" asks the server (it is made in the background) and reads the list again
 *     every 1.5 s (`OUTLINE_REPORT_POLL_MS`) until the preview's head changes (or a minute passes;
 *     `human_attention_changed` re-reads it too), then opens it.
 *   - What waits for the person now is counted from the inbox list the app has already loaded.
 *
 * The address holds the day (`d`, a date or `today`) and the space (`space`); the host turns
 * `onSelect` into a navigation.
 */
import { Alert, Badge, Button, Group, Loader, Select, Stack, Text, Title } from "@mantine/core";
import { IconChevronLeft, IconChevronRight, IconRefresh } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadedHumanAttentionItems, useHumanAttention } from "../../../hooks/useHumanAttention";
import {
	useMarkOutlineReportRead,
	useOutlineReport,
	useOutlineReportList,
	useRequestOutlineReportNow,
} from "../../../hooks/useOutlineReports";
import { NotificationCenterLazyDrawer } from "../../notifications/NotificationCenterLazyDrawer";
import { DIGEST_TODAY, dayEntries, dayNeighbors, pickDay } from "./digest-model";
import { OutlineDigestView, useDigestSpaceLabel } from "./OutlineDigestView";
import { useDigestDayLabel, useDigestPeriod } from "./report-format";

/** How long the page waits for "today so far" before it says it is not ready yet. */
const AWAIT_MS = 60_000;
const ALL_SPACES = "__all__";

type Notice = "madeRecently" | "queueFull" | "notReadyYet" | "makeFailed";

/** What waits for the person now (design §5.2: counted from the inbox list already loaded). */
function WaitingForYou() {
	const { t } = useTranslation("outline");
	const attention = useHumanAttention();
	const [opened, setOpened] = useState(false);
	const items = loadedHumanAttentionItems(attention.data?.pages);
	const waiting = items.filter(
		(item) => item.kind === "outline_decision" || item.kind === "plan_approval",
	).length;
	if (waiting === 0) return null;
	return (
		<Group gap="xs" wrap="wrap" data-testid="outline-report-waiting">
			<Text size="sm">{t("report.waiting", { count: waiting })}</Text>
			<Button size="compact-sm" variant="subtle" onClick={() => setOpened(true)}>
				{t("report.openInbox")}
			</Button>
			<NotificationCenterLazyDrawer
				opened={opened}
				onClose={() => setOpened(false)}
				initialTab="attention"
			/>
		</Group>
	);
}

export function OutlineDigestPage({
	day,
	space,
	onSelect,
}: {
	/** `YYYY-MM-DD`, or `today`; none: the latest day. */
	day?: string;
	/** Only this space's items. */
	space?: string;
	onSelect: (next: { d?: string; space?: string }) => void;
}) {
	const { t } = useTranslation("outline");
	const dayLabel = useDigestDayLabel();
	const period = useDigestPeriod();
	const spaceLabel = useDigestSpaceLabel();
	const [awaiting, setAwaiting] = useState<{ since: string | null } | null>(null);
	const [notice, setNotice] = useState<Notice | null>(null);
	const list = useOutlineReportList({ poll: awaiting !== null });
	const pages = list.data?.pages;
	const entries = useMemo(() => dayEntries(pages), [pages]);
	const more = !!list.hasNextPage;
	const picked = pickDay(entries, day, more);
	const head = picked.entry?.head ?? null;
	const detail = useOutlineReport(head);
	const markRead = useMarkOutlineReportRead();
	const makeNow = useRequestOutlineReportNow();
	const marked = useRef(new Set<string>());
	const preview = pages?.[0]?.preview ?? null;

	// A day by its address may be on a later page of the list.
	const { fetchNextPage, isFetchingNextPage } = list;
	useEffect(() => {
		if (picked.searching && !isFetchingNextPage) void fetchNextPage();
	}, [picked.searching, isFetchingNextPage, fetchNextPage]);

	// Opening a report marks it read.
	const { mutate: markReadMutate } = markRead;
	useEffect(() => {
		if (!head || head.seenAt || !detail.isSuccess || marked.current.has(head.id)) return;
		marked.current.add(head.id);
		markReadMutate([head.id]);
	}, [head, detail.isSuccess, markReadMutate]);

	// "Today so far" is ready once its head is a new one: open it.
	useEffect(() => {
		if (!awaiting || !preview || preview.createdAt === awaiting.since) return;
		setAwaiting(null);
		onSelect({ d: DIGEST_TODAY, space });
	}, [awaiting, preview, onSelect, space]);
	useEffect(() => {
		if (!awaiting) return;
		const timer = setTimeout(() => {
			setAwaiting(null);
			setNotice("notReadyYet");
		}, AWAIT_MS);
		return () => clearTimeout(timer);
	}, [awaiting]);

	const askNow = () => {
		setNotice(null);
		const since = preview?.createdAt ?? null;
		makeNow.mutate(undefined, {
			onSuccess: (result) => {
				if (result.queued) setAwaiting({ since });
				else if (result.previewId) {
					setNotice("madeRecently");
					onSelect({ d: DIGEST_TODAY, space });
				} else setNotice("queueFull");
			},
			onError: () => setNotice("makeFailed"),
		});
	};

	const go = (d: string | null) => {
		if (d) onSelect({ d, space });
	};
	const neighbors = picked.entry ? dayNeighbors(entries, picked.entry.key, more) : null;
	const goOlder = async () => {
		if (!picked.entry || !neighbors) return;
		if (neighbors.older) return go(neighbors.older);
		if (!neighbors.olderOnNextPage) return;
		const next = await fetchNextPage();
		const loaded = dayEntries(next.data?.pages);
		go(dayNeighbors(loaded, picked.entry.key, false).older);
	};

	const dayOptions = entries.map((entry) => ({
		value: entry.key,
		label: [
			dayLabel(entry.key),
			t("report.items", { count: entry.head.itemCount }),
			entry.head.seenAt ? null : t("report.unread"),
		]
			.filter(Boolean)
			.join(" · "),
	}));
	const spaces = detail.data?.spaces ?? [];
	const spaceOptions = [
		{ value: ALL_SPACES, label: t("report.allSpaces") },
		...spaces.map((s) => ({ value: s.id, label: spaceLabel(s) })),
		...(space && detail.data && !spaces.some((s) => s.id === space)
			? [{ value: space, label: t("report.spaceNotInReport") }]
			: []),
	];

	return (
		<Stack gap="md" style={{ minWidth: 0 }} data-testid="outline-report-page">
			<Group justify="space-between" align="flex-start" gap="sm" wrap="wrap">
				<Stack gap={4} style={{ flex: "1 1 16rem", minWidth: 0 }}>
					<Title order={2}>{t("report.title")}</Title>
					<Text size="sm" c="dimmed">
						{t("report.subtitle")}
					</Text>
				</Stack>
				<Button
					variant="light"
					leftSection={<IconRefresh size={16} />}
					loading={makeNow.isPending || awaiting !== null}
					disabled={list.isLoading}
					onClick={askNow}
					data-testid="outline-report-now"
				>
					{t("report.makeNow")}
				</Button>
			</Group>
			{notice && (
				<Alert
					color={notice === "makeFailed" ? "red" : "gray"}
					variant="light"
					withCloseButton
					onClose={() => setNotice(null)}
					data-testid="outline-report-notice"
					data-notice={notice}
				>
					<Text size="sm">{t(`report.${notice}`)}</Text>
				</Alert>
			)}
			<WaitingForYou />
			{list.isLoading && <Loader size="sm" />}
			{list.isError && (
				<Alert color="red" variant="light">
					{t("report.loadFailed")}
				</Alert>
			)}
			{list.isSuccess && entries.length === 0 && (
				<Text size="sm" c="dimmed" data-testid="outline-report-none">
					{t("report.none")}
				</Text>
			)}
			{entries.length > 0 && (
				<Group gap="xs" wrap="wrap" align="flex-end" data-testid="outline-report-nav">
					<Group gap="xs" wrap="nowrap" style={{ flex: "1 1 20rem", minWidth: 0 }}>
						<Button
							variant="default"
							size="sm"
							px="xs"
							aria-label={t("report.older")}
							title={t("report.older")}
							disabled={!neighbors || (!neighbors.older && !neighbors.olderOnNextPage)}
							loading={isFetchingNextPage}
							onClick={() => void goOlder()}
							data-testid="outline-report-older"
						>
							<IconChevronLeft size={16} />
						</Button>
						<Select
							aria-label={t("report.day")}
							data={dayOptions}
							value={picked.entry?.key ?? null}
							onChange={(value) => go(value)}
							allowDeselect={false}
							comboboxProps={{ withinPortal: true }}
							style={{ flex: 1, minWidth: 0 }}
							data-testid="outline-report-day"
						/>
						<Button
							variant="default"
							size="sm"
							px="xs"
							aria-label={t("report.newer")}
							title={t("report.newer")}
							disabled={!neighbors?.newer}
							onClick={() => go(neighbors?.newer ?? null)}
							data-testid="outline-report-newer"
						>
							<IconChevronRight size={16} />
						</Button>
					</Group>
					<Select
						aria-label={t("report.space")}
						data={spaceOptions}
						value={space ?? ALL_SPACES}
						onChange={(value) =>
							onSelect({
								d: day,
								space: value && value !== ALL_SPACES ? value : undefined,
							})
						}
						allowDeselect={false}
						disabled={!detail.data}
						style={{ flex: "1 1 12rem", minWidth: 0 }}
						data-testid="outline-report-space"
					/>
				</Group>
			)}
			{picked.missing && (
				<Alert color="gray" variant="light" data-testid="outline-report-missing">
					{t("report.dayMissing")}
				</Alert>
			)}
			{picked.searching && <Loader size="sm" />}
			{head && picked.entry && (
				<Stack
					gap="sm"
					style={{ minWidth: 0 }}
					data-testid="outline-report-day-view"
					data-day={picked.entry.key}
				>
					<Stack gap={2}>
						<Group gap="xs" wrap="wrap">
							<Title order={3}>
								{picked.entry.key === DIGEST_TODAY
									? t("report.today")
									: t("report.dayOf", { day: dayLabel(picked.entry.key) })}
							</Title>
							<Badge variant="light" color="gray" tt="none">
								{t("report.items", { count: detail.data?.digest.itemCount ?? head.itemCount })}
							</Badge>
							{!head.seenAt && (
								<Badge
									variant="filled"
									color="indigo"
									tt="none"
									data-testid="outline-report-unread"
								>
									{t("report.unread")}
								</Badge>
							)}
						</Group>
						<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
							{period(head)}
						</Text>
					</Stack>
					{detail.isLoading && (
						<Group gap="xs">
							<Loader size="xs" />
							<Text size="sm">{t("report.loading")}</Text>
						</Group>
					)}
					{detail.isError && (
						<Alert color="red" variant="light">
							{t("report.loadFailed")}
						</Alert>
					)}
					{detail.data && <OutlineDigestView detail={detail.data} spaceId={space ?? null} />}
				</Stack>
			)}
		</Stack>
	);
}
