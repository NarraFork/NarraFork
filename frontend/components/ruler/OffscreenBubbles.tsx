import { Box, Text } from "@mantine/core";
import { memo, useMemo } from "react";
import type { RulerEdge, RulerOrientation } from "./types";

interface OffscreenCard {
	id: string;
	title: string;
	/** World-space position */
	worldX: number;
	worldY: number;
	status: string;
	narratorStatus: string | null;
}

interface OffscreenBubblesProps {
	cards: OffscreenCard[];
	panX: number;
	panY: number;
	scale: number;
	viewportWidth: number;
	viewportHeight: number;
	rulerThickness: number;
	orientation?: RulerOrientation;
	edge?: RulerEdge;
	/** Called when user clicks a bubble — receives the world-space center of the group */
	onNavigate?: (worldX: number, worldY: number) => void;
}

type Direction = "top" | "bottom" | "left" | "right";

interface MergedBubble {
	/** First card ID (used as key) */
	key: string;
	count: number;
	titles: string[];
	screenX: number;
	screenY: number;
	direction: Direction;
	/** Average world position of all cards in this group */
	avgWorldX: number;
	avgWorldY: number;
	/** Dominant narrator status for coloring (most severe in group) */
	narratorStatus: string;
}

const BUBBLE_MARGIN = 8;
const BUBBLE_SIZE = 28;
const TOP_BADGE_HEIGHT = 32;
/** Bubbles within this screen-pixel distance get merged */
const MERGE_DISTANCE = 40;

/** Only show offscreen bubbles for cards whose narrator needs attention */
const BUBBLE_NARRATOR_STATUSES = new Set(["waiting", "unread", "error"]);

const BUBBLE_STATUS_COLORS: Record<string, { bg: string; border: string }> = {
	unread: {
		bg: "var(--mantine-color-green-7)",
		border: "var(--mantine-color-green-4)",
	},
	error: {
		bg: "var(--mantine-color-red-7)",
		border: "var(--mantine-color-red-4)",
	},
	waiting: {
		bg: "var(--mantine-color-yellow-7)",
		border: "var(--mantine-color-yellow-4)",
	},
};

export const OffscreenBubbles = memo(function OffscreenBubbles({
	cards,
	panX,
	panY,
	scale,
	viewportWidth,
	viewportHeight,
	rulerThickness,
	orientation = "horizontal",
	edge = "start",
	onNavigate,
}: OffscreenBubblesProps) {
	const bubbles = useMemo(() => {
		const isH = orientation === "horizontal";
		// Compute the canvas area (excluding the ruler track)
		let canvasTop = 0;
		let canvasLeft = 0;
		let canvasWidth = viewportWidth;
		let canvasHeight = viewportHeight;
		if (isH) {
			canvasHeight -= rulerThickness;
			if (edge === "start") canvasTop = rulerThickness;
		} else {
			canvasWidth -= rulerThickness;
			if (edge === "start") canvasLeft = rulerThickness;
		}

		// Step 1: compute raw bubble for each offscreen card
		// Only track cards whose narrator status needs attention
		const raw: Array<{
			id: string;
			title: string;
			screenX: number;
			screenY: number;
			direction: Direction;
			worldX: number;
			worldY: number;
			narratorStatus: string;
		}> = [];

		for (const card of cards) {
			const ns = card.narratorStatus;
			if (!ns || !BUBBLE_NARRATOR_STATUSES.has(ns)) continue;

			const sx = card.worldX * scale + panX;
			const sy = card.worldY * scale + panY;

			const isOffLeft = sx + 220 * scale < canvasLeft;
			const isOffRight = sx > canvasLeft + canvasWidth;
			const isOffTop = sy + 72 * scale < canvasTop;
			const isOffBottom = sy > canvasTop + canvasHeight;

			if (!isOffLeft && !isOffRight && !isOffTop && !isOffBottom) continue;

			let direction: Direction;
			let bx: number;
			let by: number;

			if (isOffTop && !isOffLeft && !isOffRight) {
				direction = "top";
				bx = Math.max(
					canvasLeft + BUBBLE_MARGIN,
					Math.min(canvasLeft + canvasWidth - BUBBLE_SIZE - BUBBLE_MARGIN, sx),
				);
				by = canvasTop + TOP_BADGE_HEIGHT + BUBBLE_MARGIN;
			} else if (isOffBottom && !isOffLeft && !isOffRight) {
				direction = "bottom";
				bx = Math.max(
					canvasLeft + BUBBLE_MARGIN,
					Math.min(canvasLeft + canvasWidth - BUBBLE_SIZE - BUBBLE_MARGIN, sx),
				);
				by = canvasTop + canvasHeight - BUBBLE_SIZE - BUBBLE_MARGIN;
			} else if (isOffLeft) {
				direction = "left";
				bx = canvasLeft + BUBBLE_MARGIN;
				by = Math.max(
					canvasTop + TOP_BADGE_HEIGHT + BUBBLE_MARGIN,
					Math.min(canvasTop + canvasHeight - BUBBLE_SIZE - BUBBLE_MARGIN, sy),
				);
			} else {
				direction = "right";
				bx = canvasLeft + canvasWidth - BUBBLE_SIZE - BUBBLE_MARGIN;
				by = Math.max(
					canvasTop + TOP_BADGE_HEIGHT + BUBBLE_MARGIN,
					Math.min(canvasTop + canvasHeight - BUBBLE_SIZE - BUBBLE_MARGIN, sy),
				);
			}

			raw.push({
				id: card.id,
				title: card.title,
				screenX: bx,
				screenY: by,
				direction,
				worldX: card.worldX,
				worldY: card.worldY,
				narratorStatus: ns,
			});
		}

		// Step 2: merge nearby bubbles with same direction
		const merged: MergedBubble[] = [];
		const used = new Set<number>();

		for (let i = 0; i < raw.length; i++) {
			if (used.has(i)) continue;
			used.add(i);
			const group = [raw[i]];

			for (let j = i + 1; j < raw.length; j++) {
				if (used.has(j)) continue;
				if (raw[j].direction !== raw[i].direction) continue;
				const dx = raw[j].screenX - raw[i].screenX;
				const dy = raw[j].screenY - raw[i].screenY;
				if (Math.sqrt(dx * dx + dy * dy) < MERGE_DISTANCE) {
					used.add(j);
					group.push(raw[j]);
				}
			}

			const avgSX = group.reduce((s, b) => s + b.screenX, 0) / group.length;
			const avgSY = group.reduce((s, b) => s + b.screenY, 0) / group.length;
			const avgWX = group.reduce((s, b) => s + b.worldX, 0) / group.length;
			const avgWY = group.reduce((s, b) => s + b.worldY, 0) / group.length;

			// Pick the most severe narrator status in the group: error > waiting > unread
			const statusPriority: Record<string, number> = { error: 2, waiting: 1, unread: 0 };
			let dominant = group[0].narratorStatus;
			for (const b of group) {
				if ((statusPriority[b.narratorStatus] ?? -1) > (statusPriority[dominant] ?? -1)) {
					dominant = b.narratorStatus;
				}
			}

			merged.push({
				key: group[0].id,
				count: group.length,
				titles: group.map((b) => b.title),
				screenX: avgSX,
				screenY: avgSY,
				direction: group[0].direction,
				avgWorldX: avgWX,
				avgWorldY: avgWY,
				narratorStatus: dominant,
			});
		}

		return merged;
	}, [cards, panX, panY, scale, viewportWidth, viewportHeight, rulerThickness, orientation, edge]);

	if (bubbles.length === 0) return null;

	return (
		<>
			{bubbles.map((b) => {
				const colors = BUBBLE_STATUS_COLORS[b.narratorStatus];
				return (
					<Box
						key={b.key}
						style={{
							position: "absolute",
							left: b.screenX,
							top: b.screenY,
							width: BUBBLE_SIZE,
							height: BUBBLE_SIZE,
							borderRadius: "50%",
							background: colors?.bg ?? "var(--mantine-color-indigo-7)",
							border: `2px solid ${colors?.border ?? "var(--mantine-color-indigo-4)"}`,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							zIndex: 15,
							cursor: "pointer",
							boxShadow: "0 2px 8px light-dark(rgba(0,0,0,0.15), rgba(0,0,0,0.4))",
						}}
						title={b.titles.join("\n")}
						onClick={() => onNavigate?.(b.avgWorldX, b.avgWorldY)}
					>
						<Text size="9px" c="white" fw={700}>
							{b.count > 1 ? b.count : directionArrow(b.direction)}
						</Text>
					</Box>
				);
			})}
		</>
	);
});

function directionArrow(d: Direction): string {
	switch (d) {
		case "top":
			return "↑";
		case "bottom":
			return "↓";
		case "left":
			return "←";
		case "right":
			return "→";
	}
}
