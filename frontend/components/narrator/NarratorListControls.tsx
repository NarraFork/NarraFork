import {
	ActionIcon,
	Button,
	Checkbox,
	Group,
	Indicator,
	Popover,
	SegmentedControl,
	Select,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	IconBox,
	IconEye,
	IconFilter,
	IconPlayerPlay,
	IconSearch,
	IconSortAscending,
	IconSortDescending,
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { NarratorListSearchParams, NarratorListState } from "./narrator-list-utils";

interface NarratorListControlsProps {
	state: NarratorListState;
	onChange: (patch: Partial<NarratorListSearchParams>) => void;
	layout?: "desktop" | "mobile";
	includeExtraFilters?: boolean;
	sortAction?: ReactNode;
}

interface NarratorListExtraFiltersButtonProps {
	state: Pick<
		NarratorListState,
		"hasTerminals" | "hasContainers" | "hasRunningContainers" | "hasViewers"
	>;
	onChange: (patch: Partial<NarratorListSearchParams>) => void;
}

export function NarratorListExtraFiltersButton({
	state,
	onChange,
}: NarratorListExtraFiltersButtonProps) {
	const { t } = useTranslation("narrators");
	const { hasTerminals, hasContainers, hasRunningContainers, hasViewers } = state;
	const activeFilterCount =
		(hasTerminals ? 1 : 0) +
		(hasContainers ? 1 : 0) +
		(hasRunningContainers ? 1 : 0) +
		(hasViewers ? 1 : 0);

	return (
		<Popover width={220} position="bottom-end" shadow="md">
			<Popover.Target>
				<Indicator size={16} label={activeFilterCount} disabled={activeFilterCount === 0}>
					<ActionIcon variant="subtle" size="sm">
						<IconFilter size={16} />
					</ActionIcon>
				</Indicator>
			</Popover.Target>
			<Popover.Dropdown>
				<Stack gap="xs">
					<Text size="xs" fw={500} c="dimmed">
						{t("filterMenuTitle")}
					</Text>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconTerminal2 size={14} />
								{t("filterHasTerminals")}
							</Group>
						}
						checked={hasTerminals}
						onChange={(e) => onChange({ hasTerminals: e.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconBox size={14} />
								{t("filterHasContainers")}
							</Group>
						}
						checked={hasContainers}
						onChange={(e) => onChange({ hasContainers: e.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconPlayerPlay size={14} />
								{t("filterHasRunningContainers")}
							</Group>
						}
						checked={hasRunningContainers}
						onChange={(e) => onChange({ hasRunningContainers: e.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconEye size={14} />
								{t("filterHasViewers")}
							</Group>
						}
						checked={hasViewers}
						onChange={(e) => onChange({ hasViewers: e.currentTarget.checked })}
					/>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}

export function NarratorListControls({
	state,
	onChange,
	layout = "desktop",
	includeExtraFilters = false,
	sortAction,
}: NarratorListControlsProps) {
	const { t } = useTranslation("narrators");
	const { sortBy, sortOrder, filter, localQuery } = state;
	const isMobile = layout === "mobile";
	const sortOptions = useMemo(
		() => [
			{ value: "updatedAt", label: t("sortUpdatedAt") },
			{ value: "createdAt", label: t("sortCreatedAt") },
			{ value: "title", label: t("sortTitle") },
			{ value: "messageCount", label: t("sortMessageCount") },
		],
		[t],
	);
	const toggleSortOrder = () => onChange({ sortOrder: sortOrder === "desc" ? "asc" : "desc" });

	const searchInput = (
		<TextInput
			size="xs"
			w={isMobile ? "100%" : 220}
			placeholder={t("localSearchPlaceholder")}
			value={localQuery}
			onChange={(e) => onChange({ q: e.currentTarget.value || undefined })}
			leftSection={<IconSearch size={14} />}
			rightSection={
				localQuery ? (
					<ActionIcon size="xs" variant="subtle" onClick={() => onChange({ q: undefined })}>
						<IconX size={12} />
					</ActionIcon>
				) : undefined
			}
		/>
	);

	const filterControl = (
		<SegmentedControl
			size="xs"
			fullWidth={isMobile}
			value={filter}
			onChange={(v) => onChange({ filter: v })}
			data={[
				{ value: "all", label: t("filterAll") },
				{ value: "standalone", label: t("filterStandalone") },
				{ value: "chapter", label: t("filterChapter") },
			]}
		/>
	);

	const sortControl = (
		<Group gap="xs" wrap="nowrap" style={isMobile ? { width: "100%" } : undefined}>
			<Select
				size="xs"
				w={isMobile ? undefined : 140}
				style={isMobile ? { flex: 1 } : undefined}
				data={sortOptions}
				value={sortBy}
				onChange={(v) => v && onChange({ sortBy: v })}
				allowDeselect={false}
			/>
			<Tooltip label={sortOrder === "desc" ? t("sortDescending") : t("sortAscending")}>
				<ActionIcon variant="subtle" size="sm" onClick={toggleSortOrder}>
					{sortOrder === "desc" ? (
						<IconSortDescending size={16} />
					) : (
						<IconSortAscending size={16} />
					)}
				</ActionIcon>
			</Tooltip>
			{sortAction}
		</Group>
	);

	if (isMobile) {
		return (
			<Stack gap="xs">
				{searchInput}
				{filterControl}
				{sortControl}
			</Stack>
		);
	}

	return (
		<>
			{searchInput}
			{filterControl}
			{includeExtraFilters && <NarratorListExtraFiltersButton state={state} onChange={onChange} />}
			{sortControl}
		</>
	);
}

export function NarratorListLocalSearchSummary({
	localQuery,
	shown,
	loaded,
}: {
	localQuery: string;
	shown: number;
	loaded: number;
}) {
	const { t } = useTranslation("narrators");
	if (!localQuery.trim() || loaded === 0) return null;
	return (
		<Text size="xs" c="dimmed">
			{t("localSearchSummary", { shown, loaded })}
		</Text>
	);
}

export function NarratorListLoadMoreButton({
	localQuery,
	hasNextPage,
	isFetchingNextPage,
	fetchNextPage,
}: {
	localQuery: string;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	fetchNextPage: () => unknown;
}) {
	const { t } = useTranslation("narrators");
	if (!localQuery.trim() || !hasNextPage) return null;
	return (
		<Group justify="center" py="xs">
			<Button
				size="xs"
				variant="light"
				onClick={() => fetchNextPage()}
				loading={isFetchingNextPage}
			>
				{t("loadMoreToSearch")}
			</Button>
		</Group>
	);
}
