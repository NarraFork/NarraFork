import { Menu, NativeSelect, Tooltip } from "@mantine/core";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInputMenu } from "../../../hooks/useInputMenu";
import { ReasoningEffortMenuItems } from "../interaction/ReasoningEffortMenuItems";

/**
 * The reasoning-effort picker, detached from a session.
 *
 * Mirrors {@link ModelPickerMenu}: the same compact select-style trigger and the
 * same menu items the narrator status bar renders, but the choice is the caller's
 * local state because there is no narrator to mutate yet. The follow-default /
 * set-as-default links the status bar appends are omitted on purpose — they act on
 * a stored override, and a session that does not exist has none.
 */
export function ReasoningEffortPickerMenu({
	value,
	options,
	onChange,
	onFollowDefault,
	position = "bottom-start",
}: {
	value: string;
	options: readonly ReasoningEffort[];
	onChange: (effort: string) => void;
	/**
	 * Clears an explicit pick so the tier follows the instance default again. Omit
	 * it while the value already is that default — there is nothing to clear, and
	 * the entry would be a no-op.
	 */
	onFollowDefault?: () => void;
	position?: "bottom-start" | "top-end";
}) {
	const { t } = useTranslation("narrator");
	const inputMenu = useInputMenu();
	const [opened, setOpened] = useState(false);

	// A model with no tiers gets no menu at all (the status bar hides it too), and
	// an empty value would render an option-less native select.
	if (options.length === 0 || !value) return null;

	return (
		<Tooltip label={t("reasoningEffort")} disabled={opened}>
			<Menu position={position} {...inputMenu.menuProps} opened={opened} onChange={setOpened}>
				<Menu.Target>
					<NativeSelect
						{...inputMenu.targetProps}
						size="xs"
						aria-label={t("reasoningEffort")}
						// The menu renders every tier; the trigger only needs the selected one
						// so its native width does not jump between tiers.
						data={[{ value, label: t(`reasoning_${value}`) }]}
						value={value}
						onChange={() => {}}
						onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
						style={{ pointerEvents: "auto", minWidth: 0 }}
					/>
				</Menu.Target>
				<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto" }}>
					<ReasoningEffortMenuItems
						currentEffort={value}
						options={options}
						onSelect={onChange}
						t={t}
					/>
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
