import { Menu } from "@mantine/core";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { IconCheck } from "@tabler/icons-react";

export function ReasoningEffortMenuItems({
	currentEffort,
	options,
	onSelect,
	t,
}: {
	currentEffort: string | null | undefined;
	options: readonly ReasoningEffort[];
	onSelect: (effort: string) => void;
	t: (key: string) => string;
}) {
	// No "auto" item: follow/override state is expressed by the inline
	// "follow default / set as default" links below (matching the permission
	// and reflection menus). Selecting a tier writes an explicit override.
	return (
		<>
			<Menu.Label>{t("reasoningEffort")}</Menu.Label>
			{options.map((effort) => {
				const selected = currentEffort === effort;
				return (
					<Menu.Item
						key={effort}
						onClick={() => onSelect(effort)}
						rightSection={
							<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
						}
						fw={selected ? 600 : 400}
					>
						{t(`reasoning_${effort}`)}
					</Menu.Item>
				);
			})}
		</>
	);
}
