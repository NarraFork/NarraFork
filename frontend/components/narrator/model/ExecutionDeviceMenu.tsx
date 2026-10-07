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
import {
	IconCheck,
	IconDeviceDesktop,
	IconDevices,
	IconFolder,
	IconHistory,
} from "@tabler/icons-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceContext } from "../../../hooks/useWorkspaceContext";
import { WorkspaceTargetPickerModal } from "./WorkspaceTargetPickerModal";

const WorkspaceSnapshotRestoreModal = lazy(() =>
	import("../workspace/WorkspaceSnapshotRestoreModal").then((module) => ({
		default: module.WorkspaceSnapshotRestoreModal,
	})),
);

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
	directoryLabel?: string;
	onChangeDirectory?: () => void;
	snapshotsLabel?: string;
	onManageSnapshots?: () => void;
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
	directoryLabel,
	onChangeDirectory,
	snapshotsLabel,
	onManageSnapshots,
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
			{onManageSnapshots && (
				<Menu.Item leftSection={<IconHistory size={14} />} onClick={onManageSnapshots}>
					{snapshotsLabel}
				</Menu.Item>
			)}
			{onChangeDirectory && (
				<Menu.Item leftSection={<IconFolder size={14} />} onClick={onChangeDirectory}>
					{directoryLabel}
				</Menu.Item>
			)}
		</>
	);
}

export function ExecutionDeviceMenu({
	pending,
	narratorId,
	onSelect,
	...options
}: Omit<ExecutionDeviceOptionsProps, "withLabel" | "onSelect"> & {
	pending?: boolean;
	narratorId?: string;
	onSelect?: (deviceId: string | null) => void;
}) {
	const { t } = useTranslation("narrator");
	const { data: context, transitioning } = useWorkspaceContext(narratorId ?? "");
	const [snapshotsOpened, setSnapshotsOpened] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: narrator ownership changes discard the old manager surface
	useEffect(() => setSnapshotsOpened(false), [narratorId]);
	const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: narrator ownership changes must discard the old target selection
	useEffect(() => setSelectedDevice(null), [narratorId]);
	const { label, localLabel, devices, currentDeviceId } = options;
	const targetDeviceId = context?.deviceId ?? currentDeviceId;
	const isRemote = targetDeviceId !== "local";
	const currentDevice = isRemote ? devices.find((d) => d.id === targetDeviceId) : undefined;
	const currentLabel = currentDevice?.name ?? (isRemote ? targetDeviceId : localLabel);

	return (
		<>
			<Menu position="bottom-end" withinPortal>
				<Menu.Target>
					<Tooltip label={`${label}: ${currentLabel}${context?.cwd ? ` — ${context.cwd}` : ""}`}>
						<ActionIcon
							size="sm"
							variant={isRemote ? "light" : "subtle"}
							color={isRemote ? "indigo" : "gray"}
							loading={pending || transitioning}
							aria-label={label}
						>
							{isRemote ? <IconDevices size={16} /> : <IconDeviceDesktop size={16} />}
						</ActionIcon>
					</Tooltip>
				</Menu.Target>
				<Menu.Dropdown>
					{context && (
						<Menu.Label>
							{context.cwd}
							<br />
							{t(`workspaceAvailability.${context.availability ?? "ready"}`)}
						</Menu.Label>
					)}
					{context?.capabilities.browse?.available === false && (
						<Menu.Label>{context.capabilities.browse.reason}</Menu.Label>
					)}
					<ExecutionDeviceOptions
						{...options}
						currentDeviceId={targetDeviceId}
						onSelect={(deviceId) =>
							narratorId ? setSelectedDevice(deviceId ?? "local") : onSelect?.(deviceId)
						}
						snapshotsLabel={t("snapshotRestore.title")}
						onManageSnapshots={
							narratorId ? () => setSnapshotsOpened(true) : options.onManageSnapshots
						}
						directoryLabel={t("workspaceSwitch")}
						onChangeDirectory={
							narratorId
								? () => setSelectedDevice(context?.deviceId ?? currentDeviceId)
								: options.onChangeDirectory
						}
					/>
				</Menu.Dropdown>
			</Menu>
			{narratorId && snapshotsOpened && (
				<Suspense fallback={null}>
					<WorkspaceSnapshotRestoreModal
						key={narratorId}
						narratorId={narratorId}
						opened
						onClose={() => setSnapshotsOpened(false)}
					/>
				</Suspense>
			)}
			{narratorId && selectedDevice && (
				<WorkspaceTargetPickerModal
					key={`${narratorId}:${selectedDevice}`}
					narratorId={narratorId}
					deviceId={selectedDevice}
					deviceLabel={
						selectedDevice === "local"
							? localLabel
							: (devices.find((device) => device.id === selectedDevice)?.name ?? selectedDevice)
					}
					opened
					onClose={() => setSelectedDevice(null)}
				/>
			)}
		</>
	);
}
