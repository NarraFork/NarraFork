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
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useId, useMemo } from "react";
import { TOOL_HEADER_SELECT_ATTR } from "../../MessageSelectionCtx";
import {
	ASSISTANT_PAD_X,
	ASSISTANT_PAD_Y,
	COMMAND_CHEVRON_SIZE,
	isMeasuredCommandBubble,
	type MeasuredCommandBubble,
	USER_BUBBLE_PADDING,
	USER_HEADER_BODY_GAP,
	USER_HEADER_HEIGHT,
} from "../measure/measure-message-bubble";
import type { MeasuredElement, PreparedCodeBlock, PreparedFixedBlock } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import { swallowSelectionClick } from "./key-activate";
import { RenderMarkdown } from "./RenderMarkdown";
import { readExactDisplayBox, VListImage } from "./vlist-image";
import { TextFileRow } from "./vlist-text-file-row";

/**
 * Bubble side + tint for a human-authored message.
 *
 * NarraFork is a shared deployment: one narrator can be driven by several people, so
 * "a user typed this" and "YOU typed this" are different facts. The right-hand indigo
 * bubble is a claim of authorship — painting a teammate's turn there tells the reader
 * they wrote something they did not.
 *
 * `isSelf` is resolved by the INTEGRATION layer (it compares `creator.id` against the
 * signed-in user), never by the adapter: both sides are the same height, so folding
 * viewer identity into the measured data would fork the measure cache per user for a
 * purely cosmetic difference. Same seam the header node already uses.
 */
function bubbleSurface(isSelf: boolean): {
	justifyContent: "flex-end" | "flex-start";
	background: string;
} {
	return isSelf
		? { justifyContent: "flex-end", background: "var(--mantine-color-indigo-light)" }
		: {
				justifyContent: "flex-start",
				// Neutral, but more solid than a system notice card so the three tiers stay
				// distinguishable: right indigo = you, left tinted = another person,
				// unframed grey = a system note.
				background: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
			};
}

interface RenderMessageBubbleProps {
	role: "assistant" | "user";
	measured: MeasuredElement;
	/** Optional header content for user messages (username + timestamp). */
	header?: React.ReactNode;
	hasHeader?: boolean;
	/**
	 * Did the signed-in user author this turn? Drives side + tint only.
	 *
	 * Defaults to `true` so a caller that has not resolved identity yet keeps the
	 * historical right-hand rendering instead of flipping every bubble to the left
	 * for one frame while `useCurrentUser()` resolves.
	 */
	isSelf?: boolean;
	/** Panel narrator id — lets user-bubble image attachments resolve their blob. */
	narratorId?: string;
	/** Forwarded for mermaid/katex local-measure refinement. */
	onUnknownHeight?: (height: number) => void;
	/** Slash-command bubbles: reveal / fold the expanded prompt. */
	onToggle?: () => void;
	/**
	 * Open a text-file attachment in a read-only file panel. Injected by the
	 * integration layer (the pure render layer owns no dock knowledge); absent →
	 * attachments stay non-interactive. HEIGHT-NEUTRAL.
	 */
	onOpenAttachment?: (filePath: string) => void;
	/** Localized label for the clickable attachment row (tooltip / aria). */
	openAttachmentLabel?: string;
}

export function RenderMessageBubble({
	role,
	measured,
	header,
	hasHeader = true,
	isSelf = true,
	narratorId,
	onUnknownHeight,
	onToggle,
	onOpenAttachment,
	openAttachmentLabel,
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
	if (isMeasuredCommandBubble(measured)) {
		return (
			<CommandBubble
				measured={measured}
				header={header}
				hasHeader={hasHeader}
				isSelf={isSelf}
				onToggle={onToggle}
			/>
		);
	}
	return (
		<UserBubble
			measured={measured}
			header={header}
			hasHeader={hasHeader}
			isSelf={isSelf}
			narratorId={narratorId}
			onOpenAttachment={onOpenAttachment}
			openAttachmentLabel={openAttachmentLabel}
		/>
	);
}

/**
 * Slash-command bubble: the command line, then the server-side expansion either
 * as one clamped preview line or in full, plus a toggle when it overflows.
 *
 * Every offset comes from the measure layer, and both text roles are painted with
 * the exact fonts that were measured — the collapsed preview relies on a CSS
 * single-line clamp whose box is the measured line height, so the rendered height
 * cannot drift from the prediction.
 */
function CommandBubble({
	measured,
	header,
	hasHeader,
	isSelf,
	onToggle,
}: {
	measured: MeasuredCommandBubble;
	header?: React.ReactNode;
	hasHeader: boolean;
	isSelf: boolean;
	onToggle?: () => void;
}) {
	const bodyBlock = measured.blocks.find((block) => block.kind === "code") as
		| PreparedCodeBlock
		| undefined;
	const lines = useMemo(() => {
		if (!bodyBlock || !measured.expanded) return [];
		return layoutWithLines(bodyBlock.prepared, measured.contentWidth, bodyBlock.lineHeight).lines;
	}, [bodyBlock, measured.contentWidth, measured.expanded]);
	// The toggle is an expand/collapse control, so it must name the region it
	// governs (`aria-controls`) and announce its state (`aria-expanded`); a screen
	// reader otherwise hears only the label text and cannot tell open from closed.
	const bodyId = useId();

	const headerBlock = hasHeader ? USER_HEADER_HEIGHT + USER_HEADER_BODY_GAP : 0;
	const contentTop = USER_BUBBLE_PADDING + headerBlock;

	const surface = bubbleSurface(isSelf);

	return (
		<div style={{ display: "flex", justifyContent: surface.justifyContent }}>
			<div
				style={{
					position: "relative",
					width: measured.usedWidth,
					height: measured.height,
					padding: USER_BUBBLE_PADDING,
					borderRadius: 8,
					background: surface.background,
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
						top: contentTop + measured.commandTop,
						left: USER_BUBBLE_PADDING,
						right: USER_BUBBLE_PADDING,
						height: typographyMetrics().line.body,
						font: typographyMetrics().font.bodyMediumMono,
						// `c="indigo"` equivalent: indigo-4 on dark, indigo-filled on
						// light (indigo-4 is unreadable on the light bubble).
						color: "var(--mantine-color-indigo-text)",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{measured.commandText}
				</div>
				{measured.bodyTop >= 0 ? (
					<div
						id={bodyId}
						style={{
							position: "absolute",
							top: contentTop + measured.bodyTop,
							left: USER_BUBBLE_PADDING,
							width: measured.contentWidth,
						}}
					>
						{measured.expanded ? (
							lines.map((line, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: expansion lines are a stable ordered list
									key={i}
									style={{
										position: "absolute",
										top: i * typographyMetrics().line.xs,
										left: 0,
										height: typographyMetrics().line.xs,
										whiteSpace: "pre",
										font: typographyMetrics().font.xs,
										color: "var(--mantine-color-dimmed)",
									}}
								>
									{line.text}
								</div>
							))
						) : (
							<div
								style={{
									height: typographyMetrics().line.xs,
									font: typographyMetrics().font.xs,
									color: "var(--mantine-color-dimmed)",
									whiteSpace: "pre",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{measured.expansionText}
							</div>
						)}
					</div>
				) : null}
				{measured.toggleTop >= 0 ? (
					<button
						type="button"
						// Selectable surface: a native <button> would be excluded from block
						// selection, and an unguarded toggle would collapse the bubble under
						// the user's Ctrl/Cmd/Shift+Click — guard both.
						{...{ [TOOL_HEADER_SELECT_ATTR]: "" }}
						onClick={onToggle ? swallowSelectionClick(onToggle) : undefined}
						// Without a handler the control cannot do anything, so it must not
						// be focusable / clickable either (it used to accept both and do
						// nothing).
						disabled={onToggle == null}
						aria-expanded={measured.expanded}
						aria-controls={measured.bodyTop >= 0 ? bodyId : undefined}
						style={{
							position: "absolute",
							top: contentTop + measured.toggleTop,
							left: USER_BUBBLE_PADDING,
							height: typographyMetrics().line.xs,
							display: "flex",
							alignItems: "center",
							gap: 4,
							padding: 0,
							border: "none",
							background: "none",
							font: typographyMetrics().font.xs,
							color: "var(--mantine-color-indigo-4)",
							cursor: onToggle ? "pointer" : "default",
							textAlign: "left",
							whiteSpace: "nowrap",
						}}
					>
						{measured.expanded ? (
							<IconChevronDown size={COMMAND_CHEVRON_SIZE} style={{ flexShrink: 0 }} />
						) : (
							<IconChevronRight size={COMMAND_CHEVRON_SIZE} style={{ flexShrink: 0 }} />
						)}
						{measured.toggleLabel}
					</button>
				) : null}
			</div>
		</div>
	);
}

function UserBubble({
	measured,
	header,
	hasHeader,
	isSelf,
	narratorId,
	onOpenAttachment,
	openAttachmentLabel,
}: {
	measured: MeasuredElement;
	header?: React.ReactNode;
	hasHeader: boolean;
	isSelf: boolean;
	narratorId?: string;
	onOpenAttachment?: (filePath: string) => void;
	openAttachmentLabel?: string;
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

	const surface = bubbleSurface(isSelf);

	return (
		<div style={{ display: "flex", justifyContent: surface.justifyContent }}>
			<div
				style={{
					position: "relative",
					width: measured.usedWidth,
					height: measured.height,
					padding: USER_BUBBLE_PADDING,
					borderRadius: 8,
					background: surface.background,
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
							onOpenAttachment={onOpenAttachment}
							openAttachmentLabel={openAttachmentLabel}
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
									font: typographyMetrics().font.body,
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
	onOpenAttachment,
	openAttachmentLabel,
}: {
	block: PreparedFixedBlock;
	top: number;
	left: number;
	narratorId?: string;
	onOpenAttachment?: (filePath: string) => void;
	openAttachmentLabel?: string;
}) {
	const data = block.data ?? {};
	const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
	if (block.tag === "user-text-file") {
		// The path is a height-neutral passthrough from measure; when both it and a
		// host handler exist the row becomes clickable WITHOUT changing its box.
		const filePath = str(data.filePath);
		const openFile = filePath && onOpenAttachment ? () => onOpenAttachment(filePath) : undefined;
		return (
			<div style={{ position: "absolute", top, left, height: block.height }}>
				<TextFileRow
					filename={str(data.filename) ?? ""}
					size={typeof data.size === "number" ? data.size : null}
					height={block.height}
					onOpen={openFile}
					openLabel={openAttachmentLabel}
				/>
			</div>
		);
	}
	// An image whose intrinsic dimensions were persisted reserves an aspect-
	// fitted box and stashes the exact display size in `data`; paint exactly that
	// rectangle (the bubble shrink-wrapped around it). Dimensionless images keep
	// the legacy centred-in-fixed-box behaviour. The predicate is shared with
	// every other paint site (see readExactDisplayBox).
	const exactBox = readExactDisplayBox(data);
	return (
		<div
			style={{
				position: "absolute",
				top,
				left,
				maxWidth: "100%",
				width: exactBox ? exactBox.displayWidth : "fit-content",
			}}
		>
			<VListImage
				media={{
					previewUrl: str(data.previewUrl),
					imageId: str(data.imageId),
					filename: str(data.filename),
					uploadNarratorId: str(data.uploadNarratorId),
				}}
				narratorId={narratorId}
				maxHeight={block.height}
				{...(exactBox ?? {})}
			/>
		</div>
	);
}
