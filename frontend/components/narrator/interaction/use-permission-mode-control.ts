import type { ReactNode } from "react";
import { useCallback } from "react";
import {
	type BooleanOverride,
	type DangerReflectionLevel,
	type DangerReflectionOverride,
	normalizeBooleanOverride,
	normalizeDangerReflectionOverride,
	resolveBooleanOverride,
	resolveDangerReflectionLevel,
} from "./reflection-types";

interface Mutation<T> {
	mutate: (input: T) => void;
}

export interface UsePermissionModeControlOptions {
	narratorId: string;
	/** Raw override values off the narrator record. */
	narratorPlanReflectionAutoApproveOverride: unknown;
	narratorDangerReflectionOverride: unknown;
	/** Whether the narrator currently carries the plan trait (owned by the panel). */
	hasPlanTrait: boolean;
	planModeSupported: boolean;
	planReflectionSupported: boolean;
	dangerReflectionSupported: boolean;
	/** Global (instance-default) reflection state. */
	planReflectionAutoApproveGlobal: boolean;
	dangerReflectionGlobal: boolean;
	dangerReflectionGlobalLevel: DangerReflectionLevel;
	/** Whether settings are loaded (guards "set as default"). */
	settingsLoaded: boolean;
	enterPlanModeMutation: Mutation<string>;
	exitPlanModeMutation: Mutation<string>;
	reflectionOverridesMutation: Mutation<{
		id: string;
		planReflectionAutoApproveOverride?: BooleanOverride;
		dangerReflectionOverride?: DangerReflectionOverride;
	}>;
	updateSettingsMutation: Mutation<{
		agent: {
			planReflectionAutoApprove?: boolean;
			dangerReflectionLevel?: DangerReflectionLevel;
			dangerReflectionEnabled?: boolean;
		};
	}>;
	confirm: (options: { message: ReactNode }) => Promise<boolean>;
	t: (key: string) => string;
}

export interface UsePermissionModeControlResult {
	planReflectionAutoApproveOverride: BooleanOverride;
	dangerReflectionOverride: DangerReflectionOverride;
	planReflectionAutoApproveEffective: boolean;
	dangerReflectionEffectiveLevel: DangerReflectionLevel;
	togglePlanMode: () => void;
	handlePlanReflectionAutoApproveOverride: (value: BooleanOverride) => void;
	handleFollowDefaultPlanReflection: () => void;
	handleSetPlanReflectionAsDefault: () => void;
	handleDangerReflectionOverride: (value: DangerReflectionOverride) => Promise<void>;
	handleFollowDefaultDangerReflection: () => void;
	handleSetDangerReflectionAsDefault: () => Promise<void>;
}

/**
 * Plan-mode toggle plus the plan/danger reflection override controls: resolves the
 * effective override state from the narrator's own value and the instance default,
 * and wires the change / follow-default / set-as-default handlers (including the
 * "disabling danger reflection" confirmation guard).
 *
 * Kept lifted (called from the panel): its outputs are assembled into the big
 * status-bar control-menu object, and `hasPlanTrait` (which several other panel
 * consumers read) is injected rather than owned here.
 */
export function usePermissionModeControl(
	options: UsePermissionModeControlOptions,
): UsePermissionModeControlResult {
	const {
		narratorId,
		narratorPlanReflectionAutoApproveOverride,
		narratorDangerReflectionOverride,
		hasPlanTrait,
		planModeSupported,
		planReflectionSupported,
		dangerReflectionSupported,
		planReflectionAutoApproveGlobal,
		dangerReflectionGlobal,
		dangerReflectionGlobalLevel,
		settingsLoaded,
		enterPlanModeMutation,
		exitPlanModeMutation,
		reflectionOverridesMutation,
		updateSettingsMutation,
		confirm,
		t,
	} = options;

	const planReflectionAutoApproveOverride = normalizeBooleanOverride(
		narratorPlanReflectionAutoApproveOverride,
	);
	const dangerReflectionOverride = normalizeDangerReflectionOverride(
		narratorDangerReflectionOverride,
	);
	const planReflectionAutoApproveEffective = resolveBooleanOverride(
		planReflectionAutoApproveOverride,
		planReflectionAutoApproveGlobal,
	);
	const dangerReflectionEffectiveLevel = resolveDangerReflectionLevel(
		dangerReflectionOverride,
		dangerReflectionGlobalLevel,
	);
	const togglePlanMode = useCallback(() => {
		if (!narratorId || !planModeSupported) return;
		if (hasPlanTrait) {
			exitPlanModeMutation.mutate(narratorId);
		} else {
			enterPlanModeMutation.mutate(narratorId);
		}
	}, [enterPlanModeMutation, exitPlanModeMutation, hasPlanTrait, narratorId, planModeSupported]);
	const handlePlanReflectionAutoApproveOverride = useCallback(
		(value: BooleanOverride) => {
			if (!planReflectionSupported) return;
			reflectionOverridesMutation.mutate({
				id: narratorId,
				planReflectionAutoApproveOverride: value,
			});
		},
		[narratorId, planReflectionSupported, reflectionOverridesMutation],
	);
	const handleFollowDefaultPlanReflection = useCallback(() => {
		handlePlanReflectionAutoApproveOverride("inherit");
	}, [handlePlanReflectionAutoApproveOverride]);
	const handleSetPlanReflectionAsDefault = useCallback(() => {
		if (!settingsLoaded || !planReflectionSupported) return;
		updateSettingsMutation.mutate({
			agent: { planReflectionAutoApprove: planReflectionAutoApproveEffective },
		});
		reflectionOverridesMutation.mutate({
			id: narratorId,
			planReflectionAutoApproveOverride: "inherit",
		});
	}, [
		narratorId,
		planReflectionAutoApproveEffective,
		planReflectionSupported,
		reflectionOverridesMutation,
		settingsLoaded,
		updateSettingsMutation,
	]);
	const handleDangerReflectionOverride = useCallback(
		async (value: DangerReflectionOverride) => {
			if (!dangerReflectionSupported) return;
			const nextLevel = resolveDangerReflectionLevel(value, dangerReflectionGlobalLevel);
			if (nextLevel === "off" && dangerReflectionEffectiveLevel !== "off") {
				const ok = await confirm({ message: t("dangerReflectionDisableWarning") });
				if (!ok) return;
			}
			reflectionOverridesMutation.mutate({ id: narratorId, dangerReflectionOverride: value });
		},
		[
			confirm,
			dangerReflectionEffectiveLevel,
			dangerReflectionGlobalLevel,
			dangerReflectionSupported,
			narratorId,
			reflectionOverridesMutation,
			t,
		],
	);
	const handleFollowDefaultDangerReflection = useCallback(() => {
		handleDangerReflectionOverride("inherit");
	}, [handleDangerReflectionOverride]);
	const handleSetDangerReflectionAsDefault = useCallback(async () => {
		if (!settingsLoaded || !dangerReflectionSupported) return;
		if (dangerReflectionEffectiveLevel === "off" && dangerReflectionGlobal) {
			const ok = await confirm({ message: t("dangerReflectionDisableWarning") });
			if (!ok) return;
		}
		updateSettingsMutation.mutate({
			agent: {
				dangerReflectionLevel: dangerReflectionEffectiveLevel,
				dangerReflectionEnabled: dangerReflectionEffectiveLevel !== "off",
			},
		});
		reflectionOverridesMutation.mutate({ id: narratorId, dangerReflectionOverride: "inherit" });
	}, [
		confirm,
		dangerReflectionEffectiveLevel,
		dangerReflectionGlobal,
		dangerReflectionSupported,
		narratorId,
		reflectionOverridesMutation,
		settingsLoaded,
		t,
		updateSettingsMutation,
	]);

	return {
		planReflectionAutoApproveOverride,
		dangerReflectionOverride,
		planReflectionAutoApproveEffective,
		dangerReflectionEffectiveLevel,
		togglePlanMode,
		handlePlanReflectionAutoApproveOverride,
		handleFollowDefaultPlanReflection,
		handleSetPlanReflectionAsDefault,
		handleDangerReflectionOverride,
		handleFollowDefaultDangerReflection,
		handleSetDangerReflectionAsDefault,
	};
}
