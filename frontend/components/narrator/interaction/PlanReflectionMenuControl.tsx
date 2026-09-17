import { Box, Group, Switch, Text } from "@mantine/core";
import { InlineOverrideActions } from "./InlineOverrideActions";
import type { BooleanOverride } from "./reflection-types";

export function PlanReflectionMenuControl({
	visible,
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
					{t("planReflectionShort")}
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
