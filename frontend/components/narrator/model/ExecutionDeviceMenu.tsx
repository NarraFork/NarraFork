import { ActionIcon, Menu, Text, Tooltip } from "@mantine/core";
import type { NarratorDeviceWorkspaceSummary } from "@shared/workspace-context";
import {
	IconCheck,
	IconDeviceDesktop,
	IconDevices,
	IconFolder,
	IconHistory,
} from "@tabler/icons-react";
import { nanoid } from "nanoid";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DeviceWorkspaceOperationError,
	useDeviceWorkspaceMutation,
	useNarratorDeviceWorkspaces,
	useWorkspaceContext,
} from "../../../hooks/useWorkspaceContext";
import {
	WorkspaceTargetPickerModal,
	type WorkspaceTargetPickerMode,
	WorkspaceTransitionNotice,
} from "./WorkspaceTargetPickerModal";

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
	currentDeviceId: string;
	onSelect: (deviceId: string | null) => void;
	withLabel?: boolean;
	directoryLabel?: string;
	onChangeDirectory?: () => void;
	snapshotsLabel?: string;
	onManageSnapshots?: () => void;
	bindings?: readonly NarratorDeviceWorkspaceSummary[];
	bindingsComplete?: boolean;
	disabled?: boolean;
	onConfigure?: (deviceId: string) => void;
	onLoadMore?: () => void;
}

/** Identical directory and selection actions for desktop and the mobile overflow. */
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
	bindings,
	bindingsComplete,
	disabled,
	onConfigure,
	onLoadMore,
}: ExecutionDeviceOptionsProps) {
	const { t } = useTranslation("narrator");
	return (
		<>
			{withLabel && <Menu.Label>{label}</Menu.Label>}
			{[{ id: "local", name: localLabel, online: true }, ...devices].map((device) => {
				const binding = bindings?.find((item) => item.deviceId === device.id);
				return (
					<span key={device.id}>
						<Menu.Item
							leftSection={
								device.id === "local" ? <IconDeviceDesktop size={14} /> : <IconDevices size={14} />
							}
							disabled={disabled || !device.online || binding?.availability === "offline"}
							rightSection={
								<IconCheck
									size={14}
									style={{ visibility: currentDeviceId === device.id ? "visible" : "hidden" }}
								/>
							}
							onClick={() => onSelect(device.id === "local" ? null : device.id)}
						>
							{device.online ? device.name : `${device.name} (${offlineLabel})`}
							{bindings && (
								<Text size="xs" c="dimmed">
									{binding?.cwd ??
										t(
											bindingsComplete
												? "deviceWorkspace.unconfigured"
												: "deviceWorkspace.notLoaded",
										)}
								</Text>
							)}
						</Menu.Item>
						{onConfigure && (
							<Menu.Item
								leftSection={<IconFolder size={14} />}
								disabled={disabled || !device.online}
								onClick={() => onConfigure(device.id)}
							>
								{t("deviceWorkspace.configureDevice", { device: device.name })}
							</Menu.Item>
						)}
					</span>
				);
			})}
			{onLoadMore && <Menu.Item onClick={onLoadMore}>{t("deviceWorkspace.loadMore")}</Menu.Item>}
			{onManageSnapshots && (
				<Menu.Item
					leftSection={<IconHistory size={14} />}
					disabled={disabled}
					onClick={onManageSnapshots}
				>
					{snapshotsLabel}
				</Menu.Item>
			)}
			{onChangeDirectory && (
				<Menu.Item
					leftSection={<IconFolder size={14} />}
					disabled={disabled}
					onClick={onChangeDirectory}
				>
					{directoryLabel}
				</Menu.Item>
			)}
		</>
	);
}

/** Shared selector: configured devices select without cwd; all other actions are explicit configuration. */
export function useDeviceWorkspaceControls(
	narratorId: string,
	devices: readonly ExecutionDeviceOption[],
	localLabel: string,
) {
	const { t } = useTranslation("narrator");
	const workspace = useWorkspaceContext(narratorId);
	const bindings = useNarratorDeviceWorkspaces(narratorId);
	const mutation = useDeviceWorkspaceMutation();
	const [target, setTarget] = useState<{
		narratorId: string;
		deviceId: string;
		mode: WorkspaceTargetPickerMode;
		epoch: string;
	}>();
	const [error, setError] = useState<{ narratorId: string; message: string }>();
	const open = (deviceId: string, mode: WorkspaceTargetPickerMode = "configure") =>
		setTarget({ narratorId, deviceId, mode, epoch: nanoid() });
	const select = (deviceId: string | null) => {
		const id = deviceId ?? "local";
		if (
			!workspace.data ||
			workspace.transition ||
			workspace.transitioning ||
			mutation.isPending ||
			bindings.isError
		)
			return;
		const binding = bindings.items.find((item) => item.deviceId === id);
		if (!binding) {
			open(id, "configureAndSelect");
			return;
		}
		setError(undefined);
		void mutation
			.mutateAsync({
				narratorId,
				kind: "select",
				request: {
					requestId: nanoid(),
					deviceId: id,
					expectedBindingRevision: binding.bindingRevision,
					expectedSelectionRevision: workspace.data.revision,
				},
			})
			.catch((failure: unknown) => {
				setError({
					narratorId,
					message:
						failure instanceof DeviceWorkspaceOperationError
							? t(`deviceWorkspace.${failure.phase}`)
							: failure instanceof Error
								? failure.message
								: String(failure),
				});
				void bindings.refetch();
			});
	};
	const display =
		workspace.isError ||
		(workspace.transition?.phase === "unconfirmed" &&
			workspace.transition.affectsSelection !== false)
			? undefined
			: workspace.snapshot;
	const targetForNarrator = target?.narratorId === narratorId ? target : undefined;
	return {
		workspace,
		display,
		error: error?.narratorId === narratorId ? error.message : undefined,
		select,
		open,
		rows: {
			bindings: bindings.items,
			bindingsComplete: bindings.isSuccess && !bindings.hasNextPage,
			disabled:
				!!workspace.transition ||
				workspace.transitioning ||
				mutation.isPending ||
				!workspace.data ||
				bindings.isError,
			onConfigure: (deviceId: string) => open(deviceId),
			onLoadMore:
				bindings.hasNextPage && !bindings.isFetchingNextPage
					? () => void bindings.fetchNextPage()
					: undefined,
		},
		modal: targetForNarrator ? (
			<WorkspaceTargetPickerModal
				key={`${narratorId}:${targetForNarrator.deviceId}:${targetForNarrator.epoch}`}
				narratorId={narratorId}
				deviceId={targetForNarrator.deviceId}
				deviceLabel={
					targetForNarrator.deviceId === "local"
						? localLabel
						: (devices.find((device) => device.id === targetForNarrator.deviceId)?.name ??
							targetForNarrator.deviceId)
				}
				deviceOnline={
					targetForNarrator.deviceId === "local" ||
					devices.some((device) => device.id === targetForNarrator.deviceId && device.online)
				}
				mode={targetForNarrator.mode}
				opened
				onClose={() => setTarget(undefined)}
			/>
		) : null,
	};
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
	const controls = useDeviceWorkspaceControls(
		narratorId ?? "",
		options.devices,
		options.localLabel,
	);
	const [snapshotsOpened, setSnapshotsOpened] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: narrator ownership changes discard the old manager surface
	useEffect(() => setSnapshotsOpened(false), [narratorId]);
	const context = controls.display;
	const targetDeviceId =
		context?.deviceId ?? (controls.workspace.transition ? "" : options.currentDeviceId);
	const isRemote = targetDeviceId !== "local";
	const currentLabel = targetDeviceId
		? (options.devices.find((device) => device.id === targetDeviceId)?.name ??
			(isRemote ? targetDeviceId : options.localLabel))
		: t("deviceWorkspace.unconfirmed");
	return (
		<>
			<Menu position="bottom-end" withinPortal>
				<Menu.Target>
					<Tooltip
						label={`${options.label}: ${currentLabel}${context?.cwd ? ` — ${context.cwd}` : ""}`}
					>
						<ActionIcon
							size="sm"
							variant={isRemote ? "light" : "subtle"}
							color={isRemote ? "indigo" : "gray"}
							loading={pending}
							aria-label={options.label}
						>
							{isRemote ? <IconDevices size={16} /> : <IconDeviceDesktop size={16} />}
						</ActionIcon>
					</Tooltip>
				</Menu.Target>
				<Menu.Dropdown>
					{narratorId && <WorkspaceTransitionNotice narratorId={narratorId} />}
					{controls.error && !controls.workspace.transition && (
						<Menu.Label>{controls.error}</Menu.Label>
					)}
					{context && (
						<Menu.Label>
							{context.cwd}
							<br />
							{t(`workspaceAvailability.${context.availability ?? "ready"}`)}
						</Menu.Label>
					)}
					<ExecutionDeviceOptions
						{...options}
						{...(narratorId ? controls.rows : {})}
						currentDeviceId={targetDeviceId}
						onSelect={narratorId ? controls.select : (deviceId) => onSelect?.(deviceId)}
						snapshotsLabel={t("snapshotRestore.title")}
						onManageSnapshots={
							narratorId ? () => setSnapshotsOpened(true) : options.onManageSnapshots
						}
						directoryLabel={t("deviceWorkspace.configure")}
						onChangeDirectory={
							narratorId
								? () => controls.open(context?.deviceId ?? options.currentDeviceId)
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
			{controls.modal}
		</>
	);
}
