import { getContextComposition } from "@frontend/lib/api/context-composition";
import { formatLocaleNumber } from "@frontend/lib/intl-format";
import {
	Box,
	Button,
	Group,
	Loader,
	Modal,
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
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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

export function ContextCompositionView({
	data,
	onLoadMore,
	loadingMore,
	mode: controlledMode,
	onModeChange,
}: {
	data: ContextComposition;
	onLoadMore?: () => void;
	loadingMore?: boolean;
	mode?: string;
	onModeChange?: (value: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const [localMode, setLocalMode] = useState("category");
	const mode = controlledMode ?? localMode;
	const [selected, setSelected] = useState<string | null>(null);
	let offset = 0;
	const segments = (mode === "category" ? data.totals : data.segments)
		.filter((segment) => segment.chars > 0)
		.map((segment) => {
			const key = `${mode}-${segment.category}-${offset}`;
			offset += segment.chars;
			return { ...segment, key };
		});
	const describe = (category: ContextCategory, chars: number) =>
		`${t(`contextComposition.categories.${category}`)} · ${formatLocaleNumber(chars)} ${t("contextComposition.characters")} · ${contextCharacterPercent(chars, data.totalChars).toFixed(1)}%`;
	const unloadedChars =
		mode === "sequence" && data.nextCursor ? Math.max(0, data.totalChars - offset) : 0;
	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Text size="sm" fw={600}>
					{formatLocaleNumber(data.totalChars)} {t("contextComposition.characters")}
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
				style={{ display: "flex", height: 32, borderRadius: 6, overflow: "hidden" }}
			>
				{segments.map((segment) => {
					const label = describe(segment.category, segment.chars);
					return (
						<Tooltip key={segment.key} label={label} withArrow>
							<Box
								component="button"
								type="button"
								aria-label={label}
								onClick={() => setSelected(label)}
								style={{
									width: `${contextCharacterPercent(segment.chars, data.totalChars)}%`,
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
								width: `${contextCharacterPercent(unloadedChars, data.totalChars)}%`,
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
			{selected && (
				<Text size="xs" role="status">
					{selected}
				</Text>
			)}
			<Group gap="xs">
				{CONTEXT_CATEGORIES.map((category) => {
					const item = data.totals.find((segment) => segment.category === category);
					if (!item || item.chars <= 0) return null;
					const label = describe(category, item.chars);
					return (
						<Button
							key={category}
							variant="light"
							size="compact-xs"
							color={CONTEXT_COLORS[category]}
							onClick={() => setSelected(label)}
						>
							{label}
						</Button>
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

export function ContextCompositionModal({
	opened,
	onClose,
	narratorId,
}: {
	opened: boolean;
	onClose: () => void;
	narratorId: string;
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
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("contextComposition.title")}
			size="xl"
			centered
		>
			<Stack gap="sm">
				<Group justify="flex-end">
					{query.isFetching && <Loader size="xs" aria-label={t("contextComposition.loading")} />}
					<Button
						size="compact-xs"
						variant="subtle"
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
						mode={mode}
						onModeChange={setMode}
						onLoadMore={() => void query.fetchNextPage()}
						loadingMore={query.isFetchingNextPage}
					/>
				)}
			</Stack>
		</Modal>
	);
}
