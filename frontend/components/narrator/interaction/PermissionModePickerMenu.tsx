import { Menu, NativeSelect, Tooltip } from "@mantine/core";
import { IconNotebook, IconShield } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInputMenu } from "../../../hooks/useInputMenu";
import { PERM_MODE_ICONS } from "../narrator-panel-types";
import { PermModeMenuItems } from "./PermModeMenuItems";

/** The plan-mode entry the permission menu carries, when the caller has one. */
export interface PermissionPlanModeOption {
	/** Whether the session-to-be starts in plan mode. */
	active: boolean;
	supported: boolean;
	unsupportedReason?: string;
	onToggle: () => void;
}

/**
 * The permission-mode picker, detached from a session.
 *
 * Same items as the narrator status bar's permission menu, but the choice is the
 * caller's local state because the session does not exist yet. The reflection
 * controls the status bar nests under `bypassPermissions` are omitted: they edit a
 * stored per-narrator override, and a not-yet-created session simply inherits the
 * instance defaults, which is what omitting the create field does anyway.
 */
export function PermissionModePickerMenu({
	value,
	availableModes,
	unavailableReason,
	onChange,
	onFollowDefault,
	planMode,
	position = "bottom-start",
}: {
	value: string;
	availableModes: string[];
	unavailableReason?: string;
	onChange: (mode: string) => void;
	/**
	 * Clears an explicit pick so the mode follows the instance default again. Omit
	 * it while the value already is that default — there is nothing to clear.
	 */
	onFollowDefault?: () => void;
	planMode?: PermissionPlanModeOption;
	position?: "bottom-start" | "top-end";
}) {
	const { t } = useTranslation("narrator");
	const inputMenu = useInputMenu();
	const [opened, setOpened] = useState(false);

	return (
		<Tooltip label={t("permissionMode")} disabled={opened}>
			<Menu position={position} {...inputMenu.menuProps} opened={opened} onChange={setOpened}>
				<Menu.Target>
					<NativeSelect
						{...inputMenu.targetProps}
						size="xs"
						aria-label={t("permissionMode")}
						leftSection={PERM_MODE_ICONS[value] ?? <IconShield size={14} />}
						// The menu lists every available mode; the trigger only needs the
						// selected one so its native width stays put.
						data={[{ value, label: t(`perm_${value}`) }]}
						value={value}
						onChange={() => {}}
						onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
						style={{ pointerEvents: "auto", minWidth: 0 }}
					/>
				</Menu.Target>
				<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
					<PermModeMenuItems
						currentMode={value}
						availableModes={availableModes}
						unavailableReason={unavailableReason}
						onSelect={onChange}
						t={t}
					/>
					{planMode && (
						<>
							<Menu.Divider />
							<Menu.Item
								leftSection={<IconNotebook size={14} />}
								onClick={planMode.onToggle}
								disabled={!planMode.supported}
								title={planMode.supported ? undefined : planMode.unsupportedReason}
								fw={planMode.active ? 600 : 400}
							>
								{!planMode.supported
									? t("planModeUnavailable")
									: planMode.active
										? t("exitPlanMode")
										: t("enterPlanMode")}
							</Menu.Item>
						</>
					)}
					{onFollowDefault && (
						<>
							<Menu.Divider />
							<Menu.Item c="dimmed" onClick={onFollowDefault}>
								{t("override_followDefault")}
							</Menu.Item>
						</>
					)}
				</Menu.Dropdown>
			</Menu>
		</Tooltip>
	);
}
