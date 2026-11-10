import { Badge, type BadgeProps } from "@mantine/core";
import { OUTLINE_STATUS_TONE, type OutlineStatusKey } from "@shared/outline-status";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { STATUS_CLASS, STATUS_ICONS, STATUS_STROKE } from "./outline-icons";

/**
 * A task's state as its badge: the state's icon on its tinted background (`outline-icons.ts`).
 * The one React drawing of a state, wherever a view shows one: the read-only tree, the plan
 * trees, the task board, the transcript's task notices, the reports. The native frames (the live
 * editor, the mind map) draw the same element from the same map (`iconSvg`).
 *
 * `label` names the state for assistive technology; without one the badge is decoration (the
 * element around it says the state).
 */
export function OutlineStatusIcon({
	status,
	size = 16,
	label,
}: {
	status: OutlineStatusKey;
	/** The badge's side in px (its icon is inset by the background's padding). */
	size?: number | string;
	label?: string;
}) {
	const { Icon } = STATUS_ICONS[status];
	return (
		<Icon
			size={size}
			stroke={STATUS_STROKE}
			className={STATUS_CLASS}
			data-status={status}
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
		/>
	);
}

/**
 * A state said in words: a chip in the state's colour with the state's icon before the words
 * ("Locked · alice", "Waiting", "Newly done"). The chip is the background, so the icon inside it
 * is bare. A gray chip is outlined: a light gray one has a card's own background and vanishes.
 */
export const OutlineStatusChip = forwardRef<
	HTMLDivElement,
	Omit<BadgeProps, "color" | "leftSection"> & {
		status: OutlineStatusKey;
		children: ReactNode;
	} & Omit<ComponentPropsWithoutRef<"div">, "color" | "children">
>(function OutlineStatusChip({ status, children, variant, ...rest }, ref) {
	const { Icon } = STATUS_ICONS[status];
	const tone = OUTLINE_STATUS_TONE[status];
	return (
		<Badge
			ref={ref}
			size="xs"
			tt="none"
			variant={variant ?? (tone === "gray" ? "outline" : "light")}
			color={tone}
			leftSection={<Icon size={10} stroke={STATUS_STROKE} aria-hidden />}
			data-status-chip={status}
			{...rest}
		>
			{children}
		</Badge>
	);
});
