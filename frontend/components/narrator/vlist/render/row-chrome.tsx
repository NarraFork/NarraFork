/**
 * row-chrome.tsx — Plain-element stand-ins for the Mantine primitives a row header
 * paints once per mounted virtual-list row.
 *
 * Every Mantine component renders through `Box`, which parses style props, reads the
 * theme and resolves responsive styles on each mount. A trace row's title line alone
 * used ~8 of them; during a fast history scroll that per-row setup was the largest
 * remaining Mantine cost. These helpers keep the exact computed styles — the CSS
 * classes copy Mantine's rules, and spacing goes through Mantine's own `rem()` like
 * the `gap` / `py` props did — with a plain `div` / `p` / `span` / `button`.
 */

import { type MantineTheme, rem, useMantineTheme } from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";
import "./row-chrome.css";

/** `<Group wrap="nowrap" align="center">` */
export const ROW_FLEX_CLASS = "nf-row-flex";
/**
 * `<Text size="xs">` (add `data-truncate` for `truncate`). `c="dimmed"` stays an INLINE
 * colour, as Mantine emits it, so it keeps winning over a shimmer class exactly as before.
 */
export const ROW_TEXT_CLASS = "nf-row-text";
/** `<UnstyledButton>` root, plus the theme's focus ring class it opts into. */
export const ROW_BUTTON_CLASS = "nf-row-button mantine-focus-auto";

/** Mantine spacing for a numeric prop (`gap={6}`, `py={1}`). */
export const rowSpacing = (value: number): string => rem(value);

/** The `gap` / `py` part of a `<Group gap={gap} py={paddingY}>`. */
export function rowFlexStyle(gap: number, paddingY?: number): CSSProperties {
	return paddingY === undefined
		? { gap: rowSpacing(gap) }
		: { gap: rowSpacing(gap), paddingBlock: rowSpacing(paddingY) };
}

type ChipColors = { background: string; color: string; border: string };
const chipColorCache = new WeakMap<MantineTheme, Map<string, ChipColors>>();

/** The theme's own `light` variant colours, resolved once per (theme, colour). */
function lightColors(theme: MantineTheme, color: string): ChipColors {
	let byColor = chipColorCache.get(theme);
	if (!byColor) {
		byColor = new Map();
		chipColorCache.set(theme, byColor);
	}
	let colors = byColor.get(color);
	if (!colors) {
		const resolved = theme.variantColorResolver({ color, theme, variant: "light" });
		colors = {
			background: resolved.background,
			color: resolved.color,
			border: resolved.border,
		};
		byColor.set(color, colors);
	}
	return colors;
}

export interface RowChipProps {
	/** Mantine theme colour name (bash → "orange"). */
	color: string;
	/** Tile size in px, as passed to `ThemeIcon size`. */
	size: number;
	children: ReactNode;
	"data-trace-row-chip"?: boolean;
	"data-nf-card-header-chip"?: boolean;
	"data-testid"?: string;
}

/** `<ThemeIcon size={size} variant="light" color={color} radius="sm">` */
export function RowChip({ color, size, children, ...dataAttrs }: RowChipProps) {
	const colors = lightColors(useMantineTheme(), color);
	const side = rem(size);
	return (
		<div
			{...dataAttrs}
			className="nf-row-chip"
			style={{
				width: side,
				height: side,
				minWidth: side,
				minHeight: side,
				background: colors.background,
				color: colors.color,
				border: colors.border,
			}}
		>
			{children}
		</div>
	);
}
