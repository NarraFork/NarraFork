import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
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
				expandReasoning={expandReasoning}
				setExpandReasoning={setExpandReasoning}
				defaultRelaxedPlan={is.defaultRelaxedPlan}
				setDefaultRelaxedPlan={is.setDefaultRelaxedPlan}
				yoloSkipReadOnlyConfirmations={is.yoloSkipReadOnlyConfirmations}
				setYoloSkipReadOnlyConfirmations={is.setYoloSkipReadOnlyConfirmations}
				smartInterruptionCheck={is.smartInterruptionCheck}
				setSmartInterruptionCheck={is.setSmartInterruptionCheck}
				maxTransientRetries={is.maxTransientRetries}
				setMaxTransientRetries={is.setMaxTransientRetries}
				retryBackoffCeilMs={is.retryBackoffCeilMs}
				setRetryBackoffCeilMs={is.setRetryBackoffCeilMs}
				firstTokenTimeoutMs={is.firstTokenTimeoutMs}
				setFirstTokenTimeoutMs={is.setFirstTokenTimeoutMs}
				customRetryRules={is.customRetryRules}
				setCustomRetryRules={is.setCustomRetryRules}
				contextThresholds={is.contextThresholds}
				setContextThresholds={is.setContextThresholds}
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
