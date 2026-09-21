import type { TFunction } from "i18next";
import type React from "react";
import type { useModelCardIndex } from "../../../hooks/useModelCards";
import type { ModelOption } from "../../../lib/constants";
import type { NarratorInteractionStatusBarProps } from "./NarratorInteractionStatusBar";
import { useFastModeControl } from "./use-fast-mode-control";
import { useModelSelection } from "./use-model-selection";
import { usePermissionModeControl } from "./use-permission-mode-control";

/**
 * Assembles the {@link NarratorInteractionStatusBar} props from raw inputs,
 * computing the model / reasoning / codex / fast-mode / permission control
 * sub-objects here (via the extracted control hooks) rather than in NarratorPanel.
 *
 * The panel used to build this ~130-line object inline and call four control
 * hooks solely to feed it; that logic now lives beside the status bar it drives.
 * Values that are bound to the panel's WS-subscription lifecycle (work indicator,
 * quota, queue, context indicator) are passed in pre-shaped, since they cannot be
 * derived without `useNarratorPanelWS`.
 */
export interface UseStatusBarPropsOptions {
	// ── Identity / layout ──
	narratorId: string;
	narrator: NarratorInteractionStatusBarProps["narrator"];
	ownsHorizontalSafeArea: boolean | undefined;
	borderTop: string | undefined;
	isWorkspacePreview: boolean;
	compact: boolean | undefined;
	isMobileViewport: boolean;
	t: TFunction<"narrator">;
	tt: (key: string) => string;

	// ── WS-bound pass-through groups (derived from useNarratorPanelWS) ──
	contextIndicator: React.ReactNode;
	viewers: NarratorInteractionStatusBarProps["viewers"];
	currentUser: NarratorInteractionStatusBarProps["currentUser"];
	workIndicator: NarratorInteractionStatusBarProps["workIndicator"];
	queue: NarratorInteractionStatusBarProps["queue"];
	quota: NarratorInteractionStatusBarProps["quota"];
	tasks: NarratorInteractionStatusBarProps["tasks"];
	terminal: NarratorInteractionStatusBarProps["terminal"];
	promote: NarratorInteractionStatusBarProps["promote"];
	relaxedPlan: NarratorInteractionStatusBarProps["relaxedPlan"];
	mobile: NarratorInteractionStatusBarProps["mobile"];

	// ── Model menu display inputs ──
	model: NarratorInteractionStatusBarProps["model"];

	// ── Inputs for the control hooks computed here ──
	// useResolvedModel result (resolvedModel stays in the panel; it feeds WS/NUG).
	resolvedModel: string;
	resolvedBareModel: string;
	resolvedModelOption: ModelOption | undefined;
	narratorReasoningEffort: string | null | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: settings passthrough shared with useModelSelection.
	settingsData: any;
	modelCardIndex: ReturnType<typeof useModelCardIndex>;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	reasoningEffortMutation: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	updateSettingsMutation: any;

	// fast mode
	narratorFastModeOverride: "inherit" | "on" | "off" | null | undefined;
	fastModeDefault: boolean;
	fastModeUsesTapSettings: boolean;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	fastModeMutation: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	updateUserPrefs: any;

	// permission mode + reflection
	availablePermissionModes: string[];
	permissionModesUnavailableReason: string | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	permModeMutation: any;
	hasPlanTrait: boolean;
	planModePending: boolean;
	planModeSupported: boolean;
	planModeUnsupportedReason: string | undefined;
	planReflectionSupported: boolean;
	dangerReflectionSupported: boolean;
	narratorPlanReflectionAutoApproveOverride: unknown;
	narratorDangerReflectionOverride: unknown;
	planReflectionAutoApproveGlobal: boolean;
	dangerReflectionGlobal: boolean;
	// biome-ignore lint/suspicious/noExplicitAny: reflection level enum passthrough.
	dangerReflectionGlobalLevel: any;
	settingsLoaded: boolean;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	enterPlanModeMutation: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	exitPlanModeMutation: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation passthrough.
	reflectionOverridesMutation: any;
	confirm: (options: { message: React.ReactNode }) => Promise<boolean>;
	reflectionSettingsDisabled: boolean;
}

export function useStatusBarProps(
	options: UseStatusBarPropsOptions,
): NarratorInteractionStatusBarProps {
	const modelSelection = useModelSelection({
		narratorId: options.narratorId,
		resolvedModel: options.resolvedModel,
		resolvedBareModel: options.resolvedBareModel,
		resolvedModelOption: options.resolvedModelOption,
		narratorReasoningEffort: options.narratorReasoningEffort,
		settingsData: options.settingsData,
		modelCardIndex: options.modelCardIndex,
		reasoningEffortMutation: options.reasoningEffortMutation,
		updateSettingsMutation: options.updateSettingsMutation,
	});

	const { renderFastModeControl } = useFastModeControl({
		narratorId: options.narratorId,
		narratorFastModeOverride: options.narratorFastModeOverride,
		fastModeDefault: options.fastModeDefault,
		fastModeUsesTapSettings: options.fastModeUsesTapSettings,
		fastModeMutation: options.fastModeMutation,
		updateUserPrefs: options.updateUserPrefs,
		t: options.t,
	});

	const permissionControl = usePermissionModeControl({
		narratorId: options.narratorId,
		narratorPlanReflectionAutoApproveOverride: options.narratorPlanReflectionAutoApproveOverride,
		narratorDangerReflectionOverride: options.narratorDangerReflectionOverride,
		hasPlanTrait: options.hasPlanTrait,
		planModeSupported: options.planModeSupported,
		planReflectionSupported: options.planReflectionSupported,
		dangerReflectionSupported: options.dangerReflectionSupported,
		planReflectionAutoApproveGlobal: options.planReflectionAutoApproveGlobal,
		dangerReflectionGlobal: options.dangerReflectionGlobal,
		dangerReflectionGlobalLevel: options.dangerReflectionGlobalLevel,
		settingsLoaded: options.settingsLoaded,
		enterPlanModeMutation: options.enterPlanModeMutation,
		exitPlanModeMutation: options.exitPlanModeMutation,
		reflectionOverridesMutation: options.reflectionOverridesMutation,
		updateSettingsMutation: options.updateSettingsMutation,
		confirm: options.confirm,
		t: options.t,
	});

	return {
		narratorId: options.narratorId,
		narrator: options.narrator,
		ownsHorizontalSafeArea: options.ownsHorizontalSafeArea,
		borderTop: options.borderTop,
		isWorkspacePreview: options.isWorkspacePreview,
		compact: options.compact,
		isMobileViewport: options.isMobileViewport,
		t: options.t,
		tt: options.tt,
		contextIndicator: options.contextIndicator,
		viewers: options.viewers,
		currentUser: options.currentUser,
		workIndicator: options.workIndicator,
		queue: options.queue,
		tasks: options.tasks,
		model: options.model,
		reasoning: {
			supported: modelSelection.supportsReasoningEffort,
			displayed: modelSelection.displayedReasoningEffort,
			options: modelSelection.reasoningEffortOptions,
			followsDefault: modelSelection.reasoningFollowsDefault,
			mutation: options.reasoningEffortMutation,
			onFollowDefault: modelSelection.handleFollowDefaultReasoning,
			onSetAsDefault: modelSelection.handleSetReasoningAsDefault,
		},
		permission: {
			availableModes: options.availablePermissionModes,
			unavailableReason: options.permissionModesUnavailableReason,
			mutation: options.permModeMutation,
			hasPlanTrait: options.hasPlanTrait,
			togglePlanMode: permissionControl.togglePlanMode,
			planModePending: options.planModePending,
			planModeSupported: options.planModeSupported,
			planModeUnsupportedReason: options.planModeUnsupportedReason,
			planReflection: {
				supported: options.planReflectionSupported,
				override: permissionControl.planReflectionAutoApproveOverride,
				effective: permissionControl.planReflectionAutoApproveEffective,
				global: options.planReflectionAutoApproveGlobal,
				onChange: permissionControl.handlePlanReflectionAutoApproveOverride,
				onFollowDefault: permissionControl.handleFollowDefaultPlanReflection,
				onSetAsDefault: permissionControl.handleSetPlanReflectionAsDefault,
			},
			dangerReflection: {
				supported: options.dangerReflectionSupported,
				override: permissionControl.dangerReflectionOverride,
				effectiveLevel: permissionControl.dangerReflectionEffectiveLevel,
				globalLevel: options.dangerReflectionGlobalLevel,
				onChange: permissionControl.handleDangerReflectionOverride,
				onFollowDefault: permissionControl.handleFollowDefaultDangerReflection,
				onSetAsDefault: permissionControl.handleSetDangerReflectionAsDefault,
			},
			reflectionSettingsDisabled: options.reflectionSettingsDisabled,
		},
		codexControls: {
			supportsCodexControls: modelSelection.supportsCodexControls,
			isBuiltInCodexModel: modelSelection.isBuiltInCodexModel,
			renderFastModeControl,
		},
		quota: options.quota,
		relaxedPlan: options.relaxedPlan,
		terminal: options.terminal,
		promote: options.promote,
		mobile: options.mobile,
	};
}
