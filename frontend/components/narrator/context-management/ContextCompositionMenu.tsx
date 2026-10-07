import { getContextComposition } from "@frontend/lib/api/context-composition";
import { formatCompactNumber } from "@frontend/lib/compact-number";
import {
	Box,
	Button,
	Group,
	Loader,
	Menu,
	SegmentedControl,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	CONTEXT_CATEGORIES,
	type ContextCategory,
	type ContextComposition,
	contextCharacterPercent,
} from "@shared/context-composition";
import type { ContextUsageSnapshot } from "@shared/context-usage";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export const CONTEXT_COLORS: Record<ContextCategory, string> = {
	system: "indigo",
	summary: "grape",
	toolDefinition: "violet",
	user: "blue",
	assistant: "teal",
	toolCall: "orange",
	toolResult: "yellow",
	attachment: "pink",
	other: "gray",
};

export function contextTokenShare(
	chars: number,
	totalChars: number,
	totalTokens?: number | null,
): number | null {
	if (
		totalTokens == null ||
		!Number.isFinite(totalTokens) ||
		totalTokens < 0 ||
		!Number.isFinite(totalChars) ||
		totalChars <= 0 ||
		!Number.isFinite(chars) ||
		chars < 0
	)
		return null;
	return (totalTokens * contextCharacterPercent(chars, totalChars)) / 100;
}

export function formatContextTokens(tokens?: number | null): string {
	return tokens != null && Number.isFinite(tokens) && tokens >= 0
		? formatCompactNumber(tokens).compact
		: "—";
}

export function ContextCompositionView({
	data,
	totalTokens,
	snapshot,
	onLoadMore,
	loadingMore,
	mode: controlledMode,
	onModeChange,
}: {
	data: ContextComposition;
	totalTokens?: number | null;
	snapshot?: ContextUsageSnapshot | null;
	onLoadMore?: () => void;
	loadingMore?: boolean;
	mode?: string;
	onModeChange?: (value: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const [localMode, setLocalMode] = useState("category");
	const mode = controlledMode ?? localMode;
	const [selected, setSelected] = useState<{ category: ContextCategory; chars: number } | null>(
		null,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: selection belongs to this composition generation
	useEffect(() => setSelected(null), [data.generation]);
	let offset = 0;
	const segments = (mode === "category" ? data.totals : data.segments)
		.filter((segment) => segment.chars > 0)
		.map((segment) => {
			const key = `${mode}-${segment.category}-${offset}`;
			offset += segment.chars;
			return { ...segment, key };
		});
	// The API pins classification to a request. A matching WS snapshot carries
	// newer occupancy; another request must never replace the API calibration.
	const validTokens = (tokens?: number | null): tokens is number =>
		tokens != null && Number.isFinite(tokens) && tokens >= 0;
	const matches = (usage?: ContextUsageSnapshot | null) =>
		usage != null &&
		validTokens(usage.occupiedTokens) &&
		data.generation != null &&
		usage.composition?.generation === data.generation &&
		usage.composition.totalChars === data.totalChars &&
		usage.inputCharacters != null &&
		Number.isFinite(usage.inputCharacters.totalChars) &&
		usage.inputCharacters.totalChars > 0 &&
		usage.inputCharacters.totalChars >= data.totalChars;
	const matchedUsage =
		snapshot?.requestId === data.usage?.requestId && matches(snapshot)
			? snapshot
			: matches(data.usage)
				? data.usage
				: null;
	const occupiedTokens = matchedUsage
		? matchedUsage.occupiedTokens
		: [data.usage?.occupiedTokens, snapshot?.occupiedTokens, totalTokens].find(validTokens);
	const calibrated = matchedUsage != null;
	const totalChars = matchedUsage?.inputCharacters?.totalChars ?? data.totalChars;
	const hasEstimate = contextTokenShare(1, totalChars, occupiedTokens) != null;
	const estimateHint = t(
		calibrated ? "contextComposition.calibratedHint" : "contextComposition.historyEstimateHint",
	);
	const describe = (category: ContextCategory, chars: number) => {
		const tokens = contextTokenShare(chars, totalChars, occupiedTokens);
		return `${t(`contextComposition.categories.${category}`)} · ${tokens == null ? "—" : `≈${formatContextTokens(tokens)}`} · ${contextCharacterPercent(chars, totalChars).toFixed(1)}%`;
	};
	const tooltip = (label: string) => (hasEstimate ? `${label} · ${estimateHint}` : label);
	const unloadedChars =
		mode === "sequence" && data.nextCursor ? Math.max(0, data.totalChars - offset) : 0;
	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Text size="sm" fw={600} data-testid="context-composition-total">
					{occupiedTokens != null && Number.isFinite(occupiedTokens) && occupiedTokens >= 0
						? "~"
						: ""}
					{formatContextTokens(occupiedTokens)}
				</Text>
				<SegmentedControl
					value={mode}
					onChange={(value) => {
						setLocalMode(value);
						onModeChange?.(value);
						setSelected(null);
					}}
					aria-label={t("contextComposition.order")}
					data={[
						{ value: "category", label: t("contextComposition.byCategory") },
						{ value: "sequence", label: t("contextComposition.bySequence") },
					]}
				/>
			</Group>
			<Box
				data-testid="context-composition-bar"
				aria-label={t("contextComposition.title")}
				style={{
					display: "flex",
					height: 32,
					borderRadius: 6,
					overflow: "hidden",
					background: "var(--mantine-color-default-hover)",
				}}
			>
				{segments.map((segment) => {
					const label = describe(segment.category, segment.chars);
					return (
						<Tooltip key={segment.key} label={tooltip(label)} withArrow>
							<Box
								component="button"
								type="button"
								aria-label={label}
								onClick={() => setSelected({ category: segment.category, chars: segment.chars })}
								style={{
									width: `${contextCharacterPercent(segment.chars, totalChars)}%`,
									flexShrink: 0,
									height: "100%",
									border: 0,
									padding: 0,
									cursor: "pointer",
									background: `var(--mantine-color-${CONTEXT_COLORS[segment.category]}-6)`,
								}}
							/>
						</Tooltip>
					);
				})}
				{unloadedChars > 0 && (
					<Tooltip label={t("contextComposition.loadMore")}>
						<Box
							component="button"
							type="button"
							data-testid="context-composition-more"
							aria-label={t("contextComposition.loadMore")}
							disabled={loadingMore}
							onClick={onLoadMore}
							style={{
								width: `${contextCharacterPercent(unloadedChars, totalChars)}%`,
								border: 0,
								padding: 0,
								cursor: "pointer",
								background: "var(--mantine-color-default-hover)",
								color: "var(--mantine-color-text)",
							}}
						>
							…
						</Box>
					</Tooltip>
				)}
			</Box>
			{!calibrated && hasEstimate && segments.length > 0 && (
				<Text size="xs" c="dimmed" data-testid="context-composition-estimate-hint">
					{estimateHint}
				</Text>
			)}
			{selected && (
				<Text size="xs" role="status">
					{tooltip(describe(selected.category, selected.chars))}
				</Text>
			)}
			<Group gap="xs">
				{CONTEXT_CATEGORIES.map((category) => {
					const item = data.totals.find((segment) => segment.category === category);
					if (!item || item.chars <= 0) return null;
					const label = describe(category, item.chars);
					return (
						<Tooltip key={category} label={tooltip(label)} withArrow>
							<Button
								variant="light"
								size="compact-xs"
								color={CONTEXT_COLORS[category]}
								onClick={() => setSelected({ category, chars: item.chars })}
							>
								{label}
							</Button>
						</Tooltip>
					);
				})}
			</Group>
			{mode === "sequence" && data.nextCursor && (
				<Button variant="subtle" size="xs" loading={loadingMore} onClick={onLoadMore}>
					{t("contextComposition.loadMore")}
				</Button>
			)}
		</Stack>
	);
}

export function ContextCompositionPanel({
	opened,
	narratorId,
	totalTokens,
	snapshot,
}: {
	opened: boolean;
	narratorId: string;
	totalTokens?: number | null;
	snapshot?: ContextUsageSnapshot | null;
}) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const [mode, setMode] = useState("category");
	const queryKey = ["contextComposition", narratorId];
	const query = useInfiniteQuery({
		queryKey,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ signal, pageParam }) => getContextComposition(narratorId, signal, pageParam),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: opened,
		staleTime: 0,
		retry: false,
		refetchInterval: (state) => (state.state.data?.pages[0]?.pending ? 300 : false),
	});
	const pages = query.data?.pages;
	const first = pages?.[0];
	const mixedGeneration = Boolean(
		first && pages?.some((page) => page.generation !== first.generation),
	);
	useEffect(() => {
		if (mixedGeneration)
			void qc.resetQueries({ queryKey: ["contextComposition", narratorId], exact: true });
	}, [mixedGeneration, qc, narratorId]);
	const data =
		first && !mixedGeneration
			? {
					...first,
					segments: pages?.flatMap((page) => page.segments) ?? [],
					nextCursor: pages?.at(-1)?.nextCursor ?? null,
				}
			: undefined;
	return (
		<Stack gap="sm" data-testid="context-composition-panel">
			<Group justify="space-between">
				<Text size="sm" fw={600}>
					{t("contextComposition.title")}
				</Text>
				{query.isFetching && <Loader size="xs" aria-label={t("contextComposition.loading")} />}
				<Button
					size="compact-xs"
					variant="subtle"
					data-testid="context-composition-refresh"
					disabled={query.isFetching}
					onClick={() => void qc.resetQueries({ queryKey, exact: true })}
				>
					{t("contextComposition.refresh")}
				</Button>
			</Group>
			{query.isError && (
				<Group gap="xs">
					<Text size="sm" c="red">
						{t("contextComposition.error")}
					</Text>
					<Button size="compact-xs" onClick={() => void query.refetch()}>
						{t("contextComposition.retry")}
					</Button>
				</Group>
			)}
			{data && (
				<ContextCompositionView
					data={data}
					totalTokens={totalTokens}
					snapshot={snapshot}
					mode={mode}
					onModeChange={setMode}
					onLoadMore={() => void query.fetchNextPage()}
					loadingMore={query.isFetchingNextPage}
				/>
			)}
		</Stack>
	);
}

export function ContextCompositionMenu({
	narratorId,
	totalTokens,
	snapshot,
	target,
	children,
}: {
	narratorId: string;
	totalTokens?: number | null;
	snapshot?: ContextUsageSnapshot | null;
	target: ReactNode;
	children?: ReactNode;
}) {
	const [opened, setOpened] = useState(false);
	return (
		<Menu position="top-start" width={420} opened={opened} onChange={setOpened}>
			<Menu.Target>{target}</Menu.Target>
			<Menu.Dropdown
				data-testid="context-composition-menu"
				style={{
					maxWidth: "calc(100vw - 16px)",
					maxHeight: "calc(100dvh - 24px)",
					overflowY: "auto",
				}}
			>
				{opened && (
					<Box p="xs">
						<ContextCompositionPanel
							opened
							narratorId={narratorId}
							totalTokens={totalTokens}
							snapshot={snapshot}
						/>
					</Box>
				)}
				<Menu.Divider />
				{children}
			</Menu.Dropdown>
		</Menu>
	);
}
