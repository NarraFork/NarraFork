import { Stack, Title } from "@mantine/core";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AgentSection } from "../../components/settings/AgentSection";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";
import { useLocalPref } from "../../hooks/useLocalPref";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";

export const Route = createFileRoute("/settings/agent")({
	component: SettingsAgentPage,
});

function SettingsAgentPage() {
	const { t } = useTranslation("settings");
	const is = useInstanceSettingsContext();
	const { data: userPrefs } = useUserPreferences();
	const updateUserPref = useUpdateUserPreferences();
	const [expandReasoning, setExpandReasoning] = useLocalPref("narrafork_expand_reasoning");
	const hash = useRouterState({ select: (s) => s.location.hash });

	useEffect(() => {
		if (hash !== "request-dump-enabled") return;
		requestAnimationFrame(() => {
			document.getElementById("request-dump-enabled")?.scrollIntoView({
				behavior: "smooth",
				block: "center",
			});
		});
	}, [hash]);

	return (
		<Stack>
			<Title order={3}>{t("agentSection")}</Title>
			<AgentSection
				permissionMode={is.permissionMode}
				setPermissionMode={is.setPermissionMode}
				maxTurns={is.maxTurns}
				setMaxTurns={is.setMaxTurns}
				legacyEncoding={is.legacyEncoding}
				setLegacyEncoding={is.setLegacyEncoding}
				freshShellEnv={is.freshShellEnv}
				setFreshShellEnv={is.setFreshShellEnv}
				translateReasoning={is.translateReasoning}
				setTranslateReasoning={is.setTranslateReasoning}
				requestDumpEnabled={is.requestDumpEnabled}
				setRequestDumpEnabled={is.setRequestDumpEnabled}
				requestDumpErrorsOnly={is.requestDumpErrorsOnly}
				setRequestDumpErrorsOnly={is.setRequestDumpErrorsOnly}
				expandReasoning={expandReasoning}
				setExpandReasoning={setExpandReasoning}
				defaultStartInPlanMode={is.defaultStartInPlanMode}
				setDefaultStartInPlanMode={is.setDefaultStartInPlanMode}
				defaultRelaxedPlan={is.defaultRelaxedPlan}
				setDefaultRelaxedPlan={is.setDefaultRelaxedPlan}
				planReflectionAutoApprove={is.planReflectionAutoApprove}
				setPlanReflectionAutoApprove={is.setPlanReflectionAutoApprove}
				dangerReflectionEnabled={is.dangerReflectionEnabled}
				setDangerReflectionEnabled={is.setDangerReflectionEnabled}
				dangerSkipReadOnlyConfirmations={is.dangerSkipReadOnlyConfirmations}
				setDangerSkipReadOnlyConfirmations={is.setDangerSkipReadOnlyConfirmations}
				maxTransientRetries={is.maxTransientRetries}
				setMaxTransientRetries={is.setMaxTransientRetries}
				silentToolCallThreshold={is.silentToolCallThreshold}
				setSilentToolCallThreshold={is.setSilentToolCallThreshold}
				retryBackoffCeilMs={is.retryBackoffCeilMs}
				setRetryBackoffCeilMs={is.setRetryBackoffCeilMs}
				firstTokenTimeoutMs={is.firstTokenTimeoutMs}
				setFirstTokenTimeoutMs={is.setFirstTokenTimeoutMs}
				customRetryRules={is.customRetryRules}
				setCustomRetryRules={is.setCustomRetryRules}
				contextThresholds={is.contextThresholds}
				setContextThresholds={is.setContextThresholds}
				autoCompactKeepPairs={is.autoCompactKeepPairs}
				setAutoCompactKeepPairs={is.setAutoCompactKeepPairs}
				autoCompactPruneThreshold={is.autoCompactPruneThreshold}
				setAutoCompactPruneThreshold={is.setAutoCompactPruneThreshold}
				globalWhitelistDirs={is.globalWhitelistDirs}
				setGlobalWhitelistDirs={is.setGlobalWhitelistDirs}
				globalBlacklistDirs={is.globalBlacklistDirs}
				setGlobalBlacklistDirs={is.setGlobalBlacklistDirs}
				globalCommandWhitelist={is.globalCommandWhitelist}
				setGlobalCommandWhitelist={is.setGlobalCommandWhitelist}
				globalCommandBlacklist={is.globalCommandBlacklist}
				setGlobalCommandBlacklist={is.setGlobalCommandBlacklist}
				webFetchProxyMode={is.webFetchProxyMode}
				setWebFetchProxyMode={is.setWebFetchProxyMode}
				webFetchProxyUrl={is.webFetchProxyUrl}
				setWebFetchProxyUrl={is.setWebFetchProxyUrl}
				userPrefs={userPrefs}
				updateUserPref={updateUserPref}
			/>
		</Stack>
	);
}
