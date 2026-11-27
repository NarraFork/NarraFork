import { useScheduledTaskTargets } from "@frontend/hooks/useScheduledTasks";
import { Alert, Button, Group, Loader, Select, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Labels come exclusively from currently authorized queries, never from a draft snapshot. */
export function TaskTargetPicker({
	value,
	onChange,
	error,
}: {
	value: string | null;
	onChange: (id: string | null) => void;
	error?: string;
}) {
	const { t } = useTranslation("scheduledTasks");
	const [search, setSearch] = useState("");
	const targets = useScheduledTaskTargets(search);
	const selectedQuery = useScheduledTaskTargets(value ?? "", !!value);
	const items = targets.isSuccess ? targets.data.pages.flatMap((page) => page.items) : [];
	const selected = selectedQuery.isSuccess
		? selectedQuery.data.pages.flatMap((page) => page.items).find((item) => item.id === value)
		: undefined;
	const unique = new Map(items.map((item) => [item.id, item]));
	if (selected) unique.set(selected.id, selected);
	const failed = targets.isError || (!!value && selectedQuery.isError);
	const unavailable = !!value && selectedQuery.isSuccess && !selected && !selectedQuery.hasNextPage;
	if (unavailable && value) unique.delete(value);
	return (
		<Stack gap="xs">
			<TextInput
				label={t("targetSearch")}
				value={search}
				onChange={(event) => setSearch(event.currentTarget.value)}
				maxLength={200}
				rightSection={targets.isFetching ? <Loader size="xs" /> : undefined}
			/>
			<Select
				required
				clearable
				label={t("targetNarrator")}
				placeholder={t("targetSearch")}
				description={t("targetHint")}
				data={(failed ? [] : [...unique.values()]).map((item) => ({
					value: item.id,
					label: `${item.title || t("unknownNarrator")} · ${item.id}`,
				}))}
				value={value && unique.has(value) && !failed ? value : null}
				onChange={(id) => {
					onChange(id);
					setSearch("");
				}}
				filter={({ options }) => options}
				nothingFoundMessage={
					targets.isFetching || targets.debouncing ? t("loading") : t("targetsEmpty")
				}
				rightSection={targets.isFetching ? <Loader size="xs" /> : undefined}
				error={error || (unavailable ? t("targetUnavailable") : undefined)}
			/>
			{value && !selected && (
				<Text size="xs" c="dimmed">
					{value}
				</Text>
			)}
			{failed && (
				<Alert color="red">
					<Group justify="space-between" gap="xs">
						<Text size="sm">{t("targetsLoadFailed")}</Text>
						<Button
							size="compact-xs"
							variant="light"
							onClick={() => {
								void targets.refetch();
								if (value) void selectedQuery.refetch();
							}}
						>
							{t("retry")}
						</Button>
					</Group>
				</Alert>
			)}
			{!failed && value && !selected && selectedQuery.hasNextPage && (
				<Button
					size="xs"
					variant="subtle"
					loading={selectedQuery.isFetchingNextPage}
					onClick={() => void selectedQuery.fetchNextPage()}
				>
					{t("targetFindMore")}
				</Button>
			)}
			{!failed && targets.hasNextPage && (
				<Button
					size="xs"
					variant="subtle"
					loading={targets.isFetchingNextPage}
					onClick={() => void targets.fetchNextPage()}
				>
					{t("loadMore")}
				</Button>
			)}
		</Stack>
	);
}
