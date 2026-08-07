import type { ComboboxData, ComboboxItemGroup } from "@mantine/core";
import { Button, MultiSelect, Select, Stack, Text } from "@mantine/core";
import type { NavigateOptions, ToOptions } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FOLLOW_SUMMARY_MODEL } from "../../lib/constants";
import { CmdListEditor } from "../common/CmdListEditor";

// Only loaded when the user opens the migration dialog from this section.
const BrokenModelMigrationModal = lazy(() =>
	import("./BrokenModelMigrationModal").then((m) => ({
		default: m.BrokenModelMigrationModal,
	})),
);

const MODEL_SELECT_OPTION_LIMIT = 100;

type ModelComboboxItem = string | { value: string; label: string };
type ModelComboboxItemGroup = ComboboxItemGroup<ModelComboboxItem, string>;

/** Prepend "group:" prefix to each item label so the selected value shows the provider. */
function prefixLabels(data: ComboboxData): ComboboxData {
	return (data as ModelComboboxItemGroup[]).map((g) => ({
		group: g.group,
		items: g.items.map((item) => {
			const it = typeof item === "string" ? { value: item, label: item } : item;
			return { ...it, label: `${g.group}:${it.label}` };
		}),
	}));
}

/**
 * Filter out option groups that contain any of the given sentinel values.
 * Each sentinel ("__default__", "__summary__") lives in its own group.
 */
function filterSentinelGroups(data: ComboboxData, sentinels: string[]): ComboboxData {
	return (data as ModelComboboxItemGroup[]).filter(
		(g) => !g.items?.some?.((i) => sentinels.includes(typeof i === "string" ? i : i.value)),
	);
}

export interface SubagentAllowedModels {
	explore: string[];
	plan: string[];
	general: string[];
	search?: string[];
	review?: string[];
}

export interface ModelsSectionProps {
	defaultModel: string;
	setDefaultModel: (v: string) => void;
	summaryModel: string;
	setSummaryModel: (v: string) => void;
	translationModel: string;
	setTranslationModel: (v: string) => void;
	subagentExploreModel: string;
	setSubagentExploreModel: (v: string) => void;
	subagentPlanModel: string;
	setSubagentPlanModel: (v: string) => void;
	subagentSearchModel: string;
	setSubagentSearchModel: (v: string) => void;
	subagentReviewModel: string;
	setSubagentReviewModel: (v: string) => void;
	agentDefaultReasoningEffort: string;
	setAgentDefaultReasoningEffort: (v: string) => void;
	reasoningEffortBlocklist: Array<{ pattern: string; enabled?: boolean }>;
	setReasoningEffortBlocklist: (v: Array<{ pattern: string; enabled?: boolean }>) => void;
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
	translationModel,
	setTranslationModel,
	subagentExploreModel,
	setSubagentExploreModel,
	subagentPlanModel,
	setSubagentPlanModel,
	subagentSearchModel,
	setSubagentSearchModel,
	subagentReviewModel,
	setSubagentReviewModel,
	agentDefaultReasoningEffort,
	setAgentDefaultReasoningEffort,
	reasoningEffortBlocklist,
	setReasoningEffortBlocklist,
	subagentAllowedModels,
	setSubagentAllowedModels,
	groupedModels,
	navigate,
}: ModelsSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const [migrationOpened, setMigrationOpened] = useState(false);
	const prefixedModels = useMemo(() => prefixLabels(groupedModels), [groupedModels]);

	// Default model selector: exclude "follow default" (self-reference) and
	// "follow summary" (would be circular, since summary follows default).
	const prefixedModelsNoDefault = useMemo(
		() => filterSentinelGroups(prefixedModels, ["__default__", "__summary__"]),
		[prefixedModels],
	);

	// Summary model selector: exclude "follow summary" (self-reference). Keeping
	// "follow default" is fine — summary following default resolves correctly.
	const prefixedModelsNoSummary = useMemo(
		() => filterSentinelGroups(prefixedModels, ["__summary__"]),
		[prefixedModels],
	);

	// Collect all valid model values from the grouped data.
	const validValues = useMemo(() => {
		const set = new Set<string>();
		for (const g of groupedModels as ModelComboboxItemGroup[]) {
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
		if (subagentSearchModel && !validValues.has(subagentSearchModel)) {
			setSubagentSearchModel("");
		}
		if (subagentReviewModel && !validValues.has(subagentReviewModel)) {
			setSubagentReviewModel("");
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
		subagentSearchModel,
		setSubagentSearchModel,
		subagentReviewModel,
		setSubagentReviewModel,
	]);

	return (
		<Stack>
			<Select
				label={t("defaultModel")}
				data={prefixedModelsNoDefault}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
				value={defaultModel}
				onChange={(v) => {
					// Guard against a null change (controlled-value mismatch): never
					// write a fabricated fallback model into the dirty state.
					if (v) setDefaultModel(v);
				}}
			/>
			<Select
				label={t("summaryModel")}
				data={prefixedModelsNoSummary}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
				value={summaryModel}
				onChange={(v) => {
					// Guard against a null change: persisting a hardcoded fallback
					if (v) setSummaryModel(v);
				}}
			/>
			<Select
				label={t("translationModel")}
				description={t("translationModelDesc")}
				data={prefixedModels}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
				value={translationModel}
				onChange={(v) => setTranslationModel(v ?? FOLLOW_SUMMARY_MODEL)}
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
				<Select
					label={t("subagentSearchModel")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentSearchModel || null}
					onChange={(v) => setSubagentSearchModel(v ?? "")}
				/>
				<Select
					label={t("subagentReviewModel")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentReviewModel || null}
					onChange={(v) => setSubagentReviewModel(v ?? "")}
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
				<MultiSelect
					label={t("subagentAllowedModelsSearch")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentAllowedModelsPlaceholder")}
					value={subagentAllowedModels.search ?? []}
					onChange={(v) => setSubagentAllowedModels({ ...subagentAllowedModels, search: v })}
				/>
				<MultiSelect
					label={t("subagentAllowedModelsReview")}
					data={prefixedModels}
					searchable
					limit={MODEL_SELECT_OPTION_LIMIT}
					clearable
					placeholder={t("subagentAllowedModelsPlaceholder")}
					value={subagentAllowedModels.review ?? []}
					onChange={(v) => setSubagentAllowedModels({ ...subagentAllowedModels, review: v })}
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
					{ value: "max", label: tn("reasoning_max") },
				]}
				value={agentDefaultReasoningEffort || "auto"}
				onChange={(v) => setAgentDefaultReasoningEffort(v === "auto" ? "" : (v ?? ""))}
			/>
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					{t("reasoningEffortBlocklist")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("reasoningEffortBlocklistDesc")}
				</Text>
				<CmdListEditor
					commands={reasoningEffortBlocklist}
					onChange={setReasoningEffortBlocklist}
					mode="whitelist"
					labels={{
						empty: t("reasoningEffortBlocklistEmpty"),
						add: t("reasoningEffortBlocklistAdd"),
						placeholder: t("reasoningEffortBlocklistPlaceholder"),
					}}
				/>
			</Stack>
			<Button variant="light" onClick={() => navigate({ to: "/settings/providers" })}>
				{t("customModels")} →
			</Button>
			<Stack gap={4}>
				<Text size="xs" c="dimmed">
					{t("brokenModelMigrationEntryDesc")}
				</Text>
				<Button variant="light" onClick={() => setMigrationOpened(true)}>
					{t("brokenModelMigrationEntry")}
				</Button>
			</Stack>
			{migrationOpened && (
				<Suspense fallback={null}>
					<BrokenModelMigrationModal
						opened={migrationOpened}
						onClose={() => setMigrationOpened(false)}
					/>
				</Suspense>
			)}
		</Stack>
	);
}
