import { Menu } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import type React from "react";
import { PERM_MODE_ICONS, PERM_MODES } from "../narrator-panel-types";

export function PermModeMenuItems({
	currentMode,
	availableModes,
	unavailableReason,
	onSelect,
	t,
	renderAfterMode,
}: {
	currentMode: string;
	availableModes: string[];
	unavailableReason?: string;
	onSelect: (mode: string) => void;
	t: (key: string) => string;
	renderAfterMode?: (mode: string) => React.ReactNode;
}) {
	const modes = PERM_MODES.filter((mode) => availableModes.includes(mode));
	if (modes.length === 0) {
		return (
			<Menu.Item disabled title={unavailableReason}>
				{t("permissionModesUnavailable")}
			</Menu.Item>
		);
	}

	return (
		<>
			{modes.map((mode) => {
				const selected = currentMode === mode;
				return (
					<span key={mode}>
						<Menu.Item
							leftSection={PERM_MODE_ICONS[mode]}
							onClick={() => onSelect(mode)}
							rightSection={
								<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
							}
							fw={selected ? 600 : 400}
						>
							{t(`perm_${mode}`)}
						</Menu.Item>
						{renderAfterMode?.(mode)}
					</span>
				);
			})}
		</>
	);
}
