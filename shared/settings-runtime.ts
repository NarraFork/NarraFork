import type { RequestEvidenceAutoPin } from "./request-recording";
import type { UpdateSourceSettings } from "./update-settings";

export interface RuntimeSettings {
	revision: number;
	agent: {
		defaultModel: string;
		summaryModel: string;
		promptOptimizeContextMaxMessages?: number;
		defaultPermissionMode?:
			| "default"
			| "acceptEdits"
			| "bypassPermissions"
			| "readOnly"
			| "dontAsk";
		defaultStartInPlanMode?: boolean;
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "";
		dangerReflectionLevel?: "off" | "light" | "standard" | "strict";
		autoContinuationMode?: "always" | "blockStop" | "protectedOnly" | "off";
		dangerReflectionEnabled?: boolean;
		planReflectionAutoApprove?: boolean;
		planReflectionAllowAutoCompact?: boolean;
		questionReflectionEnabled?: boolean;
		questionReflectionTimeoutMs?: number;
		permissionRuleAutoApprove?: boolean;
		dangerSkipReadOnlyConfirmations?: boolean;
		contextThresholds?: { standard: { compactStart: number }; large: { compactStart: number } };
		autoCompactKeepPairs?: number;
		queueDuringCompaction?: boolean;
		behaviorFenceInterval?: number;
		tasksReminderInterval?: number;
		silentToolCallThreshold?: number;
		behaviorFenceAttachTasks?: boolean;
		defaultRelaxedPlan?: boolean;
		planModeAllowInlinePlan?: boolean;
	};
	outline: { enabled: boolean };
	requestEvidence: { autoPin: RequestEvidenceAutoPin };
	/** null means routing/readiness has not been observed; only false forces setup. */
	summaryModelAvailable: boolean | null;
	/** Administrator-only fixed source identity, retained for update conflict preconditions. */
	update?: UpdateSourceSettings;
	updateSettingsKey?: string;
}
