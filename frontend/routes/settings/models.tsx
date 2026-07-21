import { Alert, Divider, Stack, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
	const [localAggregations, setLocalAggregations] = useState<ModelAggregation[]>(aggregations);
	const serverAggregationsRef = useRef(aggregations);
	const saveInFlightRef = useRef(false);
	const pendingSaveRef = useRef<ModelAggregation[] | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		serverAggregationsRef.current = aggregations;
		if (!saveInFlightRef.current && pendingSaveRef.current === null) {
			setLocalAggregations(aggregations);
		}
	}, [aggregations]);

	const flushAggregationSave = useCallback(async () => {
		if (saveInFlightRef.current) return;
		const next = pendingSaveRef.current;
		if (!next) return;
		pendingSaveRef.current = null;
		saveInFlightRef.current = true;
		try {
			const data = await api.updateSettings({ agent: { modelAggregations: next } });
			serverAggregationsRef.current = next;
			qc.setQueryData(["settings"], data);
		} catch (err) {
			pendingSaveRef.current = null;
			if (mountedRef.current) {
				setLocalAggregations(serverAggregationsRef.current);
				notifications.show({
					title: t("modelAggregationsSaveError"),
					message: err instanceof Error ? err.message : String(err),
					color: "red",
				});
			}
		} finally {
			saveInFlightRef.current = false;
			if (pendingSaveRef.current) void flushAggregationSave();
		}
	}, [qc, t]);

	const handleAggregationsChange = useCallback(
		(aggs: ModelAggregation[]) => {
			setLocalAggregations(aggs);
			pendingSaveRef.current = aggs;
			void flushAggregationSave();
		},
		[flushAggregationSave],
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
				translationModel={is.translationModel}
				setTranslationModel={is.setTranslationModel}
				subagentExploreModel={is.subagentExploreModel}
				setSubagentExploreModel={is.setSubagentExploreModel}
				subagentPlanModel={is.subagentPlanModel}
				setSubagentPlanModel={is.setSubagentPlanModel}
				subagentAllowedModels={is.subagentAllowedModels}
				setSubagentAllowedModels={is.setSubagentAllowedModels}
				agentDefaultReasoningEffort={is.agentDefaultReasoningEffort}
				setAgentDefaultReasoningEffort={is.setAgentDefaultReasoningEffort}
				groupedModels={groupedModels}
				navigate={navigate}
			/>
			<Divider />
			<ModelAggregationsSection
				aggregations={localAggregations}
				onChange={handleAggregationsChange}
				allModels={visibleModels}
				providerLabels={providerLabels}
				generateId={generateShortId}
			/>
		</Stack>
	);
}
