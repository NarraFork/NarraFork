import type { ComboboxData, ComboboxItemGroup } from "@mantine/core";
import { Button, MultiSelect, Select, Stack, Text } from "@mantine/core";
import type { NavigateOptions, ToOptions } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

/** Prepend "group:" prefix to each item label so the selected value shows the provider. */
function prefixLabels(data: ComboboxData): ComboboxData {
	return (data as ComboboxItemGroup[]).map((g) => ({
		group: g.group,
		items: g.items.map((item) => {
			const it = typeof item === "string" ? { value: item, label: item } : item;
			return { ...it, label: `${g.group}:${it.label}` };
		}),
	}));
}

export interface ModelsSectionProps {
	defaultModel: string;
	setDefaultModel: (v: string) => void;
	summaryModel: string;
	setSummaryModel: (v: string) => void;
	subagentExploreModel: string;
	setSubagentExploreModel: (v: string) => void;
	subagentPlanModel: string;
	setSubagentPlanModel: (v: string) => void;
	codexDefaultReasoningEffort: string;
	setCodexDefaultReasoningEffort: (v: string) => void;
	subagentAllowedModels: string[];
	setSubagentAllowedModels: (v: string[]) => void;
	groupedModels: ComboboxData;
	navigate: (opts: ToOptions & NavigateOptions) => void;
}

export function ModelsSection({
	defaultModel,
	setDefaultModel,
	summaryModel,
	setSummaryModel,
	subagentExploreModel,
	setSubagentExploreModel,
	subagentPlanModel,
	setSubagentPlanModel,
	codexDefaultReasoningEffort,
	setCodexDefaultReasoningEffort,
	subagentAllowedModels,
	setSubagentAllowedModels,
	groupedModels,
	navigate,
}: ModelsSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const prefixedModels = useMemo(() => prefixLabels(groupedModels), [groupedModels]);

	// Collect all valid model values from the grouped data.
	const validValues = useMemo(() => {
		const set = new Set<string>();
		for (const g of groupedModels as ComboboxItemGroup[]) {
			for (const item of g.items) {
				const v = typeof item === "string" ? item : item.value;
				set.add(v);
			}
		}
		return set;
	}, [groupedModels]);

	// When a selected model no longer exists in the available list (e.g. its
	// provider was deleted), Mantine Select shows the placeholder but never
	// fires onChange — so the stale value silently persists.  Reset it here.
	useEffect(() => {
		if (validValues.size === 0) return; // models not loaded yet
		if (subagentExploreModel && !validValues.has(subagentExploreModel)) {
			setSubagentExploreModel("");
		}
		if (subagentPlanModel && !validValues.has(subagentPlanModel)) {
			setSubagentPlanModel("");
		}
		if (summaryModel && !validValues.has(summaryModel)) {
			setSummaryModel("");
		}
	}, [
		validValues,
		subagentExploreModel,
		setSubagentExploreModel,
		subagentPlanModel,
		setSubagentPlanModel,
		summaryModel,
		setSummaryModel,
	]);

	return (
		<Stack>
			<Select
				label={t("defaultModel")}
				data={prefixedModels}
				searchable
				value={defaultModel}
			/>
			<Select
				label={t("summaryModel")}
				data={prefixedModels}
				searchable
				value={summaryModel}
			/>
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					{t("subagentModels")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("subagentModelsDesc")}
				</Text>
				<Select
					label={t("subagentExploreModel")}
					data={prefixedModels}
					searchable
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentExploreModel || null}
					onChange={(v) => setSubagentExploreModel(v ?? "")}
				/>
				<Select
					label={t("subagentPlanModel")}
					data={prefixedModels}
					searchable
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentPlanModel || null}
					onChange={(v) => setSubagentPlanModel(v ?? "")}
				/>
				<MultiSelect
					label={t("subagentAllowedModels")}
					description={t("subagentAllowedModelsDesc")}
					data={prefixedModels}
					searchable
					clearable
					placeholder={t("subagentAllowedModelsPlaceholder")}
					value={subagentAllowedModels}
					onChange={setSubagentAllowedModels}
				/>
			</Stack>
			<Select
				label={t("codexDefaultReasoningEffort")}
				description={t("codexDefaultReasoningEffortDesc")}
				data={[
					{ value: "auto", label: tn("reasoning_auto") },
					{ value: "none", label: tn("reasoning_none") },
					{ value: "low", label: tn("reasoning_low") },
					{ value: "medium", label: tn("reasoning_medium") },
					{ value: "high", label: tn("reasoning_high") },
					{ value: "xhigh", label: tn("reasoning_xhigh") },
				]}
				value={codexDefaultReasoningEffort || "auto"}
				onChange={(v) => setCodexDefaultReasoningEffort(v === "auto" ? "" : (v ?? ""))}
			/>
			<Button variant="light" onClick={() => navigate({ to: "/admin/providers" })}>
				{t("customModels")} →
			</Button>
		</Stack>
	);
}
