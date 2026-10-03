import { Box, Group, Switch, Text } from "@mantine/core";
import type { NarratorStatusToolbarAction } from "../header/NarratorStatusToolbar";
import type { BooleanOverride } from "./reflection-types";

export interface PlanReflectionStatusControlProps {
	hasPlanTrait: boolean;
	supported: boolean;
	isWorkspacePreview: boolean;
	effective: boolean;
	globalDefault: boolean;
	disabled: boolean;
	onChange: (value: BooleanOverride) => void;
	t: (key: string) => string;
	mode?: "inline" | "menu";
}

/** A single-line control that fits within the existing 30px status row. */
export function PlanReflectionStatusControl({
	hasPlanTrait,
	supported,
	isWorkspacePreview,
	effective,
	globalDefault,
	disabled,
	onChange,
	t,
	mode = "inline",
}: PlanReflectionStatusControlProps) {
	if (!hasPlanTrait || !supported || isWorkspacePreview) return null;
	const label = t(effective ? "planReflectionApprovalOn" : "planReflectionApprovalOff");
	const control = (
		<Group
			gap={6}
			align="center"
			wrap="nowrap"
			data-testid="plan-reflection-status-control"
			style={{ flexShrink: 0, height: 22 }}
		>
			<Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap", lineHeight: 1 }}>
				{label}
			</Text>
			<Switch
				size="xs"
				aria-label={label}
				checked={effective}
				disabled={disabled}
				onChange={(event) => {
					const checked = event.currentTarget.checked;
					onChange(checked === globalDefault ? "inherit" : checked ? "on" : "off");
				}}
			/>
		</Group>
	);
	// A switch must remain independently focusable, not nested in a Menu.Item button.
	return mode === "menu" ? (
		<Box px="sm" py={6} onClick={(event) => event.stopPropagation()}>
			{control}
		</Box>
	) : (
		control
	);
}

/** Include the measured control in overflow budgeting on both desktop and mobile. */
export function createPlanReflectionStatusAction(
	props: PlanReflectionStatusControlProps,
): NarratorStatusToolbarAction | null {
	if (!props.hasPlanTrait || !props.supported || props.isWorkspacePreview) return null;
	return {
		key: "plan-reflection",
		collapsePriority: 5,
		render: (mode) => <PlanReflectionStatusControl {...props} mode={mode} />,
	};
}
