/**
 * The permission form's button row, with keyboard-driven focus (shared by the plain permission
 * form and an outline plan's approval, `OutlinePlanApproval`).
 */
import { Button, Group, Text } from "@mantine/core";
import { type CSSProperties, useEffect } from "react";

export interface PermButton {
	label: string;
	color: string;
	variant?: string;
	onClick: () => void;
}

/**
 * Renders a row of permission buttons with keyboard-driven focus highlight.
 * Reports button count to the parent via setButtonCount so the global
 * keydown handler knows the navigation range.
 */
export function PermButtonBar({
	buttons,
	focusIndex,
	setButtonCount,
	registerActions,
}: {
	buttons: PermButton[];
	focusIndex: number | null;
	setButtonCount: (n: number) => void;
	registerActions: (actions: (() => void)[]) => void;
}) {
	useEffect(() => {
		setButtonCount(buttons.length);
		registerActions(buttons.map((b) => b.onClick));
	}, [buttons, setButtonCount, registerActions]);

	return (
		<Group gap="sm">
			{buttons.map((btn, i) => {
				const focused = focusIndex === i;
				return (
					<Button
						key={`${btn.label}-${btn.color}`}
						size="sm"
						color={btn.color}
						variant={btn.variant as "light" | "subtle" | undefined}
						onClick={btn.onClick}
						className={focused ? "perm-btn-pulse" : undefined}
						style={
							focused
								? ({
										"--perm-pulse-color": `var(--mantine-color-${btn.color}-filled)`,
									} as CSSProperties)
								: undefined
						}
					>
						{btn.label}
						{focused && (
							<Text span size="xs" ml={4} opacity={0.7}>
								⏎
							</Text>
						)}
					</Button>
				);
			})}
		</Group>
	);
}
