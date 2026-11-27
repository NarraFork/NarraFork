/**
 * RenderTeamRow.tsx — Paint the team page's opt-in chip and divider rows (see
 * `measure/measure-team-row.ts`). Each paints a box of exactly `measured.height` with its one
 * nowrap line centred, so paint equals the prediction at every font scale.
 */

import { IconAlertCircleFilled, IconBan, IconCheck, IconChevronRight } from "@tabler/icons-react";
import type { MeasuredTeamChip, MeasuredTeamEvent } from "../measure/measure-team-row";
import { activateOnKey, swallowSelectionClick } from "./key-activate";
import { ROW_TEXT_CLASS } from "./row-chrome";

const DIMMED = "var(--mantine-color-dimmed)";

const TONE_COLOR: Record<MeasuredTeamEvent["data"]["tone"], string> = {
	ok: "var(--mantine-color-green-text)",
	warn: "var(--mantine-color-orange-text)",
	neutral: DIMMED,
};

export function RenderTeamChip({
	measured,
	onToggle,
}: {
	measured: MeasuredTeamChip;
	onToggle?: () => void;
}) {
	const { data, expanded } = measured;
	const failed = data.failed > 0;
	const cancelled = (data.cancelled ?? 0) > 0;
	return (
		<div
			style={{
				height: measured.height,
				display: "flex",
				alignItems: "center",
				minWidth: 0,
			}}
		>
			<button
				type="button"
				data-testid="team-chip"
				data-expanded={expanded ? "true" : "false"}
				aria-expanded={expanded}
				disabled={!onToggle}
				onClick={onToggle ? swallowSelectionClick(onToggle) : undefined}
				onKeyDown={onToggle ? activateOnKey(onToggle) : undefined}
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: 5,
					maxWidth: "100%",
					minWidth: 0,
					padding: "2px 8px",
					border: 0,
					borderRadius: 4,
					background: "var(--mantine-color-default-hover)",
					color: DIMMED,
					cursor: onToggle ? "pointer" : "default",
					font: "inherit",
				}}
			>
				{failed ? (
					<span
						data-testid="team-chip-error"
						title={data.failedLabel}
						role="img"
						aria-label={data.failedLabel}
						style={{ display: "inline-flex", flexShrink: 0 }}
					>
						<IconAlertCircleFilled size={13} style={{ color: "var(--mantine-color-red-text)" }} />
					</span>
				) : cancelled ? (
					<span
						data-testid="team-chip-cancelled"
						title={data.cancelledLabel}
						role="img"
						aria-label={data.cancelledLabel}
						style={{ display: "inline-flex", flexShrink: 0 }}
					>
						<IconBan size={13} style={{ color: DIMMED }} />
					</span>
				) : (
					<IconCheck
						size={13}
						style={{ color: "var(--mantine-color-green-text)", flexShrink: 0 }}
					/>
				)}
				<span
					className={ROW_TEXT_CLASS}
					data-truncate
					style={{ color: DIMMED, minWidth: 0 }}
					title={
						[`${data.label}${data.countLabel}`, data.failedLabel, data.cancelledLabel]
							.filter(Boolean)
							.join(" · ") || undefined
					}
				>
					{data.label}
					{data.countLabel}
				</span>
				<IconChevronRight
					size={12}
					style={{
						flexShrink: 0,
						transform: expanded ? "rotate(90deg)" : undefined,
						transition: "transform 120ms ease",
					}}
				/>
			</button>
		</div>
	);
}

export function RenderTeamEvent({ measured }: { measured: MeasuredTeamEvent }) {
	const { data } = measured;
	const line = {
		flex: 1,
		minWidth: 12,
		height: 1,
		background: "var(--mantine-color-default-border)",
	};
	return (
		<div
			data-testid="team-event"
			style={{
				height: measured.height,
				display: "flex",
				alignItems: "center",
				gap: 10,
				minWidth: 0,
			}}
		>
			<span style={line} />
			<span
				aria-hidden
				style={{
					width: 6,
					height: 6,
					borderRadius: 3,
					flexShrink: 0,
					background: TONE_COLOR[data.tone] ?? DIMMED,
				}}
			/>
			<span
				className={ROW_TEXT_CLASS}
				data-truncate
				style={{ color: DIMMED, minWidth: 0, flexShrink: 1 }}
			>
				{data.text}
			</span>
			<span style={line} />
		</div>
	);
}
