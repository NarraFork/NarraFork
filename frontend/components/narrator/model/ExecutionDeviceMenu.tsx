/**
 * Execution-target selector for the narrator header toolbar.
 *
 * Extracted from `NarratorPanel`'s header, where it was an inline IIFE inside the
 * hard-coded button row. The registry-driven header renders entries from a list,
 * so an entry that is a Menu rather than a toggle needs to be a component it can
 * place — the IIFE could not be.
 *
 * Behaviour: "local" plus every registered device, a check mark on the current
 * target, offline devices listed but not selectable. A device that has no recorded
 * working directory is listed too, but selecting it opens the directory dialog
 * instead of switching — a switch to an unconfigured device must not run tools in a
 * directory nobody chose.
 */

import { ActionIcon, Group, Menu, Text, Tooltip } from "@mantine/core";
import { IconAlertCircle, IconCheck, IconDeviceDesktop, IconDevices } from "@tabler/icons-react";
import type { WorkspaceDirectoryMap } from "../../../lib/api/narrators";

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
	/**
	 * Working directory recorded per device (`execution-devices.directories`).
	 * Unknown (undefined) degrades to the old behaviour: attempt the switch and let the
	 * server's 409 open the dialog.
	 */
	directories?: WorkspaceDirectoryMap;
	/** Marker appended to a device row that still needs a directory. */
	noDirectoryLabel?: string;
	/** Selecting an unconfigured device asks for its directory instead of switching. */
	onRequireDirectory?: (deviceId: string) => void;
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
	directories,
	noDirectoryLabel,
	onRequireDirectory,
}: ExecutionDeviceOptionsProps) {
	const needsDirectory = (deviceId: string) =>
		directories !== undefined && directories[deviceId] === undefined;
	const choose = (deviceId: string) => {
		if (needsDirectory(deviceId) && onRequireDirectory) {
			onRequireDirectory(deviceId);
			return;
		}
		onSelect(deviceId === "local" ? null : deviceId);
	};
	const noDirectoryHint = noDirectoryLabel ? (
		<Text size="xs" c="orange">
			{noDirectoryLabel}
		</Text>
	) : null;

	return (
		<>
			{withLabel && <Menu.Label>{label}</Menu.Label>}
			<Menu.Item
				leftSection={<IconDeviceDesktop size={14} />}
				rightSection={
					<Group gap={6} wrap="nowrap">
						{needsDirectory("local") && (
							<IconAlertCircle size={13} style={{ color: "var(--mantine-color-orange-5)" }} />
						)}
						<IconCheck
							size={14}
							style={{ visibility: currentDeviceId === "local" ? "visible" : "hidden" }}
						/>
					</Group>
				}
				onClick={() => choose("local")}
			>
				<Group gap={8} wrap="nowrap" justify="space-between">
					<span>{localLabel}</span>
					{needsDirectory("local") && noDirectoryHint}
				</Group>
			</Menu.Item>
			{devices.map((device) => (
				<Menu.Item
					key={device.id}
					leftSection={<IconDevices size={14} />}
					disabled={!device.online}
					rightSection={
						<Group gap={6} wrap="nowrap">
							{device.online && needsDirectory(device.id) && (
								<IconAlertCircle size={13} style={{ color: "var(--mantine-color-orange-5)" }} />
							)}
							<IconCheck
								size={14}
								style={{ visibility: currentDeviceId === device.id ? "visible" : "hidden" }}
							/>
						</Group>
					}
					onClick={() => choose(device.id)}
				>
					<Group gap={8} wrap="nowrap" justify="space-between">
						<span>{device.online ? device.name : `${device.name} (${offlineLabel})`}</span>
						{device.online && needsDirectory(device.id) && noDirectoryHint}
					</Group>
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
