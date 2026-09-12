import { Box, SegmentedControl, Text } from "@mantine/core";
import { InlineOverrideActions } from "./InlineOverrideActions";
import {
	DANGER_REFLECTION_LEVEL_VALUES,
	type DangerReflectionLevel,
	type DangerReflectionOverride,
	formatDangerReflectionLevel,
} from "./reflection-types";

export function DangerReflectionMenuControl({
	visible,
	override,
	effectiveLevel,
	globalLevel,
	disabled,
	onChange,
	onFollowDefault,
	onSetAsDefault,
	t,
}: {
	visible: boolean;
	override: DangerReflectionOverride;
	effectiveLevel: DangerReflectionLevel;
	globalLevel: DangerReflectionLevel;
	disabled: boolean;
	onChange: (value: DangerReflectionOverride) => void;
	onFollowDefault: () => void;
	onSetAsDefault: () => void;
	t: (key: string) => string;
}) {
	if (!visible) return null;
	return (
		<Box px="sm" pb={8} onClick={(event) => event.stopPropagation()}>
			<Text size="xs" fw={600} mb={4}>
				{t("dangerReflectionShort")}
			</Text>
			<SegmentedControl
				size="xs"
				fullWidth
				value={effectiveLevel}
				onChange={(value) => {
					const level = value as DangerReflectionLevel;
					onChange(level === globalLevel ? "inherit" : level);
				}}
				disabled={disabled}
				data={DANGER_REFLECTION_LEVEL_VALUES.map((level) => ({
					value: level,
					label: formatDangerReflectionLevel(level, t),
				}))}
			/>
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
