import {
	ActionIcon,
	Box,
	Select,
	type SelectProps,
	Switch,
	type SwitchProps,
	Tooltip,
} from "@mantine/core";
import { type AppearancePreferenceKey, appearanceDefinition } from "@shared/appearance-preferences";
import { IconCloud, IconCloudOff } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppearanceSync } from "../../hooks/useAppearanceSync";

interface AppearanceSyncProps {
	preferenceKey: AppearancePreferenceKey;
	label: string;
}

export function AppearanceCustomSyncSwitch() {
	const { t } = useTranslation("settings");
	const { customEnabled, setCustomEnabled, ready } = useAppearanceSync();
	return (
		<Switch
			label={t("appearanceSync.custom")}
			checked={ready && customEnabled}
			disabled={!ready}
			onChange={(event) => {
				if (ready) setCustomEnabled(event.currentTarget.checked);
			}}
		/>
	);
}

/** Read-only scope indicators remain focusable so their tooltip is keyboard-accessible. */
export function AppearanceSyncControl({ preferenceKey, label }: AppearanceSyncProps) {
	const { t } = useTranslation("settings");
	const { customEnabled, isSynced, setSynced, ready } = useAppearanceSync();
	const definition = appearanceDefinition(preferenceKey);
	const customizable = definition?.customizable === true;
	const synced =
		ready && customEnabled && customizable
			? isSynced(preferenceKey)
			: (definition?.defaultSync ?? false);
	const editable = ready && customEnabled && customizable;
	const scope = t(synced ? "appearanceSync.account" : "appearanceSync.local");
	const detail = !customizable
		? t("appearanceSync.fixed")
		: !ready
			? t("appearanceSync.loading")
			: !customEnabled
				? t("appearanceSync.default")
				: t(synced ? "appearanceSync.toLocal" : "appearanceSync.toAccount");
	const tooltip = `${scope} · ${detail}`;
	const Icon = synced ? IconCloud : IconCloudOff;

	return (
		<Tooltip label={tooltip} events={{ hover: true, focus: true, touch: true }}>
			<ActionIcon
				type="button"
				variant="subtle"
				color={synced ? "indigo" : "gray"}
				size={40}
				aria-label={`${label}: ${tooltip}`}
				aria-pressed={synced}
				aria-disabled={!editable}
				data-appearance-sync={preferenceKey}
				style={{ cursor: editable ? "pointer" : "default", flexShrink: 0 }}
				onClick={() => {
					if (editable) setSynced(preferenceKey, !synced);
				}}
			>
				<Icon size={16} aria-hidden="true" />
			</ActionIcon>
		</Tooltip>
	);
}

/** Keep the indicator outside input labels so changing sync never changes the value. */
export function AppearancePreferenceRow({
	preferenceKey,
	label,
	children,
}: AppearanceSyncProps & { children: ReactNode }) {
	return (
		<Box
			style={{
				display: "grid",
				gridTemplateColumns: "minmax(0, 1fr) auto",
				alignItems: "start",
				columnGap: "var(--mantine-spacing-xs)",
			}}
		>
			<Box miw={0}>{children}</Box>
			<AppearanceSyncControl preferenceKey={preferenceKey} label={label} />
		</Box>
	);
}

export function AppearanceSwitch({
	preferenceKey,
	label,
	...props
}: AppearanceSyncProps & Omit<SwitchProps, "label">) {
	return (
		<AppearancePreferenceRow preferenceKey={preferenceKey} label={label}>
			<Switch label={label} {...props} />
		</AppearancePreferenceRow>
	);
}

export function AppearanceSelect({
	preferenceKey,
	label,
	...props
}: AppearanceSyncProps & Omit<SelectProps, "label">) {
	return (
		<AppearancePreferenceRow preferenceKey={preferenceKey} label={label}>
			<Select label={label} {...props} />
		</AppearancePreferenceRow>
	);
}
