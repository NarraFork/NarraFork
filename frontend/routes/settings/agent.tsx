import { Card, Divider, Stack, Text, Title } from "@mantine/core";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AgentSection } from "../../components/settings/AgentSection";
import { TraitLayerEditor } from "../../components/settings/TraitLayerEditor";
import { useCurrentUser } from "../../hooks/useAuth";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";

export const Route = createFileRoute("/settings/agent")({
	component: SettingsAgentPage,
});

function SettingsAgentPage() {
	const { t } = useTranslation("settings");
	const is = useInstanceSettingsContext();
	const { data: userPrefs } = useUserPreferences();
	const { data: currentUser } = useCurrentUser();
	const updateUserPref = useUpdateUserPreferences();
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
				isAdmin={currentUser?.role === "admin"}
				permissionRuleAutoApprove={is.permissionRuleAutoApprove}
				setPermissionRuleAutoApprove={is.setPermissionRuleAutoApprove}
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
				defaultNarratorVisibility={is.defaultNarratorVisibility}
				setDefaultNarratorVisibility={is.setDefaultNarratorVisibility}
				defaultNarratorWriteAudience={is.defaultNarratorWriteAudience}
				setDefaultNarratorWriteAudience={is.setDefaultNarratorWriteAudience}
				defaultStartInPlanMode={is.defaultStartInPlanMode}
				setDefaultStartInPlanMode={is.setDefaultStartInPlanMode}
				defaultRelaxedPlan={is.defaultRelaxedPlan}
				setDefaultRelaxedPlan={is.setDefaultRelaxedPlan}
				planModeAllowInlinePlan={is.planModeAllowInlinePlan}
				setPlanModeAllowInlinePlan={is.setPlanModeAllowInlinePlan}
				planReflectionAutoApprove={is.planReflectionAutoApprove}
				setPlanReflectionAutoApprove={is.setPlanReflectionAutoApprove}
				planReflectionAllowAutoCompact={is.planReflectionAllowAutoCompact}
				setPlanReflectionAllowAutoCompact={is.setPlanReflectionAllowAutoCompact}
				questionReflectionEnabled={is.questionReflectionEnabled}
				setQuestionReflectionEnabled={is.setQuestionReflectionEnabled}
				questionReflectionTimeoutMs={is.questionReflectionTimeoutMs}
				setQuestionReflectionTimeoutMs={is.setQuestionReflectionTimeoutMs}
				dangerReflectionLevel={is.dangerReflectionLevel}
				setDangerReflectionLevel={is.setDangerReflectionLevel}
				dangerReflectionEnabled={is.dangerReflectionEnabled}
				setDangerReflectionEnabled={is.setDangerReflectionEnabled}
				dangerSkipReadOnlyConfirmations={is.dangerSkipReadOnlyConfirmations}
				setDangerSkipReadOnlyConfirmations={is.setDangerSkipReadOnlyConfirmations}
				autoContinuationMode={is.autoContinuationMode}
				setAutoContinuationMode={is.setAutoContinuationMode}
				maxTransientRetries={is.maxTransientRetries}
				setMaxTransientRetries={is.setMaxTransientRetries}
				maxToolCallsPerResponse={is.maxToolCallsPerResponse}
				setMaxToolCallsPerResponse={is.setMaxToolCallsPerResponse}
				silentToolCallThreshold={is.silentToolCallThreshold}
				setSilentToolCallThreshold={is.setSilentToolCallThreshold}
				pipelineUnusedToolCallThreshold={is.pipelineUnusedToolCallThreshold}
				setPipelineUnusedToolCallThreshold={is.setPipelineUnusedToolCallThreshold}
				behaviorFenceInterval={is.behaviorFenceInterval}
				setBehaviorFenceInterval={is.setBehaviorFenceInterval}
				tasksReminderInterval={is.tasksReminderInterval}
				setTasksReminderInterval={is.setTasksReminderInterval}
				behaviorFenceAttachTasks={is.behaviorFenceAttachTasks}
				setBehaviorFenceAttachTasks={is.setBehaviorFenceAttachTasks}
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
				queueDuringCompaction={is.queueDuringCompaction}
				setQueueDuringCompaction={is.setQueueDuringCompaction}
				contextPreflightEnabled={is.contextPreflightEnabled}
				setContextPreflightEnabled={is.setContextPreflightEnabled}
				contextCalibrationEnabled={is.contextCalibrationEnabled}
				setContextCalibrationEnabled={is.setContextCalibrationEnabled}
				globalWhitelistDirs={is.globalWhitelistDirs}
				setGlobalWhitelistDirs={is.setGlobalWhitelistDirs}
				globalBlacklistDirs={is.globalBlacklistDirs}
				setGlobalBlacklistDirs={is.setGlobalBlacklistDirs}
				globalCommandWhitelist={is.globalCommandWhitelist}
				setGlobalCommandWhitelist={is.setGlobalCommandWhitelist}
				globalCommandBlacklist={is.globalCommandBlacklist}
				setGlobalCommandBlacklist={is.setGlobalCommandBlacklist}
				userPrefs={userPrefs}
				updateUserPref={updateUserPref}
			/>
			{currentUser?.id ? (
				<>
					<Divider />
					<Stack gap="xs">
						<Title order={4}>{t("traitLayerUserTitle")}</Title>
						<Text size="sm" c="dimmed">
							{t("traitLayerUserDesc")}
						</Text>
						<Card withBorder padding="md">
							<TraitLayerEditor layer="user" ownerId={currentUser.id} />
						</Card>
					</Stack>
				</>
			) : null}
		</Stack>
	);
}
