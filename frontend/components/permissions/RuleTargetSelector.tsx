import { Alert, Select, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type {
	PathFlavor,
	RuleTargetSelector as RuleTargetSelectorValue,
} from "../../lib/api/types";

export interface PermissionTargetDevice {
	id: string;
	name: string;
	status?: "online" | "offline";
	platformOs?: string | null;
}

const ALL_VALUE = "all";
const HOST_VALUE = "host";
const DEVICE_PREFIX = "device:";
const OAUTH_PREFIX = "oauth:";

export function devicePathFlavor(
	device: Pick<PermissionTargetDevice, "platformOs"> | undefined,
): PathFlavor {
	return device?.platformOs?.toLowerCase().startsWith("win") ? "windows" : "posix";
}

export function selectorDevice(
	selector: RuleTargetSelectorValue,
	devices: readonly PermissionTargetDevice[],
): PermissionTargetDevice | undefined {
	return selector.kind === "device"
		? devices.find((device) => device.id === selector.deviceId)
		: undefined;
}

function encodeSelector(selector: RuleTargetSelectorValue): string {
	switch (selector.kind) {
		case "all":
			return ALL_VALUE;
		case "host":
			return HOST_VALUE;
		case "device":
			return `${DEVICE_PREFIX}${selector.deviceId}`;
		case "oauthGroup":
			return `${OAUTH_PREFIX}${selector.group}`;
	}
}

function decodeSelector(value: string | null): RuleTargetSelectorValue {
	if (!value || value === ALL_VALUE) return { kind: "all" };
	if (value === HOST_VALUE) return { kind: "host" };
	if (value.startsWith(DEVICE_PREFIX)) {
		return { kind: "device", deviceId: value.slice(DEVICE_PREFIX.length) };
	}
	if (value === `${OAUTH_PREFIX}global`) return { kind: "oauthGroup", group: "global" };
	if (value === `${OAUTH_PREFIX}selfRegistered`) {
		return { kind: "oauthGroup", group: "selfRegistered" };
	}
	return { kind: "all" };
}

export function RuleTargetSelector({
	value,
	onChange,
	devices,
	showOauthGroups,
	label,
	size = "xs",
	disabled,
}: {
	value: RuleTargetSelectorValue;
	onChange: (value: RuleTargetSelectorValue) => void;
	devices: readonly PermissionTargetDevice[];
	showOauthGroups: boolean;
	label?: string;
	size?: "xs" | "sm";
	disabled?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const selectedDevice = selectorDevice(value, devices);
	const missingDevice = value.kind === "device" && !selectedDevice;
	const deviceOptions = devices.map((device) => ({
		value: `${DEVICE_PREFIX}${device.id}`,
		label: `${device.name || device.id}${device.status === "offline" ? ` · ${t("permissionTargetOffline")}` : ""}`,
	}));
	const data = [
		{ value: ALL_VALUE, label: t("permissionTargetAll") },
		{ value: HOST_VALUE, label: t("permissionTargetHost") },
		...(showOauthGroups
			? [
					{ value: `${OAUTH_PREFIX}global`, label: t("permissionTargetOauthGlobal") },
					{
						value: `${OAUTH_PREFIX}selfRegistered`,
						label: t("permissionTargetOauthSelfRegistered"),
					},
				]
			: []),
		...(deviceOptions.length > 0
			? [{ group: t("permissionTargetDevices"), items: deviceOptions }]
			: []),
		...(missingDevice
			? [
					{
						group: t("permissionTargetUnavailable"),
						items: [
							{
								value: `${DEVICE_PREFIX}${value.deviceId}`,
								label: value.deviceId,
							},
						],
					},
				]
			: []),
	];

	return (
		<Stack gap={4} style={{ minWidth: 180 }}>
			<Select
				size={size}
				label={label}
				value={encodeSelector(value)}
				onChange={(next) => onChange(decodeSelector(typeof next === "string" ? next : null))}
				data={data}
				disabled={disabled}
				allowDeselect={false}
				comboboxProps={{ withinPortal: true }}
			/>
			{missingDevice && (
				<Alert color="yellow" variant="light" icon={<IconAlertTriangle size={14} />} p={6}>
					<Text size="xs">{t("permissionTargetMissingDevice", { deviceId: value.deviceId })}</Text>
				</Alert>
			)}
		</Stack>
	);
}
