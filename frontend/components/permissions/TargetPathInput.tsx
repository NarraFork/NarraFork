import { ActionIcon, Group, Modal, Select, Stack, Text, Tooltip } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconFolderOpen, IconInfoCircle } from "@tabler/icons-react";
import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { PathFlavor, RuleTargetSelector } from "../../lib/api/types";
import { Z } from "../../lib/z-index";
import { DIRECTORY_BROWSER_MODAL_STYLES } from "../common/directory-browser-modal";
import { PathInput } from "../common/PathInput";
import { RemotePathInput } from "./RemotePathInput";
import { type PermissionTargetDevice, selectorDevice } from "./RuleTargetSelector";

const DirectoryBrowser = lazy(() =>
	import("../common/DirectoryPicker").then((module) => ({ default: module.DirectoryBrowser })),
);
const RemoteDirectoryBrowser = lazy(() =>
	import("./RemoteDirectoryBrowser").then((module) => ({
		default: module.RemoteDirectoryBrowser,
	})),
);

export function TargetPathInput({
	value,
	onChange,
	onCommit,
	onSubmit,
	selector,
	pathFlavor,
	onPathFlavorChange,
	devices,
	narratorId,
	placeholder,
	error,
	showFlavorSelect = true,
	showHint = true,
}: {
	value: string;
	onChange: (value: string) => void;
	/** Enter pressed on a plain (non-autocomplete) confirmation. */
	onSubmit?: () => void;
	/** Hidden when the parent surfaces path syntax in its own advanced area. */
	showFlavorSelect?: boolean;
	/** Hidden when the parent already explains the target elsewhere. */
	showHint?: boolean;
	/**
	 * Called when the edit should be persisted (blur, or picking from the
	 * browser). Receives the value explicitly because a browser selection
	 * commits in the same tick as its `onChange`, before parent state updates.
	 */
	onCommit?: (value: string) => void;
	selector: RuleTargetSelector;
	pathFlavor: PathFlavor | null;
	onPathFlavorChange: (value: PathFlavor) => void;
	devices: readonly PermissionTargetDevice[];
	/**
	 * When set, device browsing is authorized through this narrator instead of
	 * the admin-only device API, so non-admin users get the same picker.
	 */
	narratorId?: string;
	placeholder?: string;
	error?: string;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;
	const hostTarget = selector.kind === "host";
	const remoteDevice = selectorDevice(selector, devices);
	const deviceId = selector.kind === "device" ? selector.deviceId : null;
	// A rule spanning every target (or an OAuth group) has no single filesystem
	// to browse, so those keep plain manual entry.
	const requiresExplicitFlavor = selector.kind === "all" || selector.kind === "oauthGroup";
	const deviceOnline = remoteDevice?.status !== "offline";
	const canBrowseDevice = !!deviceId && !!remoteDevice && deviceOnline;

	const flavorDescription = requiresExplicitFlavor
		? t("permissionPathFlavorExplicit")
		: selector.kind === "device"
			? t("permissionPathFlavorDevice", {
					device: remoteDevice?.name ?? selector.deviceId,
				})
			: t("permissionPathFlavorHost");

	const deviceQueryKey = useMemo(
		() => ["permissionDeviceBrowse", narratorId ?? "admin", deviceId] as const,
		[narratorId, deviceId],
	);
	const listDeviceDirectory = useMemo(() => {
		if (!deviceId) return null;
		return (path?: string, opts?: { showHidden?: boolean }) =>
			narratorId
				? api.browseNarratorDevice(narratorId, deviceId, path, opts)
				: api.browseDevicePath(deviceId, path, opts);
	}, [narratorId, deviceId]);

	const browseHint = hostTarget
		? t("permissionHostBrowseHint")
		: canBrowseDevice
			? t("permissionDeviceBrowseHint")
			: deviceId && !deviceOnline
				? t("permissionDeviceOfflineHint")
				: t("permissionManualPathHint");

	const browseButton = (label: string) => (
		<Tooltip label={label}>
			<ActionIcon variant="subtle" onClick={open} aria-label={label}>
				<IconFolderOpen size={17} />
			</ActionIcon>
		</Tooltip>
	);

	return (
		<Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
			<Group gap="xs" align="flex-start" wrap="nowrap">
				{hostTarget ? (
					<PathInput
						value={value}
						onChange={onChange}
						onBlur={() => onCommit?.(value)}
						onSubmit={onSubmit}
						placeholder={placeholder}
						error={error}
						rightSection={browseButton(t("permissionBrowseHost"))}
					/>
				) : (
					<RemotePathInput
						value={value}
						onChange={onChange}
						onBlur={() => onCommit?.(value)}
						onSubmit={onSubmit}
						// Non-device targets have no browsable filesystem; the input then
						// behaves as plain manual entry with no autocomplete requests.
						listDirectory={listDeviceDirectory ?? (() => Promise.reject(new Error("unsupported")))}
						queryKey={deviceQueryKey}
						enabled={canBrowseDevice}
						placeholder={placeholder}
						error={error}
						rightSection={canBrowseDevice ? browseButton(t("permissionBrowseDevice")) : undefined}
					/>
				)}
				{showFlavorSelect && (
					<Select
						size="xs"
						value={pathFlavor}
						onChange={(next) => next && onPathFlavorChange(next as PathFlavor)}
						data={[
							{ value: "posix", label: t("permissionPathFlavorPosix") },
							{ value: "windows", label: t("permissionPathFlavorWindows") },
						]}
						placeholder={t("permissionPathFlavorSelect")}
						allowDeselect={false}
						required={requiresExplicitFlavor}
						comboboxProps={{ withinPortal: true }}
						style={{ width: 126 }}
					/>
				)}
			</Group>
			{showHint && (
				<Group gap={4} wrap="nowrap" align="flex-start">
					<IconInfoCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
					<Text size="xs" c="dimmed">
						{browseHint} {flavorDescription}
					</Text>
				</Group>
			)}
			<Modal
				opened={opened}
				onClose={close}
				title={hostTarget ? t("permissionBrowseHost") : t("permissionBrowseDevice")}
				size={isWide ? 880 : "md"}
				// This editor is often hosted inside a Popover (Mantine default
				// z-index 300), which would otherwise cover a default Modal (200).
				zIndex={Z.modal}
				styles={DIRECTORY_BROWSER_MODAL_STYLES}
			>
				{opened && hostTarget && (
					<Suspense fallback={null}>
						<DirectoryBrowser
							onSelect={(path) => {
								onChange(path);
								onCommit?.(path);
								close();
							}}
							onCancel={close}
							isWide={isWide}
						/>
					</Suspense>
				)}
				{opened && !hostTarget && listDeviceDirectory && (
					<Suspense fallback={null}>
						<RemoteDirectoryBrowser
							deviceLabel={remoteDevice?.name ?? deviceId ?? ""}
							initialPath={value.trim() || undefined}
							listDirectory={(path, opts) => listDeviceDirectory(path, opts)}
							queryKey={deviceQueryKey}
							onSelect={(path) => {
								onChange(path);
								onCommit?.(path);
								close();
							}}
							onCancel={close}
						/>
					</Suspense>
				)}
			</Modal>
		</Stack>
	);
}
