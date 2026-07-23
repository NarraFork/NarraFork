/**
 * RenderMedia.tsx — Render copies for the three media blocks measured by
 * measure-media.ts (image / text_file / image_generation). Draws each
 * MeasuredElement at the exact geometry the measure layer computed, using
 * absolute positioning — no reflow, no DOM measurement (the image-unknown
 * placeholder keeps the reserved height; the owning integration layer may do a
 * one-time local refine, the single controlled exception).
 *
 * Image loading (blob fetch / preview URL) is intentionally delegated to an
 * optional `resolveImageSrc` callback injected by the integration layer, so
 * this render copy stays pure and unit-testable. Reference template:
 * RenderMarkdown.tsx / RenderMessageBubble.tsx.
 */

import {
	materializeRichInlineLineRange,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { useMemo } from "react";
import {
	IMGGEN_GROUP_GAP,
	IMGGEN_ICON_SIZE,
	IMGGEN_LOADER_SIZE,
	IMGGEN_PAPER_PADDING,
	TEXT_FILE_ICON_SIZE,
} from "../measure/measure-media";
import type {
	BlockFrame,
	MeasuredElement,
	PreparedFixedBlock,
	PreparedInlineBlock,
} from "../prepared-block";
import { FONT_SIZE, SANS_FAMILY } from "../pretext-fonts";

/** How the integration layer turns a media block's data into an <img> src. */
export type ResolveImageSrc = (tag: string, data: Record<string, unknown>) => string | null;

interface RenderMediaProps {
	measured: MeasuredElement;
	/** Optional callback returning a usable image URL for a block's data. */
	resolveImageSrc?: ResolveImageSrc;
	/** Localized "generating" flag for the header loader (image_generation). */
	generating?: boolean;
}

/**
 * Render a measured media element. The block tag on the (single, for
 * image/text_file) fixed block decides which drawing routine runs; the
 * image_generation element has a header inline block + an image block.
 */
export function RenderMedia({ measured, resolveImageSrc, generating }: RenderMediaProps) {
	const { blocks, frame } = measured;
	const first = blocks[0];

	// image_generation: Paper chrome wrapping header + image area.
	if (first?.kind === "inline") {
		return (
			<RenderImageGeneration
				measured={measured}
				resolveImageSrc={resolveImageSrc}
				generating={generating}
			/>
		);
	}

	// image / text_file: a single fixed block.
	if (first?.kind === "fixed") {
		if (first.tag === "image") {
			return (
				<div style={{ position: "relative", height: frame.contentHeight }}>
					<ImageFixedView
						block={first}
						frame={frame.blocks[0]!}
						resolveImageSrc={resolveImageSrc}
					/>
				</div>
			);
		}
		if (first.tag === "text_file") {
			return (
				<div style={{ position: "relative", height: frame.contentHeight }}>
					<TextFileView block={first} frame={frame.blocks[0]!} />
				</div>
			);
		}
	}
	return null;
}

// ── image ────────────────────────────────────────────────────────────────────
function ImageFixedView({
	block,
	frame,
	resolveImageSrc,
}: {
	block: PreparedFixedBlock;
	frame: BlockFrame;
	resolveImageSrc?: ResolveImageSrc;
}) {
	const src = resolveImageSrc?.(block.tag, block.data ?? {}) ?? null;
	const filename = typeof block.data?.filename === "string" ? block.data.filename : "image";
	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: 0,
				height: block.height,
				maxWidth: "100%",
				width: "fit-content",
				borderRadius: "var(--mantine-radius-sm)",
				overflow: "hidden",
				margin: "0 auto",
			}}
		>
			{src ? (
				<img
					src={src}
					alt={filename}
					style={{ height: block.height, width: "auto", maxWidth: "100%", objectFit: "contain" }}
					loading="lazy"
				/>
			) : (
				<div
					style={{
						height: block.height,
						width: 300,
						maxWidth: "100%",
						borderRadius: "var(--mantine-radius-sm)",
						background: "var(--mantine-color-dark-6)",
					}}
				/>
			)}
		</div>
	);
}

// ── text_file ──────────────────────────────────────────────────────────────
function TextFileView({ block, frame }: { block: PreparedFixedBlock; frame: BlockFrame }) {
	const filename = typeof block.data?.filename === "string" ? block.data.filename : "";
	const size = typeof block.data?.size === "number" ? block.data.size : null;
	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: 0,
				height: block.height,
				display: "flex",
				alignItems: "center",
				gap: IMGGEN_GROUP_GAP,
			}}
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

/** Local copy of shared/text-file-types formatFileSize (keep render self-contained). */
function formatFileSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

// ── image_generation ─────────────────────────────────────────────────────────
function RenderImageGeneration({
	measured,
	resolveImageSrc,
	generating,
}: {
	measured: MeasuredElement;
	resolveImageSrc?: ResolveImageSrc;
	generating?: boolean;
}) {
	const { blocks, frame, contentWidth } = measured;
	const header = blocks[0] as PreparedInlineBlock;
	const headerFrame = frame.blocks[0]!;
	const imageBlock = blocks[1];
	const imageFrame = frame.blocks[1];

	const loaderWidth = generating ? IMGGEN_LOADER_SIZE + IMGGEN_GROUP_GAP : 0;
	const iconArea = IMGGEN_ICON_SIZE + IMGGEN_GROUP_GAP + loaderWidth;

	return (
		<div
			style={{
				position: "relative",
				padding: IMGGEN_PAPER_PADDING,
				border: "1px solid var(--mantine-color-dark-4)",
				borderRadius: "var(--mantine-radius-sm)",
				boxSizing: "border-box",
			}}
		>
			<div style={{ position: "relative", height: frame.contentHeight }}>
				{/* Header row: icon (+ loader) at left, wrapping status/prompt text. */}
				<div
					style={{
						position: "absolute",
						top: headerFrame.top,
						left: 0,
						width: IMGGEN_ICON_SIZE,
						height: IMGGEN_ICON_SIZE,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						borderRadius: "var(--mantine-radius-sm)",
						background: "var(--mantine-color-violet-light)",
						color: "var(--mantine-color-violet-light-color)",
					}}
				>
					<PhotoGlyph />
				</div>
				{generating ? (
					<div
						style={{
							position: "absolute",
							top: headerFrame.top,
							left: IMGGEN_ICON_SIZE + IMGGEN_GROUP_GAP,
							width: IMGGEN_LOADER_SIZE,
							height: IMGGEN_ICON_SIZE,
							display: "flex",
							alignItems: "center",
							color: "var(--mantine-color-violet-6)",
							fontSize: IMGGEN_LOADER_SIZE,
						}}
					>
						…
					</div>
				) : null}
				<HeaderInlineView block={header} frame={headerFrame} contentLeft={iconArea} />

				{/* Image area: aspect-ratio reserved box or unknown placeholder. */}
				{imageBlock && imageFrame ? (
					<ImageAreaView
						block={imageBlock}
						frame={imageFrame}
						contentWidth={contentWidth}
						resolveImageSrc={resolveImageSrc}
					/>
				) : null}
			</div>
		</div>
	);
}

function HeaderInlineView({
	block,
	frame,
	contentLeft,
}: {
	block: PreparedInlineBlock;
	frame: BlockFrame;
	contentLeft: number;
}) {
	const lineWidth = Math.max(1, frame.usedWidth - contentLeft);
	const lines = useMemo(() => {
		const out: Array<{
			fragments: Array<{ text: string; font: string; className: string; gapBefore: number }>;
		}> = [];
		// Re-materialize at the same width the measure layer used.
		const width = Math.max(1, lineWidth);
		walkRichInlineLineRanges(block.flow, width, (range) => {
			const line = materializeRichInlineLineRange(block.flow, range);
			out.push({
				fragments: line.fragments.map((f) => ({
					text: f.text,
					font: block.fonts[f.itemIndex] ?? "",
					className: block.classNames[f.itemIndex] ?? "",
					gapBefore: f.gapBefore,
				})),
			});
		});
		return out;
	}, [block, lineWidth]);

	return (
		<div style={{ position: "absolute", top: frame.top, left: contentLeft }}>
			{lines.map((line, lineIndex) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable ordered list
					key={lineIndex}
					style={{
						position: "absolute",
						left: 0,
						top: lineIndex * block.lineHeight,
						height: block.lineHeight,
						display: "flex",
						alignItems: "center",
						width: "max-content",
					}}
				>
					{line.fragments.map((frag, fi) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
							key={fi}
							className={frag.className}
							style={{
								font: frag.font,
								marginLeft: frag.gapBefore,
								whiteSpace: "pre",
								display: "inline-block",
								color:
									frag.className === "vlist-imggen-prompt"
										? "var(--mantine-color-violet-4)"
										: "var(--mantine-color-dimmed)",
							}}
						>
							{frag.text}
						</span>
					))}
				</div>
			))}
		</div>
	);
}

function ImageAreaView({
	block,
	frame,
	contentWidth,
	resolveImageSrc,
}: {
	block: MeasuredElement["blocks"][number];
	frame: BlockFrame;
	contentWidth: number;
	resolveImageSrc?: ResolveImageSrc;
}) {
	const displayWidth =
		block.kind === "fixed" && typeof block.data?.displayWidth === "number"
			? block.data.displayWidth
			: Math.min(contentWidth, frame.usedWidth);
	const tag = block.kind === "fixed" ? block.tag : "image-unknown";
	const data = (block.kind === "fixed" || block.kind === "unknown" ? block.data : undefined) ?? {};
	const src = resolveImageSrc?.(tag, data) ?? null;

	return (
		<div
			style={{
				position: "absolute",
				top: frame.top,
				left: 0,
				width: `min(100%, ${displayWidth}px)`,
				height: frame.height,
				borderRadius: "var(--mantine-radius-sm)",
				overflow: "hidden",
				background: "var(--mantine-color-dark-6)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			{src ? (
				<img
					src={src}
					alt="Generated"
					style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
				/>
			) : null}
		</div>
	);
}

function PhotoGlyph() {
	return (
		<svg
			width={12}
			height={12}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			aria-hidden
		>
			<title>image</title>
			<path d="M15 8h.01" />
			<path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
			<path d="m4 15 4-4a3 5 0 0 1 3 0l5 5" />
			<path d="m14 14 1-1a3 5 0 0 1 3 0l3 3" />
		</svg>
	);
}
