import { Box, Group, Switch, Text } from "@mantine/core";
import { InlineOverrideActions } from "./InlineOverrideActions";
import type { BooleanOverride } from "./reflection-types";

/**
 * One tri-state boolean reflection switch inside the permission-mode dropdown
 * (plan reflection, question reflection). The switch shows the EFFECTIVE value;
 * flipping it writes an explicit "on"/"off" override, and flipping it back to the
 * instance default collapses to "inherit" so later default changes still apply.
 */
export function ReflectionSwitchMenuControl({
	visible,
	label,
	override,
	effective,
	globalDefault,
	disabled,
	onChange,
	onFollowDefault,
	onSetAsDefault,
	t,
}: {
	visible: boolean;
	label: string;
	override: BooleanOverride;
	effective: boolean;
	globalDefault: boolean;
	disabled: boolean;
	onChange: (value: BooleanOverride) => void;
	onFollowDefault: () => void;
	onSetAsDefault: () => void;
	t: (key: string) => string;
}) {
	if (!visible) return null;
	return (
		<Box px="sm" py={6} onClick={(event) => event.stopPropagation()}>
			<Group justify="space-between" align="center" wrap="nowrap" gap="sm">
				<Text size="xs" fw={600}>
					{label}
				</Text>
				<Switch
					size="xs"
					checked={effective}
					disabled={disabled}
					onChange={(event) => {
						const checked = event.currentTarget.checked;
						onChange(checked === globalDefault ? "inherit" : checked ? "on" : "off");
					}}
				/>
			</Group>
			<InlineOverrideActions
				visible={override !== "inherit"}
				disabled={disabled}
				onFollowDefault={onFollowDefault}
				onSetAsDefault={onSetAsDefault}
				t={t}
			/>
		</Box>
	);
}
