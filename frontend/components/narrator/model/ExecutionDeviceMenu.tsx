/**
 * Execution-target selector for the narrator header toolbar.
 *
 * Extracted from `NarratorPanel`'s header, where it was an inline IIFE inside the
 * hard-coded button row. The registry-driven header renders entries from a list,
 * so an entry that is a Menu rather than a toggle needs to be a component it can
 * place — the IIFE could not be.
 *
 * Behaviour is unchanged: "local" plus every registered device, a check mark on
 * the current target, offline devices listed but not selectable.
 */

import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { IconCheck, IconDeviceDesktop, IconDevices } from "@tabler/icons-react";

export interface ExecutionDeviceOption {
	id: string;
	name: string;
	online: boolean;
}

export interface ExecutionDeviceOptionsProps {
	label: string;
	localLabel: string;
	offlineLabel: string;
	devices: readonly ExecutionDeviceOption[];
	/** `"local"` or a device id. */
	currentDeviceId: string;
	/** `null` selects the local target. */
	onSelect: (deviceId: string | null) => void;
	/** Hide the heading when the surrounding surface already labels the group. */
	withLabel?: boolean;
}

/**
 * The target rows on their own, without a trigger or a dropdown around them.
 *
 * Exported so the header's Menu and the toolbar overflow menu's inline expansion
 * present the SAME rows. The overflow menu used to render this entry as a dead
 * "header only" line, which on a phone — where the header keeps two icons and the
 * rest lives in that menu — left the control with no reachable entry point.
 */
export function ExecutionDeviceOptions({
	label,
	localLabel,
	offlineLabel,
	devices,
	currentDeviceId,
	onSelect,
	withLabel = true,
}: ExecutionDeviceOptionsProps) {
	return (
		<>
			{withLabel && <Menu.Label>{label}</Menu.Label>}
			<Menu.Item
				leftSection={<IconDeviceDesktop size={14} />}
				rightSection={
					<IconCheck
						size={14}
						style={{ visibility: currentDeviceId === "local" ? "visible" : "hidden" }}
					/>
				}
				onClick={() => onSelect(null)}
			>
				{localLabel}
			</Menu.Item>
			{devices.map((device) => (
				<Menu.Item
					key={device.id}
					leftSection={<IconDevices size={14} />}
					disabled={!device.online}
					rightSection={
						<IconCheck
							size={14}
							style={{ visibility: currentDeviceId === device.id ? "visible" : "hidden" }}
						/>
					}
					onClick={() => onSelect(device.id)}
				>
					{device.online ? device.name : `${device.name} (${offlineLabel})`}
				</Menu.Item>
			))}
		</>
	);
}

export function ExecutionDeviceMenu({
	pending,
	...options
}: Omit<ExecutionDeviceOptionsProps, "withLabel"> & { pending?: boolean }) {
	const { label, localLabel, devices, currentDeviceId } = options;
	const isRemote = currentDeviceId !== "local";
	const currentDevice = isRemote ? devices.find((d) => d.id === currentDeviceId) : undefined;
	const currentLabel = currentDevice ? currentDevice.name : localLabel;

	return (
		<Menu position="bottom-end" withinPortal>
			<Menu.Target>
				<Tooltip label={`${label}: ${currentLabel}`}>
					<ActionIcon
						size="sm"
						variant={isRemote ? "light" : "subtle"}
						color={isRemote ? "indigo" : "gray"}
						loading={pending}
						aria-label={label}
					>
						{isRemote ? <IconDevices size={16} /> : <IconDeviceDesktop size={16} />}
					</ActionIcon>
				</Tooltip>
			</Menu.Target>
			<Menu.Dropdown>
				<ExecutionDeviceOptions {...options} />
			</Menu.Dropdown>
		</Menu>
	);
}
