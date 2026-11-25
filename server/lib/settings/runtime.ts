import { SETTINGS_RUNTIME_MAX_BYTES } from "@shared/model-runtime";
import type { RuntimeSettings } from "@shared/settings-runtime";
import { updateSettingsKey } from "@shared/update-settings";
import { ValidationError } from "../errors";
import { getSettingsRevision, type NarraForkSettings } from "./index";
import { runtimeModelReadiness } from "./runtime-readiness";

/** Source-level whitelist. Do not spread agent, providers, prompts or the settings response. */
export function buildRuntimeSettings(source: NarraForkSettings, admin = false): RuntimeSettings {
	const agent = source.agent;
	if (agent.defaultModel.length > 1024 || agent.summaryModel.length > 1024)
		throw new ValidationError("Model identifier exceeds runtime settings budget");
	const response: RuntimeSettings = {
		revision: getSettingsRevision(),
		agent: {
			defaultModel: agent.defaultModel,
			summaryModel: agent.summaryModel,
			promptOptimizeContextMaxMessages: agent.promptOptimizeContextMaxMessages,
			defaultPermissionMode: agent.defaultPermissionMode,
			defaultStartInPlanMode: agent.defaultStartInPlanMode,
			defaultReasoningEffort: agent.defaultReasoningEffort,
			dangerReflectionLevel: agent.dangerReflectionLevel,
			autoContinuationMode: agent.autoContinuationMode,
			dangerReflectionEnabled: agent.dangerReflectionEnabled,
			planReflectionAutoApprove: agent.planReflectionAutoApprove,
			planReflectionAllowAutoCompact: agent.planReflectionAllowAutoCompact,
			questionReflectionEnabled: agent.questionReflectionEnabled,
			questionReflectionTimeoutMs: agent.questionReflectionTimeoutMs,
			permissionRuleAutoApprove: agent.permissionRuleAutoApprove,
			dangerSkipReadOnlyConfirmations: agent.dangerSkipReadOnlyConfirmations,
			contextThresholds: agent.contextThresholds && {
				standard: { compactStart: agent.contextThresholds.standard.compactStart },
				large: { compactStart: agent.contextThresholds.large.compactStart },
			},
			autoCompactKeepPairs: agent.autoCompactKeepPairs,
			queueDuringCompaction: agent.queueDuringCompaction,
			behaviorFenceInterval: agent.behaviorFenceInterval,
			tasksReminderInterval: agent.tasksReminderInterval,
			silentToolCallThreshold: agent.silentToolCallThreshold,
			behaviorFenceAttachTasks: agent.behaviorFenceAttachTasks,
			defaultRelaxedPlan: agent.defaultRelaxedPlan,
			planModeAllowInlinePlan: agent.planModeAllowInlinePlan,
		},
		outline: { enabled: source.outline?.enabled ?? false },
		requestEvidence: { autoPin: source.requestEvidence?.autoPin ?? "off" },
		// Unknown auto/aggregation readiness is not a confirmed failure; do not route.
		summaryModelAvailable: runtimeModelReadiness(source, agent.summaryModel),
	};
	if (admin) {
		response.update = {
			source: source.update?.source,
			githubRepository: source.update?.githubRepository,
			serverUrl: source.update?.serverUrl,
			product: source.update?.product,
			channel: source.update?.channel,
		};
		response.updateSettingsKey = updateSettingsKey(response.update);
	}
	if (new TextEncoder().encode(JSON.stringify(response)).byteLength > SETTINGS_RUNTIME_MAX_BYTES)
		throw new ValidationError("Runtime settings exceed byte budget; use settings details");
	return response;
}
