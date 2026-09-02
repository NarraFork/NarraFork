/**
 * vlist-text-file-row.tsx — The single icon + filename + size row used for a
 * text-file attachment. Shared by RenderMedia (assistant/tool media blocks) and
 * RenderMessageBubble (attachments inside a user bubble) so both draw the exact
 * chrome that `measure-media.TEXT_FILE_HEIGHT` reserves.
 *
 * Pure presentation at a caller-supplied height; no DOM measurement, no fetch.
 */

import { formatFileSize } from "@shared/text-file-types";
import { IMGGEN_GROUP_GAP, TEXT_FILE_ICON_SIZE } from "../measure/measure-media";
import { typographyMetrics } from "../pretext-fonts";

/**
 * Re-exported for callers that used to get it from this module's own copy.
 *
 * It used to BE a local copy "to keep render self-contained". That is no longer
 * safe: `measure-media.textFileRowNaturalWidth` now measures this exact string to
 * reserve the row's width, so two implementations that drift would reserve one
 * width and paint another — the row would overflow its committed single line with
 * nothing to signal it.
 */
export { formatFileSize };

export function TextFileRow({
	filename,
	size,
	height,
	width,
	onOpen,
	openLabel,
}: {
	filename: string;
	size: number | null;
	height: number;
	/**
	 * Exact painted width (px) the measure layer reserved for this row
	 * (`block.displayWidth`). It is what turns "the filename truncates" from an
	 * intention into a fact: `text-overflow: ellipsis` needs a bounded box, and
	 * `fit-content` inside an absolutely positioned parent is unbounded, so a long
	 * filename used to wrap — past the fixed single-line height the measure layer
	 * committed to — and collide with whatever the bubble painted underneath.
	 * Omitted → the row shrink-wraps its content (short names, unchanged).
	 */
	width?: number;
	/**
	 * Open this attachment in a read-only file panel. HEIGHT-NEUTRAL: it only adds
	 * a cursor + role to the SAME row box, so the measured `height` is unchanged.
	 */
	onOpen?: () => void;
	/** Accessible label / tooltip text for the clickable row. */
	openLabel?: string;
}) {
	return (
		<div
			style={{
				height,
				display: "flex",
				alignItems: "center",
				gap: IMGGEN_GROUP_GAP,
				cursor: onOpen ? "pointer" : undefined,
				width: width != null ? width : "fit-content",
				maxWidth: "100%",
				// Belt-and-braces with the per-part rules below: whatever the browser's
				// text metrics disagree with pretext about, it stays inside the reserved
				// single-line box rather than spilling onto the row beneath.
				overflow: "hidden",
			}}
			{...(onOpen
				? {
						role: "button",
						tabIndex: 0,
						title: openLabel,
						"aria-label": openLabel ? `${openLabel}: ${filename}` : filename,
						onClick: onOpen,
						onKeyDown: (event: React.KeyboardEvent) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onOpen();
							}
						},
					}
				: {})}
		>
			<div
				style={{
					width: TEXT_FILE_ICON_SIZE,
					height: TEXT_FILE_ICON_SIZE,
					flexShrink: 0,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					borderRadius: "var(--mantine-radius-sm)",
					background: "var(--mantine-color-gray-light)",
					color: "var(--mantine-color-gray-light-color)",
				}}
			>
				<FileGlyph />
			</div>
			<span
				// The filename is the ONLY part allowed to give way: the row is reserved
				// at a fixed single-line height, so a wrapped name would overflow a box
				// the measure layer already committed to (and paint over the next row).
				// `minWidth: 0` is what lets a flex item shrink below its content width.
				title={filename}
				style={{
					font: typographyMetrics().font.bodyMedium,
					color: "var(--mantine-color-text)",
					minWidth: 0,
					overflow: "hidden",
					whiteSpace: "nowrap",
					textOverflow: "ellipsis",
				}}
			>
				{filename}
			</span>
			{size != null ? (
				<span
					style={{
						font: typographyMetrics().font.xs,
						color: "var(--mantine-color-dimmed)",
						// Never let the size be the thing that wraps: the row is reserved at a
						// fixed TEXT_FILE_HEIGHT, so a "(1.5\nKB)" break would overflow a box
						// the measure layer already committed to.
						flexShrink: 0,
						whiteSpace: "nowrap",
					}}
				>
					({formatFileSize(size)})
				</span>
			) : null}
		</div>
	);
}

function FileGlyph() {
	// Simple inline file glyph (14px) — avoids importing the tabler icon set.
	return (
		<svg
			width={14}
			height={14}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			aria-hidden
		>
			<title>file</title>
			<path d="M14 3v4a1 1 0 0 0 1 1h4" />
			<path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
		</svg>
	);
}
