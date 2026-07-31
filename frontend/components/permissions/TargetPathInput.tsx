import { ActionIcon, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconFolderOpen, IconInfoCircle } from "@tabler/icons-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { PathFlavor, RuleTargetSelector } from "../../lib/api/types";
import { PathInput } from "../common/PathInput";
import { type PermissionTargetDevice, selectorDevice } from "./RuleTargetSelector";

const DirectoryBrowser = lazy(() =>
	import("../common/DirectoryPicker").then((module) => ({ default: module.DirectoryBrowser })),
);

export function TargetPathInput({
	value,
	onChange,
	selector,
	pathFlavor,
	onPathFlavorChange,
	devices,
	placeholder,
	error,
}: {
	value: string;
	onChange: (value: string) => void;
	selector: RuleTargetSelector;
	pathFlavor: PathFlavor | null;
	onPathFlavorChange: (value: PathFlavor) => void;
	devices: readonly PermissionTargetDevice[];
	placeholder?: string;
	error?: string;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;
	const hostTarget = selector.kind === "host";
	const remoteDevice = selectorDevice(selector, devices);
	const requiresExplicitFlavor = selector.kind === "all" || selector.kind === "oauthGroup";
	const flavorDescription = requiresExplicitFlavor
		? t("permissionPathFlavorExplicit")
		: selector.kind === "device"
			? t("permissionPathFlavorDevice", {
					device: remoteDevice?.name ?? selector.deviceId,
				})
			: t("permissionPathFlavorHost");

	return (
		<Stack gap={4}>
			<Group gap="xs" align="flex-start" wrap="nowrap">
				{hostTarget ? (
					<PathInput
						value={value}
						onChange={onChange}
						placeholder={placeholder}
						error={error}
						rightSection={
							<ActionIcon variant="subtle" onClick={open} aria-label={t("permissionBrowseHost")}>
								<IconFolderOpen size={17} />
							</ActionIcon>
						}
					/>
				) : (
					<TextInput
						size="xs"
						value={value}
						onChange={(event) => onChange(event.currentTarget.value)}
						placeholder={placeholder}
						error={error}
						styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
						style={{ flex: 1 }}
					/>
				)}
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
			</Group>
			<Group gap={4} wrap="nowrap" align="flex-start">
				<IconInfoCircle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
				<Text size="xs" c="dimmed">
					{hostTarget ? t("permissionHostBrowseHint") : t("permissionManualPathHint")}{" "}
					{flavorDescription}
				</Text>
			</Group>
			<Modal
				opened={opened}
				onClose={close}
				title={t("permissionBrowseHost")}
				size={isWide ? 880 : "md"}
				styles={{
					body: {
						padding: 0,
						maxHeight: "85vh",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					},
				}}
			>
				{opened && (
					<Suspense fallback={null}>
						<DirectoryBrowser
							onSelect={(path) => {
								onChange(path);
								close();
							}}
							onCancel={close}
							isWide={isWide}
						/>
					</Suspense>
				)}
			</Modal>
		</Stack>
	);
}
