import type { ComboboxData } from "@mantine/core";
import { Button, Select, Stack, Text } from "@mantine/core";
import type { NavigateOptions, ToOptions } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

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
	groupedModels,
	navigate,
}: ModelsSectionProps) {
	const { t } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");

	return (
		<Stack>
			<Select
				label={t("defaultModel")}
				data={groupedModels}
				searchable
				value={defaultModel}
			/>
			<Select
				label={t("summaryModel")}
				data={groupedModels}
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
					data={groupedModels}
					searchable
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentExploreModel || null}
					onChange={(v) => setSubagentExploreModel(v ?? "")}
				/>
				<Select
					label={t("subagentPlanModel")}
					data={groupedModels}
					searchable
					clearable
					placeholder={t("subagentModelInherit")}
					value={subagentPlanModel || null}
					onChange={(v) => setSubagentPlanModel(v ?? "")}
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
