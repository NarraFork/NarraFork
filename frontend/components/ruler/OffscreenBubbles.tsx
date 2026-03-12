import { Box, Text } from "@mantine/core";
import { useMemo } from "react";

interface OffscreenCard {
	id: string;
	title: string;
	/** World-space position */
	worldX: number;
	worldY: number;
	status: string;
}

interface OffscreenBubblesProps {
	cards: OffscreenCard[];
	panX: number;
	panY: number;
	scale: number;
	viewportWidth: number;
	viewportHeight: number;
	rulerHeight: number;
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
}

const BUBBLE_MARGIN = 8;
const BUBBLE_SIZE = 28;
const TOP_BADGE_HEIGHT = 32;
/** Bubbles within this screen-pixel distance get merged */
const MERGE_DISTANCE = 40;

export function OffscreenBubbles({
	cards,
	panX,
	panY,
	scale,
	viewportWidth,
	viewportHeight,
	rulerHeight,
	onNavigate,
}: OffscreenBubblesProps) {
	const bubbles = useMemo(() => {
		const canvasHeight = viewportHeight - rulerHeight;

		// Step 1: compute raw bubble for each offscreen card
		const raw: Array<{
			id: string;
			title: string;
			screenX: number;
			screenY: number;
			direction: Direction;
			worldX: number;
			worldY: number;
		}> = [];

		for (const card of cards) {
			const sx = card.worldX * scale + panX;
			const sy = card.worldY * scale + panY;

			const isOffLeft = sx + 220 * scale < 0;
			const isOffRight = sx > viewportWidth;
			const isOffTop = sy + 72 * scale < 0;
			const isOffBottom = sy > canvasHeight;

			if (!isOffLeft && !isOffRight && !isOffTop && !isOffBottom) continue;

			let direction: Direction;
			let bx: number;
			let by: number;

			if (isOffTop && !isOffLeft && !isOffRight) {
				direction = "top";
				bx = Math.max(BUBBLE_MARGIN, Math.min(viewportWidth - BUBBLE_SIZE - BUBBLE_MARGIN, sx));
				by = TOP_BADGE_HEIGHT + BUBBLE_MARGIN;
			} else if (isOffBottom && !isOffLeft && !isOffRight) {
				direction = "bottom";
				bx = Math.max(BUBBLE_MARGIN, Math.min(viewportWidth - BUBBLE_SIZE - BUBBLE_MARGIN, sx));
				by = canvasHeight - BUBBLE_SIZE - BUBBLE_MARGIN;
			} else if (isOffLeft) {
				direction = "left";
				bx = BUBBLE_MARGIN;
				by = Math.max(
					TOP_BADGE_HEIGHT + BUBBLE_MARGIN,
					Math.min(canvasHeight - BUBBLE_SIZE - BUBBLE_MARGIN, sy),
				);
			} else {
				direction = "right";
				bx = viewportWidth - BUBBLE_SIZE - BUBBLE_MARGIN;
				by = Math.max(
					TOP_BADGE_HEIGHT + BUBBLE_MARGIN,
					Math.min(canvasHeight - BUBBLE_SIZE - BUBBLE_MARGIN, sy),
				);
			}

			raw.push({
				id: card.id,
				title: card.title,
				screenX: bx,
				screenY: by + rulerHeight,
				direction,
				worldX: card.worldX,
				worldY: card.worldY,
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

			merged.push({
				key: group[0].id,
				count: group.length,
				titles: group.map((b) => b.title),
				screenX: avgSX,
				screenY: avgSY,
				direction: group[0].direction,
				avgWorldX: avgWX,
				avgWorldY: avgWY,
			});
		}

		return merged;
	}, [cards, panX, panY, scale, viewportWidth, viewportHeight, rulerHeight]);

	if (bubbles.length === 0) return null;

	return (
		<>
			{bubbles.map((b) => (
				<Box
					key={b.key}
					style={{
						position: "absolute",
						left: b.screenX,
						top: b.screenY,
						width: BUBBLE_SIZE,
						height: BUBBLE_SIZE,
						borderRadius: "50%",
						background: "var(--mantine-color-indigo-7)",
						border: "2px solid var(--mantine-color-indigo-4)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						zIndex: 15,
						cursor: "pointer",
						boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
					}}
					title={b.titles.join("\n")}
					onClick={() => onNavigate?.(b.avgWorldX, b.avgWorldY)}
				>
					<Text size="9px" c="white" fw={700}>
						{b.count > 1 ? b.count : directionArrow(b.direction)}
					</Text>
				</Box>
			))}
		</>
	);
}

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
