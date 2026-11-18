/**
 * RenderSubagentRecovery.tsx — Render copy of the post-error "resume subagents"
 * card measured by measure-subagent-recovery.ts.
 *
 * Every row is clamped to a single line, so the root is a fixed-height container
 * (height === measured.height) and each row is a clamped <Text>. Visuals mirror
 * SubagentRecoveryCard.tsx using Mantine primitives + @tabler icons WITHOUT
 * importing anything outside vlist/.
 *
 * The mutation itself lives outside vlist/, so callers inject `onToggleRow`,
 * `onResume` and `onDismiss`; without them the card renders as an inert visual
 * copy. Zero DOM measurement — all heights come from the measure layer.
 */

import {
	Badge,
	Button,
	Checkbox,
	CloseButton,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconRefreshAlert } from "@tabler/icons-react";
import {
	CARD_PADDING,
	CLOSE_BUTTON_SIZE,
	HEADER_INNER_GAP,
	ROW_GAP,
	ROW_HEIGHT,
	rowHeight,
	type SubagentRecoveryData,
	type SubagentRecoveryRow,
} from "../measure/measure-subagent-recovery";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";

const RESOLVED_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

interface RenderSubagentRecoveryProps {
	measured: MeasuredElement;
	/** Toggle the checkbox at `rowIndex`. Omit to render read-only. */
	onToggleRow?: (rowIndex: number) => void;
	/** Submit the selection in the given mode. Omit to render read-only. */
	onResume?: (mode: "notify" | "watch") => void;
	/**
	 * Withdraw the offer without resuming anything. Omit to paint no close button at
	 * all (read-only shares have nothing to dismiss).
	 */
	onDismiss?: () => void;
}

export function RenderSubagentRecovery({
	measured,
	onToggleRow,
	onResume,
	onDismiss,
}: RenderSubagentRecoveryProps) {
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	const data = (block.data ?? {}) as unknown as SubagentRecoveryData & { deselected?: number[] };
	const rows: SubagentRecoveryRow[] = Array.isArray(data.subagents) ? data.subagents : [];
	const height = measured.height;

	if (data.kind === "resolved") {
		return (
			<Paper
				p="xs"
				radius="sm"
				style={{ backgroundColor: RESOLVED_BG, height, boxSizing: "border-box" }}
			>
				<Group gap={6} wrap="nowrap" h="100%">
					<IconRefreshAlert
						size={14}
						style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }}
					/>
					<Text size="xs" c="dimmed" truncate>
						{data.summary ?? data.title}
					</Text>
				</Group>
			</Paper>
		);
	}

	// Everything starts selected; the tracked set holds the rows the user unchecked.
	const deselected = new Set(Array.isArray(data.deselected) ? data.deselected : []);
	const selectedCount = rows.length - deselected.size;
	const interactive = typeof onResume === "function";

	return (
		<Paper
			p="sm"
			radius="sm"
			style={{
				backgroundColor: "var(--mantine-color-orange-light)",
				height,
				boxSizing: "border-box",
			}}
		>
			<Stack gap="xs" h="100%">
				<Group gap={6} wrap="nowrap" align="flex-start">
					<IconRefreshAlert
						size={16}
						style={{ flexShrink: 0, marginTop: 1, color: "var(--mantine-color-orange-7)" }}
					/>
					<Stack gap={HEADER_INNER_GAP} style={{ flex: 1, minWidth: 0 }}>
						<Text size="xs" fw={600} c="orange.9" truncate>
							{data.title}
						</Text>
						<Text size="xs" c="orange.9" truncate>
							{data.description}
						</Text>
					</Stack>
					{onDismiss ? (
						// Rides inside the header lane, which the measure layer already
						// reserves taller than the button — no height change. The box is
						// the measured CLOSE_BUTTON_SIZE, not a Mantine size token, so a
						// resized button can never drift past what was reserved.
						<Tooltip label={data.dismissLabel ?? ""} withArrow disabled={!data.dismissLabel}>
							<CloseButton
								size={CLOSE_BUTTON_SIZE}
								variant="subtle"
								color="orange.7"
								style={{ flexShrink: 0 }}
								aria-label={data.dismissLabel}
								onClick={onDismiss}
							/>
						</Tooltip>
					) : null}
				</Group>

				{rows.length > 0 && (
					<Stack gap={ROW_GAP}>
						{rows.map((row, index) => (
							<Group key={row.id} gap={6} wrap="nowrap" style={{ height: rowHeight() }}>
								<Checkbox
									size="xs"
									checked={!deselected.has(index)}
									readOnly={!onToggleRow}
									onChange={onToggleRow ? () => onToggleRow(index) : undefined}
								/>
								<Text size="xs" c="orange.9" truncate style={{ maxWidth: 320 }}>
									{row.title}
								</Text>
								<Badge size="xs" variant="light" color="gray">
									{row.subagentType}
								</Badge>
								{row.wasForeground && data.backgroundBadge && (
									<Badge size="xs" variant="light" color="orange">
										{data.backgroundBadge}
									</Badge>
								)}
							</Group>
						))}
					</Stack>
				)}

				<Group justify="flex-end" gap="xs">
					<Button
						size="compact-sm"
						variant="light"
						color="orange"
						disabled={!interactive || selectedCount === 0}
						onClick={interactive ? () => onResume?.("notify") : undefined}
					>
						{data.notifyLabel}
					</Button>
					<Button
						size="compact-sm"
						color="orange"
						disabled={!interactive || selectedCount === 0}
						onClick={interactive ? () => onResume?.("watch") : undefined}
					>
						{data.waitLabel}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}

export const RENDER_SUBAGENT_RECOVERY_CHROME = { CARD_PADDING, ROW_GAP, ROW_HEIGHT } as const;
