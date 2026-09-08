import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	Stack,
	Text,
	ThemeIcon,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { IconClockPause, IconExclamationMark, IconInbox } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadedHumanAttentionItems, useHumanAttention } from "../../hooks/useHumanAttention";
import { api } from "../../lib/api";
import { HumanAttentionInboxDrawer } from "../narrator/GlobalQuestionInbox";

const NEEDS_ATTENTION_QUERY_GC_TIME_MS = 30_000;
const MAX_ITEMS = 5;
const ERROR_MESSAGE_MAX_LENGTH = 60;

// biome-ignore lint/suspicious/noExplicitAny: ApiEntity is loosely typed
type NarratorEntity = any;

interface AttentionItem {
	/** Navigation target: the narrator this row opens. */
	id: string;
	/**
	 * React key. Distinct from `id` because one narrator can contribute SEVERAL rows
	 * (two open questions in one session), and keying those by narrator id would collide
	 * — React would reuse one row's DOM for the other and drop the second silently.
	 */
	key: string;
	title: string;
	subtitle: string;
	/** Question rows only: an agent has STOPPED waiting for this one. */
	awaited?: boolean;
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}…`;
}

export function NeedsAttention() {
	const { t } = useTranslation("dashboard");
	const { t: tn } = useTranslation("narrator");
	const [inboxOpened, setInboxOpened] = useState(false);
	const attention = useHumanAttention();
	const attentionItems = loadedHumanAttentionItems(attention.data?.pages);
	const blocking = attentionItems.some((item) => item.blocking);

	const { data: recentData, isLoading: recentLoading } = useQuery({
		queryKey: ["narrators", "failed-attention"],
		queryFn: () =>
			api.listNarratorsPaginated({
				standalone: "all",
				limit: 50,
				sortBy: "updatedAt",
				sortOrder: "desc",
			}),
		gcTime: NEEDS_ATTENTION_QUERY_GC_TIME_MS,
	});

	const failedItems = useMemo<AttentionItem[]>(() => {
		const failed = (recentData?.items ?? []).filter((n: NarratorEntity) => n.errorMessage);
		return failed.map((n: NarratorEntity) => ({
			id: n.id,
			key: n.id,
			title: n.title ?? n.id,
			subtitle: truncate(String(n.errorMessage), ERROR_MESSAGE_MAX_LENGTH),
		}));
	}, [recentData]);

	const failedCount = failedItems.length;
	const isLoading = recentLoading || attention.isLoading;
	const allClear =
		failedCount === 0 &&
		attentionItems.length === 0 &&
		!attention.hasNextPage &&
		!attention.isError;

	return (
		<Card withBorder>
			<Group justify="space-between" mb="sm">
				<Title order={4}>{t("needsAttention")}</Title>
				{isLoading && <Loader size="sm" />}
			</Group>

			{isLoading ? null : allClear ? (
				<Alert color="green" variant="light">
					{t("allClear")}
				</Alert>
			) : (
				<Stack gap="sm">
					{attention.isError && (
						<Alert color="red">
							<Text size="sm">{tn("humanAttentionLoadError")}</Text>
							<Button
								size="xs"
								variant="light"
								onClick={() => void attention.refetch()}
								loading={attention.isFetching}
							>
								{tn("humanAttentionRetry")}
							</Button>
						</Alert>
					)}
					{(attentionItems.length > 0 || attention.hasNextPage) && (
						<Card withBorder padding="sm">
							<Group gap="sm" mb="xs">
								<ThemeIcon color={blocking ? "yellow" : "blue"} variant="light" size="lg">
									{blocking ? <IconClockPause size={18} /> : <IconInbox size={18} />}
								</ThemeIcon>
								<Text fw={500}>{t("humanAttention")}</Text>
								<Badge size="sm" variant="light">
									{attentionItems.length}
									{attention.hasNextPage ? "+" : ""}
								</Badge>
							</Group>
							<Stack gap={4}>
								{attentionItems.slice(0, MAX_ITEMS).map((item) => (
									<UnstyledButton key={item.id} onClick={() => setInboxOpened(true)}>
										<Group gap="xs">
											<Text size="sm" fw={500}>
												{item.narratorTitle || item.narratorId}
											</Text>
											<Badge size="xs" color={item.blocking ? "yellow" : "gray"}>
												{tn(item.blocking ? "humanAttentionBlocking" : "humanAttentionLater")}
											</Badge>
										</Group>
										<Text size="xs" c="dimmed" lineClamp={2}>
											{item.summary ||
												tn(
													item.source === "question"
														? item.blocking
															? "asyncQuestionAwaitedNotice"
															: "asyncQuestionInboxTitle"
														: `humanAttentionKind.${item.kind}`,
												)}
										</Text>
									</UnstyledButton>
								))}
								<Button size="compact-xs" variant="subtle" onClick={() => setInboxOpened(true)}>
									{t("viewAll")}
								</Button>
							</Stack>
						</Card>
					)}
					{failedCount > 0 && (
						<AttentionSection
							icon={
								<ThemeIcon color="red" variant="light" size="lg">
									<IconExclamationMark size={18} />
								</ThemeIcon>
							}
							title={t("failedNarrators")}
							count={failedCount}
							items={failedItems}
						/>
					)}
				</Stack>
			)}
			<HumanAttentionInboxDrawer opened={inboxOpened} onClose={() => setInboxOpened(false)} />
		</Card>
	);
}

function AttentionSection({
	icon,
	title,
	count,
	items,
}: {
	icon: React.ReactNode;
	title: string;
	count: number;
	items: AttentionItem[];
}) {
	const { t } = useTranslation("dashboard");
	const visibleItems = items.slice(0, MAX_ITEMS);

	return (
		<Card withBorder padding="sm">
			<Group gap="sm" mb="xs">
				{icon}
				<Text fw={500}>{title}</Text>
				<Badge size="sm" variant="light">
					{count}
				</Badge>
			</Group>
			<Stack gap={4}>
				{visibleItems.map((item) => (
					<Text
						key={item.key}
						component={Link}
						to="/narrators/$narratorId"
						// biome-ignore lint/suspicious/noExplicitAny: dynamic route params
						params={{ narratorId: item.id } as any}
						style={{ textDecoration: "none", color: "inherit" }}
						size="sm"
						lineClamp={1}
					>
						<Text span fw={500}>
							{item.title}
						</Text>{" "}
						<Text span size="xs" c="dimmed">
							{item.subtitle}
						</Text>
					</Text>
				))}
				{count > MAX_ITEMS && (
					<Text size="xs" c="dimmed">
						{t("viewAll")}
					</Text>
				)}
			</Stack>
		</Card>
	);
}
