import { Menu } from "@mantine/core";
import { IconNotebook } from "@tabler/icons-react";
import { DangerReflectionMenuControl } from "./DangerReflectionMenuControl";
import { PermModeMenuItems } from "./PermModeMenuItems";
import { PlanReflectionMenuControl } from "./PlanReflectionMenuControl";
import type {
	BooleanOverride,
	DangerReflectionLevel,
	DangerReflectionOverride,
} from "./reflection-types";

export function PermissionMenuContent({
	currentMode,
	availablePermissionModes,
	permissionModesUnavailableReason,
	onSelectPermissionMode,
	t,
	hasPlanTrait,
	onTogglePlanMode,
	planModePending,
	planModeSupported,
	planModeUnsupportedReason,
	showPlanReflectionAutoApproveToggle,
	planReflectionAutoApproveOverride,
	planReflectionAutoApproveEffective,
	planReflectionAutoApproveGlobal,
	onPlanReflectionAutoApproveChange,
	onFollowDefaultPlanReflection,
	onSetPlanReflectionAsDefault,
	showDangerReflectionToggle,
	dangerReflectionOverride,
	dangerReflectionEffectiveLevel,
	dangerReflectionGlobalLevel,
	onDangerReflectionChange,
	onFollowDefaultDangerReflection,
	onSetDangerReflectionAsDefault,
	reflectionSettingsDisabled,
}: {
	currentMode: string;
	availablePermissionModes: string[];
	permissionModesUnavailableReason?: string;
	onSelectPermissionMode: (mode: string) => void;
	t: (key: string) => string;
	hasPlanTrait: boolean;
	onTogglePlanMode: () => void;
	planModePending: boolean;
	planModeSupported: boolean;
	planModeUnsupportedReason?: string;
	showPlanReflectionAutoApproveToggle: boolean;
	planReflectionAutoApproveOverride: BooleanOverride;
	planReflectionAutoApproveEffective: boolean;
	planReflectionAutoApproveGlobal: boolean;
	onPlanReflectionAutoApproveChange: (value: BooleanOverride) => void;
	onFollowDefaultPlanReflection: () => void;
	onSetPlanReflectionAsDefault: () => void;
	showDangerReflectionToggle: boolean;
	dangerReflectionOverride: DangerReflectionOverride;
	dangerReflectionEffectiveLevel: DangerReflectionLevel;
	dangerReflectionGlobalLevel: DangerReflectionLevel;
	onDangerReflectionChange: (value: DangerReflectionOverride) => void;
	onFollowDefaultDangerReflection: () => void;
	onSetDangerReflectionAsDefault: () => void;
	reflectionSettingsDisabled: boolean;
}) {
	return (
		<>
			<Menu.Label>{t("permissionMode")}</Menu.Label>
			<PermModeMenuItems
				currentMode={currentMode}
				availableModes={availablePermissionModes}
				unavailableReason={permissionModesUnavailableReason}
				onSelect={onSelectPermissionMode}
				t={t}
				renderAfterMode={(mode) =>
					mode === "bypassPermissions" ? (
						<DangerReflectionMenuControl
							visible={showDangerReflectionToggle}
							override={dangerReflectionOverride}
							effectiveLevel={dangerReflectionEffectiveLevel}
							globalLevel={dangerReflectionGlobalLevel}
							disabled={reflectionSettingsDisabled}
							onChange={onDangerReflectionChange}
							onFollowDefault={onFollowDefaultDangerReflection}
							onSetAsDefault={onSetDangerReflectionAsDefault}
							t={t}
						/>
					) : null
				}
			/>
			<Menu.Divider />
			<Menu.Item
				leftSection={<IconNotebook size={14} />}
				onClick={onTogglePlanMode}
				disabled={planModePending || !planModeSupported}
				title={!planModeSupported ? planModeUnsupportedReason : undefined}
			>
				{!planModeSupported
					? t("planModeUnavailable")
					: hasPlanTrait
						? t("exitPlanMode")
						: t("enterPlanMode")}
			</Menu.Item>
			<PlanReflectionMenuControl
				visible={showPlanReflectionAutoApproveToggle}
				override={planReflectionAutoApproveOverride}
				effective={planReflectionAutoApproveEffective}
				globalDefault={planReflectionAutoApproveGlobal}
				disabled={reflectionSettingsDisabled}
				onChange={onPlanReflectionAutoApproveChange}
				onFollowDefault={onFollowDefaultPlanReflection}
				onSetAsDefault={onSetPlanReflectionAsDefault}
				t={t}
			/>
		</>
	);
}
