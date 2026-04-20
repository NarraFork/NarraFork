import { Stack, Title } from "@mantine/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ModelsSection } from "../../components/settings/ModelsSection";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";
import { useAllModels } from "../../hooks/useModels";

export const Route = createFileRoute("/settings/models")({
	component: SettingsModelsPage,
});

function SettingsModelsPage() {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();
	const { groupedModels } = useAllModels();
	const is = useInstanceSettingsContext();

	return (
		<Stack>
			<Title order={3}>{t("modelsSection")}</Title>
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
		</Stack>
	);
}
