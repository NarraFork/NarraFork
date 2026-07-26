/**
 * RenderMessageBubble.tsx — Message-level render TEMPLATE (batch-2 seed).
 *
 * Pairs with measure-message-bubble.ts. Renders the two common message shapes
 * from a MeasuredElement using absolute positioning at the measured geometry:
 *
 *   - assistant: no bubble; markdown body via RenderMarkdown, offset by the
 *     small markdown padding.
 *   - user: a bubble (Paper-like) with a single header row and a PLAIN pre-wrap
 *     body (rendered as positioned monospace-free text lines, NOT a code box).
 *
 * CRITICAL: body text is painted with the exact font measured
 * (measure-message-bubble uses SANS 14px), so rendered wrapping matches the
 * predicted height. Zero DOM measurement.
 */

import { layoutWithLines } from "@chenglou/pretext";
import { useMemo } from "react";
import {
	ASSISTANT_PAD_X,
	ASSISTANT_PAD_Y,
	USER_BUBBLE_PADDING,
	USER_HEADER_BODY_GAP,
	USER_HEADER_HEIGHT,
} from "../measure/measure-message-bubble";
import type { MeasuredElement, PreparedCodeBlock, PreparedFixedBlock } from "../prepared-block";
import { FONT_SIZE, SANS_FAMILY } from "../pretext-fonts";
import { RenderMarkdown } from "./RenderMarkdown";
import { VListImage } from "./vlist-image";
import { TextFileRow } from "./vlist-text-file-row";

const USER_BODY_FONT = `400 ${FONT_SIZE.sm}px ${SANS_FAMILY}`;

interface RenderMessageBubbleProps {
	role: "assistant" | "user";
	measured: MeasuredElement;
	/** Optional header content for user messages (username + timestamp). */
	header?: React.ReactNode;
	hasHeader?: boolean;
	/** Panel narrator id — lets user-bubble image attachments resolve their blob. */
	narratorId?: string;
	/** Forwarded for mermaid/katex local-measure refinement. */
	onUnknownHeight?: (height: number) => void;
}

export function RenderMessageBubble({
	role,
	measured,
	header,
	hasHeader = true,
	narratorId,
	onUnknownHeight,
}: RenderMessageBubbleProps) {
	if (role === "assistant") {
		return (
			<div
				style={{
					position: "relative",
					paddingInline: ASSISTANT_PAD_X,
					paddingBlock: ASSISTANT_PAD_Y,
				}}
			>
				<RenderMarkdown measured={measured} onUnknownHeight={onUnknownHeight} />
			</div>
		);
	}
	return (
		<UserBubble measured={measured} header={header} hasHeader={hasHeader} narratorId={narratorId} />
	);
}

function UserBubble({
	measured,
	header,
	hasHeader,
	narratorId,
}: {
	measured: MeasuredElement;
	header?: React.ReactNode;
	hasHeader: boolean;
	narratorId?: string;
}) {
	// A user bubble is [attachment…, body?]: attachment blocks are fixed boxes,
	// the body (when present) is the trailing pre-wrap code block.
	const bodyIndex = measured.blocks.findIndex((block) => block.kind === "code");
	const bodyBlock = bodyIndex >= 0 ? (measured.blocks[bodyIndex] as PreparedCodeBlock) : undefined;
	const bodyFrame = bodyIndex >= 0 ? measured.frame.blocks[bodyIndex] : undefined;
	const lines = useMemo(() => {
		if (!bodyBlock) return [];
		return layoutWithLines(bodyBlock.prepared, measured.contentWidth, bodyBlock.lineHeight).lines;
	}, [bodyBlock, measured.contentWidth]);

	const headerBlock = hasHeader ? USER_HEADER_HEIGHT + USER_HEADER_BODY_GAP : 0;
	const contentTop = USER_BUBBLE_PADDING + headerBlock;
	const lineHeight = bodyBlock?.lineHeight ?? 20;

	return (
		<div style={{ display: "flex", justifyContent: "flex-end" }}>
			<div
				style={{
					position: "relative",
					width: measured.usedWidth,
					height: measured.height,
					padding: USER_BUBBLE_PADDING,
					borderRadius: 8,
					background: "var(--mantine-color-indigo-light)",
					boxSizing: "border-box",
				}}
			>
				{hasHeader && header != null ? (
					<div
						style={{
							position: "absolute",
							top: USER_BUBBLE_PADDING,
							left: USER_BUBBLE_PADDING,
							right: USER_BUBBLE_PADDING,
							height: USER_HEADER_HEIGHT,
						}}
					>
						{header}
					</div>
				) : null}
				{measured.blocks.map((block, index) => {
					if (block.kind !== "fixed") return null;
					const frame = measured.frame.blocks[index];
					if (!frame) return null;
					return (
						<UserAttachmentView
							// biome-ignore lint/suspicious/noArrayIndexKey: attachment blocks are a stable ordered list (message contentJson order)
							key={index}
							block={block}
							top={contentTop + frame.top}
							left={USER_BUBBLE_PADDING}
							narratorId={narratorId}
						/>
					);
				})}
				{bodyBlock ? (
					<div
						style={{
							position: "absolute",
							top: contentTop + (bodyFrame?.top ?? 0),
							left: USER_BUBBLE_PADDING,
						}}
					>
						{lines.map((line, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: body lines are a stable ordered list
								key={i}
								style={{
									position: "absolute",
									top: i * lineHeight,
									left: 0,
									height: lineHeight,
									whiteSpace: "pre",
									font: USER_BODY_FONT,
									color: "var(--mantine-color-text)",
								}}
							>
								{line.text}
							</div>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * Paint one user attachment inside the box the measure layer reserved. Images
 * resolve their blob through VListImage (previewUrl → uploads-by-id); text files
 * draw the same single icon+name+size row as the media render copy.
 */
function UserAttachmentView({
	block,
	top,
	left,
	narratorId,
}: {
	block: PreparedFixedBlock;
	top: number;
	left: number;
	narratorId?: string;
}) {
	const data = block.data ?? {};
	const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
	if (block.tag === "user-text-file") {
		return (
			<div style={{ position: "absolute", top, left, height: block.height }}>
				<TextFileRow
					filename={str(data.filename) ?? ""}
					size={typeof data.size === "number" ? data.size : null}
					height={block.height}
				/>
			</div>
		);
	}
	return (
		<div style={{ position: "absolute", top, left, maxWidth: "100%", width: "fit-content" }}>
			<VListImage
				media={{
					previewUrl: str(data.previewUrl),
					imageId: str(data.imageId),
					filename: str(data.filename),
					uploadNarratorId: str(data.uploadNarratorId),
				}}
				narratorId={narratorId}
				maxHeight={block.height}
			/>
		</div>
	);
}
