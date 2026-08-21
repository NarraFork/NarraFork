/**
 * Detail-level (render LOD) selector for the narrator header toolbar.
 *
 * The historic way to change the level was Alt — hold it to summon the
 * LodSwitchToast overlay, or alt+wheel to step. That gesture is now
 * user-configurable (Settings → Appearance; `narrafork_lod_alt_gesture`) and can
 * be turned off entirely, so the toolbar menu is the entry point that survives
 * it: always one click away, no modifier, no overlay timing.
 *
 * Levels and wording mirror LodSwitchToast deliberately (same LOD_LEVELS order,
 * same lodSelectLevel / lodSetAsDefault strings), so a reader who knows one
 * control already knows the other. The toast still pops over the message area
 * on every change made here — it is the feedback channel for ANY level change,
 * including pinch on touch.
 */

import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import {
	IconBaselineDensityLarge,
	IconBaselineDensityMedium,
	IconBaselineDensitySmall,
	IconCheck,
	IconPin,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { LOD_LEVELS } from "./lod-indicator";
import type { RenderLod } from "./RenderLodCtx";

/** Icon for a level, matching LodSwitchToast's density ladder. */
function lodIcon(level: RenderLod) {
	if (level >= 5) return IconBaselineDensitySmall;
	if (level >= 3) return IconBaselineDensityMedium;
	return IconBaselineDensityLarge;
}

export function NarratorLodMenu({
	lod,
	isDefault,
	onSelectLod,
	onSetAsDefault,
}: {
	lod: RenderLod;
	/** Whether `lod` equals the saved default — hides the "set as default" row. */
	isDefault: boolean;
	/** Called with the picked level. */
	onSelectLod: (next: RenderLod) => void;
	/** Save the current level as the global default (used by new narrators). */
	onSetAsDefault: () => void;
}) {
	const { t } = useTranslation("narrator");
	const label = t("lodDensity");
	const CurrentIcon = lodIcon(lod);

	return (
		<Menu position="bottom-end" withinPortal>
			<Menu.Target>
				<Tooltip label={label}>
					<ActionIcon size="sm" variant="subtle" color="gray" aria-label={label}>
						<CurrentIcon size={16} />
					</ActionIcon>
				</Tooltip>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Label>{label}</Menu.Label>
				{LOD_LEVELS.map((level) => {
					const LevelIcon = lodIcon(level);
					return (
						<Menu.Item
							key={level}
							leftSection={<LevelIcon size={14} />}
							rightSection={
								<IconCheck size={14} style={{ visibility: level === lod ? "visible" : "hidden" }} />
							}
							onClick={() => onSelectLod(level)}
						>
							{t("lodSelectLevel", { level })}
						</Menu.Item>
					);
				})}
				{!isDefault && (
					<>
						<Menu.Divider />
						<Menu.Item leftSection={<IconPin size={14} />} onClick={onSetAsDefault}>
							{t("lodSetAsDefault")}
						</Menu.Item>
					</>
				)}
			</Menu.Dropdown>
		</Menu>
	);
}
