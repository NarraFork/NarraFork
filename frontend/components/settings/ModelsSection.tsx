import type { ComboboxData, ComboboxItemGroup } from "@mantine/core";
import { Button, MultiSelect, Select, Stack, Text } from "@mantine/core";
import type { NavigateOptions, ToOptions } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

const MODEL_SELECT_OPTION_LIMIT = 100;

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

export interface SubagentAllowedModels {
	explore: string[];
	plan: string[];
	general: string[];
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
	agentDefaultReasoningEffort: string;
	setAgentDefaultReasoningEffort: (v: string) => void;
	subagentAllowedModels: SubagentAllowedModels;
	setSubagentAllowedModels: (v: SubagentAllowedModels) => void;
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
	agentDefaultReasoningEffort,
	setAgentDefaultReasoningEffort,
	subagentAllowedModels,
	setSubagentAllowedModels,
	groupedModels,
	navigate,
}: ModelsSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const prefixedModels = useMemo(() => prefixLabels(groupedModels), [groupedModels]);

	// For the default model selector, exclude the "follow default" option to prevent self-reference.
	const prefixedModelsNoDefault = useMemo(
		() =>
			prefixedModels.filter(
				(g) =>
					!(g as ComboboxItemGroup).items?.some?.(
						(i) => (typeof i === "string" ? i : i.value) === "__default__",
					),
			),
		[prefixedModels],
	);

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
		// Don't clear summaryModel when it's not in the available list —
		// the provider may not be loaded yet, or the user hasn't configured credentials.
		// Clearing it causes a validation error on save (empty string).
	}, [
		validValues,
		subagentExploreModel,
		setSubagentExploreModel,
		subagentPlanModel,
		setSubagentPlanModel,
	]);

	return (
		<Stack>
			<Select
				label={t("defaultModel")}
				data={prefixedModelsNoDefault}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
				value={defaultModel}
			/>
			<Select
				label={t("summaryModel")}
				data={prefixedModels}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
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
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentExploreModel || null}
					onChange={(v) => setSubagentExploreModel(v ?? "")}
				/>
				<Select
					label={t("subagentPlanModel")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentPlanModel || null}
					onChange={(v) => setSubagentPlanModel(v ?? "")}
				/>
			</Stack>
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					{t("subagentAllowedModels")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("subagentAllowedModelsDesc")}
				</Text>
				<MultiSelect
					label={t("subagentAllowedModelsExplore")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentAllowedModelsPlaceholder")}
					value={subagentAllowedModels.explore}
					onChange={(v) => setSubagentAllowedModels({ ...subagentAllowedModels, explore: v })}
				/>
				<MultiSelect
					label={t("subagentAllowedModelsPlan")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentAllowedModelsPlaceholder")}
					value={subagentAllowedModels.plan}
					onChange={(v) => setSubagentAllowedModels({ ...subagentAllowedModels, plan: v })}
				/>
				<MultiSelect
					label={t("subagentAllowedModelsGeneral")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentAllowedModelsPlaceholder")}
					value={subagentAllowedModels.general}
					onChange={(v) => setSubagentAllowedModels({ ...subagentAllowedModels, general: v })}
				/>
			</Stack>
			<Select
				label={t("agentDefaultReasoningEffort")}
				description={t("agentDefaultReasoningEffortDesc")}
				data={[
					{ value: "auto", label: tn("reasoning_auto") },
					{ value: "none", label: tn("reasoning_none") },
					{ value: "low", label: tn("reasoning_low") },
					{ value: "medium", label: tn("reasoning_medium") },
					{ value: "high", label: tn("reasoning_high") },
					{ value: "xhigh", label: tn("reasoning_xhigh") },
				]}
				value={agentDefaultReasoningEffort || "auto"}
				onChange={(v) => setAgentDefaultReasoningEffort(v === "auto" ? "" : (v ?? ""))}
			/>
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
			<Button variant="light" onClick={() => navigate({ to: "/settings/providers" })}>
				{t("customModels")} →
			</Button>
		</Stack>
	);
}
