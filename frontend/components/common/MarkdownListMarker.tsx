import { typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { Children, type CSSProperties, isValidElement, type ReactNode } from "react";

const SIZE = 12;

export function MarkdownTaskCheckbox({
	checked,
	label,
	style,
}: {
	checked: boolean;
	label?: string;
	style?: CSSProperties;
}) {
	return (
		<span
			className="vlist-task-checkbox"
			style={{
				position: "relative",
				display: "inline-block",
				width: SIZE,
				height: SIZE,
				flexShrink: 0,
				userSelect: "none",
				...style,
			}}
		>
			<input
				type="checkbox"
				checked={checked}
				disabled
				readOnly
				aria-hidden={label ? undefined : true}
				tabIndex={-1}
				{...(label ? { "aria-label": label } : {})}
				style={{
					position: "absolute",
					inset: 0,
					margin: 0,
					width: SIZE,
					height: SIZE,
					opacity: 0,
					pointerEvents: "none",
				}}
			/>
			<svg
				width={SIZE}
				height={SIZE}
				viewBox="0 0 12 12"
				aria-hidden="true"
				focusable="false"
				style={{ display: "block", pointerEvents: "none" }}
			>
				<rect
					x="0.75"
					y="0.75"
					width="10.5"
					height="10.5"
					rx="2"
					fill={checked ? "var(--mantine-primary-color-filled)" : "none"}
					stroke={checked ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-dimmed)"}
					strokeWidth="1.5"
				/>
				{checked ? (
					<path
						d="M3 6 5 8 9 4"
						fill="none"
						stroke="var(--mantine-color-white)"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				) : null}
			</svg>
		</span>
	);
}

/** Fits the existing 15px marker lane: 12px control + 3px text gap. */
export function MarkdownListMarker({
	block,
	top,
}: {
	block: {
		kind: string;
		lineHeight?: number;
		markerText: string | null;
		markerLeft: number | null;
		markerClassName?: string | null;
		taskMarker?: { checked: boolean; label: string };
	};
	top: number;
}) {
	if (block.markerText == null || block.markerLeft == null) return null;
	const task = block.taskMarker;
	if (!task) {
		return (
			<span
				className={block.markerClassName ?? undefined}
				style={{ position: "absolute", left: block.markerLeft, top }}
			>
				{block.markerText}
			</span>
		);
	}
	const lineHeight = block.lineHeight ?? typographyMetrics().line.body;
	return (
		<MarkdownTaskCheckbox
			checked={task.checked}
			label={task.label}
			style={{
				position: "absolute",
				left: block.markerLeft,
				top: top + Math.max(0, (lineHeight - SIZE) / 2),
			}}
		/>
	);
}

function isNativeTaskCheckbox(
	node: ReactNode,
): node is React.ReactElement<{ type?: string; checked?: boolean }> {
	if (!isValidElement<{ type?: string; checked?: boolean }>(node)) return false;
	return node.type === "input" && node.props.type === "checkbox";
}

/** Replace GFM's native checkbox while keeping the item text. */
export function MarkdownContentListItem({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	const nodes = Children.toArray(children);
	const native = nodes.find(isNativeTaskCheckbox);
	if (!native) return <li className={className}>{children}</li>;
	return (
		<li className={[className, "md-task-item"].filter(Boolean).join(" ")}>
			<MarkdownTaskCheckbox checked={!!native.props.checked} />
			<span className="md-task-item-body">
				{nodes.filter((node) => !isNativeTaskCheckbox(node))}
			</span>
		</li>
	);
}
