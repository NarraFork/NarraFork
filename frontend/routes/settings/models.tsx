import { Alert, Divider, Stack, Title } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ModelAggregationsSection } from "../../components/settings/ModelAggregationsSection";
import { ModelsSection } from "../../components/settings/ModelsSection";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";
import { useAllModels } from "../../hooks/useModels";
import { api } from "../../lib/api";
import type { ModelAggregation } from "../../lib/constants";

export const Route = createFileRoute("/settings/models")({
	component: SettingsModelsPage,
});

let shortIdCounter = 0;
function generateShortId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id + (shortIdCounter++).toString(36);
}

function SettingsModelsPage() {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();
	const {
		groupedModels,
		visibleModels,
		providerLabels,
		aggregations,
		agentModeUnsupportedProviders,
	} = useAllModels();
	const is = useInstanceSettingsContext();
	const qc = useQueryClient();

	const updateAggregations = useMutation({
		mutationFn: (aggs: ModelAggregation[]) =>
			api.updateSettings({ agent: { modelAggregations: aggs } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
	});

	const handleAggregationsChange = useCallback(
		(aggs: ModelAggregation[]) => {
			updateAggregations.mutate(aggs);
		},
		[updateAggregations],
	);

	return (
		<Stack>
			<Title order={3}>{t("modelsSection")}</Title>
			{agentModeUnsupportedProviders.size > 0 && (
				<Alert color="yellow" variant="light" title={t("providerAgentModeUnsupportedTitle")}>
					{t("providerAgentModeUnsupportedDesc", {
						providers: Array.from(agentModeUnsupportedProviders).join(", "),
					})}
				</Alert>
			)}
			<ModelsSection
				defaultModel={is.defaultModel}
				setDefaultModel={is.setDefaultModel}
				summaryModel={is.summaryModel}
				setSummaryModel={is.setSummaryModel}
				subagentExploreModel={is.subagentExploreModel}
				setSubagentExploreModel={is.setSubagentExploreModel}
				subagentPlanModel={is.subagentPlanModel}
				setSubagentPlanModel={is.setSubagentPlanModel}
				subagentAllowedModels={is.subagentAllowedModels}
				setSubagentAllowedModels={is.setSubagentAllowedModels}
				codexDefaultReasoningEffort={is.codexDefaultReasoningEffort}
				setCodexDefaultReasoningEffort={is.setCodexDefaultReasoningEffort}
				agentDefaultReasoningEffort={is.agentDefaultReasoningEffort}
				setAgentDefaultReasoningEffort={is.setAgentDefaultReasoningEffort}
				groupedModels={groupedModels}
				navigate={navigate}
			/>
			<Divider />
			<ModelAggregationsSection
				aggregations={aggregations}
				onChange={handleAggregationsChange}
				allModels={visibleModels}
				providerLabels={providerLabels}
				generateId={generateShortId}
			/>
		</Stack>
	);
}
