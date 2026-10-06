/**
 * category-chip.tsx — the ONE painting path for a tool category chip in vlist.
 *
 * Folded trace rows, a subagent card's recent-call rows, and an expanded tool
 * card header are the SAME lane at three LODs. They must share one component:
 * a second implementation (hand-rolled `--mantine-color-*-light` + shade-6)
 * looked like the same colour in source but resolved differently under Mantine's
 * `variantColorResolver`, so drilling in a Bash call changed the chip's tint.
 *
 * Height-neutral by contract: callers pass the measured tile size (14) and
 * supply the inner glyph (shared size 9); the component does no layout of its own.
 */

import { ThemeIcon } from "@mantine/core";
import type { ReactNode } from "react";

export interface CategoryChipProps {
	/** Mantine theme colour name from CATEGORY_COLOR (bash → "orange"). */
	color: string;
	/** Outer tile size in px — 14 for folded rows and card headers. */
	size: number;
	/** Category glyph node (callers size it with the shared inner-icon constant). */
	children: ReactNode;
	/**
	 * Stable data-* markers. Parity tests locate the same lane across renderers
	 * without relying on Mantine's generated class hashes.
	 */
	"data-trace-row-chip"?: boolean;
	"data-nf-card-header-chip"?: boolean;
	"data-testid"?: string;
}

/**
 * Always `ThemeIcon variant="light"` + the category colour + `radius="sm"`.
 * Never mix status colours into this chip — running/fail/cancelled live on the
 * status glyph and text shimmer, not on the category tile.
 */
export function CategoryChip({ color, size, children, ...dataAttrs }: CategoryChipProps) {
	return (
		<ThemeIcon {...dataAttrs} size={size} variant="light" color={color} radius="sm">
			{children}
		</ThemeIcon>
	);
}
