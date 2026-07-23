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
import type { MeasuredElement, PreparedCodeBlock } from "../prepared-block";
import { FONT_SIZE, SANS_FAMILY } from "../pretext-fonts";
import { RenderMarkdown } from "./RenderMarkdown";

const USER_BODY_FONT = `400 ${FONT_SIZE.sm}px ${SANS_FAMILY}`;

interface RenderMessageBubbleProps {
	role: "assistant" | "user";
	measured: MeasuredElement;
	/** Optional header content for user messages (username + timestamp). */
	header?: React.ReactNode;
	hasHeader?: boolean;
	/** Forwarded for mermaid/katex local-measure refinement. */
	onUnknownHeight?: (height: number) => void;
}

export function RenderMessageBubble({
	role,
	measured,
	header,
	hasHeader = true,
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
	return <UserBubble measured={measured} header={header} hasHeader={hasHeader} />;
}

function UserBubble({
	measured,
	header,
	hasHeader,
}: {
	measured: MeasuredElement;
	header?: React.ReactNode;
	hasHeader: boolean;
}) {
	const bodyBlock = measured.blocks[0] as PreparedCodeBlock | undefined;
	const lines = useMemo(() => {
		if (!bodyBlock || bodyBlock.kind !== "code") return [];
		return layoutWithLines(bodyBlock.prepared, measured.contentWidth, bodyBlock.lineHeight).lines;
	}, [bodyBlock, measured.contentWidth]);

	const headerBlock = hasHeader ? USER_HEADER_HEIGHT + USER_HEADER_BODY_GAP : 0;
	const lineHeight = bodyBlock?.kind === "code" ? bodyBlock.lineHeight : 20;

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
				<div
					style={{
						position: "absolute",
						top: USER_BUBBLE_PADDING + headerBlock,
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
			</div>
		</div>
	);
}
