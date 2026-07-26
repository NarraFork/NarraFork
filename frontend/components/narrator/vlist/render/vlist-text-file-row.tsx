/**
 * vlist-text-file-row.tsx — The single icon + filename + size row used for a
 * text-file attachment. Shared by RenderMedia (assistant/tool media blocks) and
 * RenderMessageBubble (attachments inside a user bubble) so both draw the exact
 * chrome that `measure-media.TEXT_FILE_HEIGHT` reserves.
 *
 * Pure presentation at a caller-supplied height; no DOM measurement, no fetch.
 */

import { IMGGEN_GROUP_GAP, TEXT_FILE_ICON_SIZE } from "../measure/measure-media";
import { FONT_SIZE, SANS_FAMILY } from "../pretext-fonts";

/** Local copy of shared/text-file-types formatFileSize (keeps render self-contained). */
export function formatFileSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

export function TextFileRow({
	filename,
	size,
	height,
}: {
	filename: string;
	size: number | null;
	height: number;
}) {
	return (
		<div style={{ height, display: "flex", alignItems: "center", gap: IMGGEN_GROUP_GAP }}>
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
				style={{ font: `500 ${FONT_SIZE.sm}px ${SANS_FAMILY}`, color: "var(--mantine-color-text)" }}
			>
				{filename}
			</span>
			{size != null ? (
				<span
					style={{
						font: `400 ${FONT_SIZE.xs}px ${SANS_FAMILY}`,
						color: "var(--mantine-color-dimmed)",
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
