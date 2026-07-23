/**
 * RenderSystemList.tsx — Render copy of the linearly-sized knowledge_hint system
 * card measured by measure-system-list.ts (batch-2 P6).
 *
 * The card is a heading line plus N entry lines, EVERY one clamped to a single
 * line (truncate), so there is no inline/code materialization: the root is a
 * fixed-height container (height === measured.height) and each row is a clamped
 * <Text>. Visuals mirror the original MessageBubble KnowledgeHintNotice
 * (Paper p="xs" + IconNotebook + Stack of heading + indigo entry links) using
 * Mantine primitives + @tabler icons — WITHOUT importing anything outside
 * vlist/.
 *
 * The real navigation (useNavigate → /knowledge/$entryId) lives outside vlist/,
 * so callers may inject an `onOpenEntry` handler; otherwise the entries render
 * as static (non-clickable) lines. Zero DOM measurement (heights come from the
 * measure layer).
 */

import { Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconNotebook } from "@tabler/icons-react";
import {
	CARD_PADDING,
	type KnowledgeHintData,
	type KnowledgeHintEntry,
	STACK_GAP,
} from "../measure/measure-system-list";
import type { MeasuredElement, PreparedFixedBlock } from "../prepared-block";

/** Matches the original SYSTEM_MESSAGE_BG in MessageBubble.tsx (copied, not imported). */
const SYSTEM_MESSAGE_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

interface RenderSystemListProps {
	measured: MeasuredElement;
	/**
	 * Optional click handler for an entry (navigation lives outside vlist/). When
	 * omitted the entry lines are rendered static / non-interactive.
	 */
	onOpenEntry?: (entryId: string) => void;
}

/**
 * Render a knowledge_hint card from its MeasuredElement. The single prepared
 * block carries the heading + entries payload; the row heights are fixed by the
 * measure layer, so this just paints (1 + N) clamped lines inside a Paper.
 */
export function RenderSystemList({ measured, onOpenEntry }: RenderSystemListProps) {
	const block = measured.blocks[0] as PreparedFixedBlock | undefined;
	if (!block || block.kind !== "fixed") return null;
	const data = (block.data ?? {}) as unknown as KnowledgeHintData;
	const entries: KnowledgeHintEntry[] = Array.isArray(data.entries) ? data.entries : [];
	const height = measured.height;

	return (
		<Paper
			p="xs"
			radius="sm"
			style={{ backgroundColor: SYSTEM_MESSAGE_BG, height, boxSizing: "border-box" }}
		>
			<Group gap={6} wrap="nowrap" align="flex-start" h="100%">
				<IconNotebook
					size={14}
					style={{ flexShrink: 0, marginTop: 2, color: "var(--mantine-color-dimmed)" }}
				/>
				<Stack gap={STACK_GAP} style={{ flex: 1, minWidth: 0 }}>
					<Text size="xs" c="dimmed" fw={600} truncate>
						{data.heading}
					</Text>
					{entries.map((e) => {
						const label = e.title || e.entryId;
						const clickable = typeof onOpenEntry === "function";
						return (
							<Tooltip
								key={e.entryId}
								label={e.summary || e.title || e.entryId}
								multiline
								maw={360}
								withinPortal
								openDelay={300}
							>
								<Text
									size="xs"
									c="indigo"
									truncate
									style={clickable ? { cursor: "pointer" } : undefined}
									onClick={clickable ? () => onOpenEntry?.(e.entryId) : undefined}
								>
									{label}
								</Text>
							</Tooltip>
						);
					})}
				</Stack>
			</Group>
		</Paper>
	);
}

export const RENDER_SYSTEM_LIST_CHROME = { CARD_PADDING, STACK_GAP } as const;
