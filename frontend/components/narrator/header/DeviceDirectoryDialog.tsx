/**
 * "Set this device's working directory" dialog.
 *
 * A session keeps one directory per execution device, and a device that has none
 * cannot be switched to: the session would either run in a directory nobody chose or
 * fall back to this server. So the device picker blocks the switch and opens this
 * dialog, which asks for that ONE device's directory and performs the switch itself.
 *
 * The editors differ by device on purpose: this server gets the normal directory
 * picker (favorites, drives, autocomplete), a remote device gets its own browser
 * because its filesystem is not reachable through the local one.
 */

import { Alert, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconFolder } from "@tabler/icons-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSwitchWorkspaceContext, useWorkspaceContext } from "../../../hooks/useWorkspaceContext";
import { api } from "../../../lib/api";
import { Z } from "../../../lib/z-index";
import { DirectoryPicker } from "../../common/DirectoryPicker";
import { DIRECTORY_BROWSER_MODAL_STYLES } from "../../common/directory-browser-modal";

const RemoteDirectoryBrowser = lazy(() =>
	import("../../permissions/RemoteDirectoryBrowser").then((module) => ({
		default: module.RemoteDirectoryBrowser,
	})),
);

const LOCAL_DEVICE = "local";

export interface DeviceDirectoryDialogProps {
	narratorId: string;
	/** Device that needs a directory; `null` keeps the dialog closed. */
	deviceId: string | null;
	deviceName?: string;
	onClose: () => void;
}

export function DeviceDirectoryDialog({
	narratorId,
	deviceId,
	deviceName,
	onClose,
}: DeviceDirectoryDialogProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { data: context, isLoading } = useWorkspaceContext(narratorId);
	const {
		mutate: switchWorkspace,
		reset: resetSwitch,
		isPending: switchPending,
	} = useSwitchWorkspaceContext(narratorId);
	const [cwd, setCwd] = useState("");
	const [error, setError] = useState<string | null>(null);
	const target = deviceId ?? LOCAL_DEVICE;
	const isRemote = target !== LOCAL_DEVICE;
	const opened = deviceId !== null;

	// A directory from another device is meaningless here: start empty every time.
	// `target` is a dependency even though the body only clears state — opening the
	// dialog for a different device must not keep the previous device's path.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on device change
	useEffect(() => {
		if (!opened) return;
		setCwd("");
		setError(null);
		resetSwitch();
	}, [opened, target, resetSwitch]);

	const revision = context?.revision;
	const confirm = () => {
		const value = cwd.trim();
		if (!value || revision === undefined) return;
		setError(null);
		switchWorkspace(
			{
				expectedRevision: revision,
				requestId: crypto.randomUUID(),
				target: { deviceId: target, cwd: value },
			},
			{
				onSuccess: () => onClose(),
				onError: (failure) => {
					setError(failure instanceof Error ? failure.message : String(failure));
				},
			},
		);
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("deviceDirectoryTitle", { device: deviceName ?? target })}
			size="lg"
			// Opened from the header's dropdown and from the overflow menu: sit above both.
			zIndex={Z.modal}
			styles={DIRECTORY_BROWSER_MODAL_STYLES}
		>
			<Stack gap="sm">
				<Text size="xs" c="dimmed">
					{isRemote
						? t("deviceDirectoryRemoteHint", { device: deviceName ?? target })
						: t("deviceDirectoryLocalHint")}
				</Text>
				{isRemote ? (
					<Suspense fallback={<Loader size="sm" />}>
						<RemoteDirectoryBrowser
							deviceLabel={deviceName ?? target}
							initialPath={cwd.trim() || undefined}
							listDirectory={(path, opts) =>
								api.browseNarratorDevice(narratorId, target, path, {
									showHidden: opts.showHidden,
								})
							}
							queryKey={["narratorDeviceBrowse", narratorId, target]}
							onSelect={setCwd}
							onCancel={onClose}
						/>
					</Suspense>
				) : (
					<DirectoryPicker
						label={t("deviceDirectoryLabel")}
						description={t("deviceDirectoryLabelHint")}
						leftSection={<IconFolder size={16} />}
						value={cwd}
						onChange={setCwd}
					/>
				)}
				{isRemote && (
					<Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
						{cwd.trim() || t("deviceDirectoryEmpty")}
					</Text>
				)}
				{error && (
					<Alert color="red" variant="light" icon={<IconAlertTriangle size={15} />} p="xs">
						<Text size="xs">{error}</Text>
					</Alert>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{tc("cancel")}
					</Button>
					<Button
						onClick={confirm}
						loading={switchPending}
						disabled={!cwd.trim() || revision === undefined || isLoading}
					>
						{t("deviceDirectoryConfirm", { device: deviceName ?? target })}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
