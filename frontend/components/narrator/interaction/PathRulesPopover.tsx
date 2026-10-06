import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	ActionIcon,
	Badge,
	Box,
	Menu,
	Modal,
	Popover,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconFolderPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
	useBlacklistDirs,
	useCmdBlacklist,
	useCmdWhitelist,
	useCreateBlacklistDir,
	useCreateCmdBlacklist,
	useCreateCmdWhitelist,
	useCreateWhitelistDir,
	useDeleteBlacklistDir,
	useDeleteCmdBlacklist,
	useDeleteCmdWhitelist,
	useDeleteWhitelistDir,
	useUpdateBlacklistDir,
	useUpdateCmdBlacklist,
	useUpdateCmdWhitelist,
	useUpdateWhitelistDir,
	useWhitelistDirs,
} from "../../../hooks/useNarrator";
import { usePlatform } from "../../../hooks/usePlatform";
import { api } from "../../../lib/api";
import type { PathFlavor } from "../../../lib/api/types";
import { PermissionRuleEditor } from "../../permissions/PermissionRuleEditor";

export function PathRulesPopover({
	narratorId,
	t,
	triggerMode = "icon",
	controlled,
}: {
	narratorId: string;
	t: (key: string) => string;
	triggerMode?: "icon" | "menu";
	/** An independently mounted dialog survives closing the toolbar menu that opened it. */
	controlled?: { opened: boolean; onClose: () => void };
}) {
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const platform = usePlatform();
	const serverPathFlavor: PathFlavor = platform === "windows" ? "windows" : "posix";
	const [localOpened, { toggle, close: closeLocal }] = useDisclosure(false);
	const opened = controlled?.opened ?? localOpened;
	const close = controlled?.onClose ?? closeLocal;
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Only fetch rules when the popover is open — avoids 4 API calls on every page load.
	const enabledId = opened ? narratorId : "";
	const { data: wlDirs = [] } = useWhitelistDirs(enabledId);
	const createWl = useCreateWhitelistDir();
	const updateWl = useUpdateWhitelistDir(narratorId);
	const deleteWl = useDeleteWhitelistDir(narratorId);
	const { data: blDirs = [] } = useBlacklistDirs(enabledId);
	const createBl = useCreateBlacklistDir();
	const updateBl = useUpdateBlacklistDir(narratorId);
	const deleteBl = useDeleteBlacklistDir(narratorId);
	const { data: cmdWl = [] } = useCmdWhitelist(enabledId);
	const createCmdWl = useCreateCmdWhitelist();
	const updateCmdWl = useUpdateCmdWhitelist(narratorId);
	const deleteCmdWl = useDeleteCmdWhitelist(narratorId);
	const { data: cmdBl = [] } = useCmdBlacklist(enabledId);
	const createCmdBl = useCreateCmdBlacklist();
	const updateCmdBl = useUpdateCmdBlacklist(narratorId);
	const deleteCmdBl = useDeleteCmdBlacklist(narratorId);
	const { data: execDevices } = useQuery({
		queryKey: ["narratorExecutionDevices", narratorId],
		queryFn: () => api.getNarratorExecutionDevices(narratorId),
		enabled: opened,
	});
	const permissionDevices = useMemo(
		() =>
			(execDevices?.devices ?? []).map((device) => ({
				id: device.id,
				name: device.name || device.id,
				status: device.online ? ("online" as const) : ("offline" as const),
				platformOs: device.platform?.os ?? null,
			})),
		[execDevices],
	);
	const badgeCount = wlDirs.length + blDirs.length + cmdWl.length + cmdBl.length;

	// Popover has no built-in outside-click handling here (closeOnClickOutside is
	// off so nested overlays can't dismiss it), so it is emulated below. The Modal
	// branch has its own overlay dismissal and must not run this.
	const usesPopover = !controlled && !isMobile && triggerMode !== "menu";

	useEffect(() => {
		if (!opened || !usesPopover) return;
		const handler = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			if (!target || dropdownRef.current?.contains(target)) return;
			// Any nested overlay opened from inside this popover (Select/Combobox
			// dropdowns, the directory-browser Modal, nested Popovers) is rendered
			// into Mantine's portal layer, not into our dropdown's DOM subtree.
			// Matching on portal containers instead of per-component class names
			// keeps this correct when a child switches widget type: enumerating
			// `.mantine-Combobox-dropdown` used to miss `.mantine-Select-dropdown`,
			// so picking a rule target counted as an outside click and tore down
			// the whole popover (losing the in-progress draft rule with it).
			if (target.closest("[data-portal], [data-mantine-shared-portal-node]")) return;
			close();
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [opened, usesPopover, close]);

	const trigger =
		triggerMode === "menu" ? (
			<Menu.Item
				key="path-rules"
				leftSection={<IconFolderPlus size={16} />}
				rightSection={badgeCount > 0 ? <Badge size="xs">{badgeCount}</Badge> : undefined}
				onClick={toggle}
			>
				{t("path_rules")}
			</Menu.Item>
		) : (
			<Tooltip label={t("path_rules")}>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					aria-label={t("path_rules")}
					onClick={toggle}
				>
					<IconFolderPlus size={16} />
					{badgeCount > 0 && (
						<Text
							size="8px"
							fw={700}
							c="indigo"
							style={{ position: "absolute", top: -2, right: -4 }}
						>
							{badgeCount}
						</Text>
					)}
				</ActionIcon>
			</Tooltip>
		);

	const content = (
		<Stack gap="md">
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("whitelist_dirs_title")}
				</Text>
				<PermissionRuleEditor
					rules={wlDirs}
					kind="directoryWhitelist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("whitelist_dirs_empty")}
					placeholder={t("whitelist_dirs_placeholder")}
					onCreate={(rule) =>
						createWl.mutate({
							narratorId,
							path: rule.path ?? "",
							pathFlavor: rule.pathFlavor ?? undefined,
							accessLevel: rule.accessLevel ?? "readOnly",
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateWl.mutate({
							dirId: rule.id ?? "",
							path: rule.path,
							pathFlavor: rule.pathFlavor ?? undefined,
							accessLevel: rule.accessLevel,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteWl.mutate(rule.id)}
				/>
			</Stack>
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("blacklist_dirs_title")}
				</Text>
				<PermissionRuleEditor
					rules={blDirs}
					kind="directoryBlacklist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("blacklist_dirs_empty")}
					placeholder={t("blacklist_dirs_placeholder")}
					onCreate={(rule) =>
						createBl.mutate({
							narratorId,
							path: rule.path ?? "",
							pathFlavor: rule.pathFlavor ?? undefined,
							denyLevel: rule.denyLevel ?? "denyAll",
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateBl.mutate({
							dirId: rule.id ?? "",
							path: rule.path,
							pathFlavor: rule.pathFlavor ?? undefined,
							denyLevel: rule.denyLevel,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteBl.mutate(rule.id)}
				/>
			</Stack>
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("cmd_whitelist_title")}
				</Text>
				<PermissionRuleEditor
					rules={cmdWl}
					kind="commandWhitelist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("cmd_whitelist_empty")}
					placeholder={t("cmd_whitelist_placeholder")}
					onCreate={(rule) =>
						createCmdWl.mutate({
							narratorId,
							pattern: rule.pattern ?? "",
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateCmdWl.mutate({
							entryId: rule.id ?? "",
							pattern: rule.pattern,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteCmdWl.mutate(rule.id)}
				/>
			</Stack>
			<Stack gap={6}>
				<Text size="xs" fw={600}>
					{t("cmd_blacklist_title")}
				</Text>
				<PermissionRuleEditor
					rules={cmdBl}
					kind="commandBlacklist"
					devices={permissionDevices}
					showOauthGroups={false}
					serverPathFlavor={serverPathFlavor}
					narratorId={narratorId}
					defaultDeviceId={execDevices?.defaultDeviceId ?? null}
					emptyLabel={t("cmd_blacklist_empty")}
					placeholder={t("cmd_blacklist_placeholder")}
					onCreate={(rule) =>
						createCmdBl.mutate({
							narratorId,
							pattern: rule.pattern ?? "",
							denyPrompt: rule.denyPrompt,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onUpdate={(_index, rule) =>
						updateCmdBl.mutate({
							entryId: rule.id ?? "",
							pattern: rule.pattern,
							denyPrompt: rule.denyPrompt,
							enabled: rule.enabled,
							selector: rule.selector,
						})
					}
					onDelete={(_index, rule) => rule.id && deleteCmdBl.mutate(rule.id)}
				/>
			</Stack>
		</Stack>
	);

	if (controlled || isMobile || triggerMode === "menu") {
		return (
			<>
				{!controlled && trigger}
				<Modal
					opened={opened}
					onClose={close}
					title={t("path_rules")}
					fullScreen={isMobile}
					size="lg"
					scrollAreaComponent={ScrollArea.Autosize}
				>
					<Box p="md">{content}</Box>
				</Modal>
			</>
		);
	}

	return (
		<Popover
			opened={opened}
			onClose={close}
			position="top-end"
			width={520}
			shadow="md"
			withinPortal
			closeOnClickOutside={false}
		>
			<Popover.Target>{trigger}</Popover.Target>
			<Popover.Dropdown ref={dropdownRef} mah="70vh" style={{ overflowY: "auto" }}>
				{content}
			</Popover.Dropdown>
		</Popover>
	);
}
