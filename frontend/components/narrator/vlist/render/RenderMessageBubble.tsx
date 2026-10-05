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
import type { FileReference } from "@shared/file-reference";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useId, useMemo } from "react";
import {
	FileReferenceScopeProvider,
	useFileReferenceScope,
} from "../../composer/FileReferenceScope";
import { TOOL_HEADER_SELECT_ATTR } from "../../message/MessageSelectionCtx";
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
	/**
	 * Reply quote strip clicked — the integration layer owns the "load until
	 * reachable" jump policy; absent → the strip renders non-interactive.
	 * HEIGHT-NEUTRAL (the strip's box is reserved by the measure pass).
	 */
	onQuoteClick?: () => void;
	/**
	 * Activate an attachment whose bytes live behind a caller-named authenticated
	 * path (`fetchUrl`, e.g. a chat attachment). The integration layer owns the
	 * action (a download with the session token); absent → such rows stay
	 * non-interactive. HEIGHT-NEUTRAL.
	 */
	onFetchAttachment?: (fetchUrl: string, filename: string) => void;
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
	onQuoteClick,
	onFetchAttachment,
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
				<FileReferenceScopeProvider value={{ context: null }}>
					<RenderMarkdown measured={measured} onUnknownHeight={onUnknownHeight} />
				</FileReferenceScopeProvider>
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
				narratorId={narratorId}
				onOpenAttachment={onOpenAttachment}
				openAttachmentLabel={openAttachmentLabel}
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
			onQuoteClick={onQuoteClick}
			onFetchAttachment={onFetchAttachment}
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
	narratorId,
	onOpenAttachment,
	openAttachmentLabel,
}: {
	measured: MeasuredCommandBubble;
	header?: React.ReactNode;
	hasHeader: boolean;
	isSelf: boolean;
	onToggle?: () => void;
	narratorId?: string;
	onOpenAttachment?: (filePath: string) => void;
	openAttachmentLabel?: string;
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
				{measured.blocks.map((block, index) => {
					if (block.kind !== "fixed" || !block.tag.startsWith("user-")) return null;
					const frame = measured.frame.blocks[index];
					if (!frame) return null;
					return (
						<UserAttachmentView
							// biome-ignore lint/suspicious/noArrayIndexKey: immutable message attachment order
							key={`${block.tag}-${index}`}
							block={block}
							top={contentTop + frame.top}
							left={USER_BUBBLE_PADDING}
							narratorId={narratorId}
							onOpenAttachment={onOpenAttachment}
							openAttachmentLabel={openAttachmentLabel}
						/>
					);
				})}
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
	onQuoteClick,
	onFetchAttachment,
}: {
	measured: MeasuredElement;
	header?: React.ReactNode;
	hasHeader: boolean;
	isSelf: boolean;
	narratorId?: string;
	onOpenAttachment?: (filePath: string) => void;
	openAttachmentLabel?: string;
	onQuoteClick?: () => void;
	onFetchAttachment?: (fetchUrl: string, filename: string) => void;
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
					const top = contentTop + frame.top;
					if (block.tag === "user-quote") {
						return (
							<QuoteStrip key="user-quote" block={block} top={top} onQuoteClick={onQuoteClick} />
						);
					}
					if (block.tag === "user-markdown") {
						const body = block.data?.measured as MeasuredElement;
						return (
							<div
								key="user-markdown"
								style={{
									position: "absolute",
									top,
									left: USER_BUBBLE_PADDING,
									width: body.contentWidth,
									height: block.height,
									// This is an exact-height body, not a scroll viewport. Native
									// scrollbars consume its reserved text line on classic-scrollbar
									// platforms. Tables/code own their overflow inside Markdown.
									overflow: "hidden",
								}}
							>
								<FileReferenceScopeProvider value={{ context: null }}>
									<RenderMarkdown measured={body} />
								</FileReferenceScopeProvider>
							</div>
						);
					}
					if (block.tag === "user-deleted") {
						return <TombstoneLine key="user-deleted" block={block} top={top} />;
					}
					return (
						<UserAttachmentView
							// biome-ignore lint/suspicious/noArrayIndexKey: attachment blocks are a stable ordered list (message contentJson order)
							key={index}
							block={block}
							top={top}
							left={USER_BUBBLE_PADDING}
							narratorId={narratorId}
							onOpenAttachment={onOpenAttachment}
							openAttachmentLabel={openAttachmentLabel}
							onFetchAttachment={onFetchAttachment}
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
 * The reply quote strip above a bubble's content: who was quoted, what they
 * said, click to jump. ONE clamped line inside the exact box the measure pass
 * reserved — everything truncates rather than wrapping, so no quoted text or
 * username length can push the row past its reserved line.
 */
function QuoteStrip({
	block,
	top,
	onQuoteClick,
}: {
	block: PreparedFixedBlock;
	top: number;
	onQuoteClick?: () => void;
}) {
	const data = block.data ?? {};
	const authorName =
		typeof data.authorName === "string" && data.authorName ? data.authorName : null;
	const text = typeof data.text === "string" ? data.text : "";
	const state = data.state;
	const style: React.CSSProperties = {
		position: "absolute",
		top,
		left: USER_BUBBLE_PADDING,
		right: USER_BUBBLE_PADDING,
		height: block.height,
		display: "flex",
		alignItems: "center",
		gap: 4,
		paddingLeft: 6,
		borderLeft: "3px solid var(--mantine-primary-color-filled)",
		overflow: "hidden",
		cursor: onQuoteClick ? "pointer" : "default",
		boxSizing: "border-box",
	};
	const body = (
		<>
			{authorName ? (
				<span
					style={{
						flexShrink: 0,
						maxWidth: "45%",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						font: typographyMetrics().font.xs,
						fontWeight: 600,
						color: "var(--mantine-color-dimmed)",
					}}
				>
					{authorName}
				</span>
			) : null}
			<span
				style={{
					minWidth: 0,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
					font: typographyMetrics().font.xs,
					fontStyle: state === "quoted" ? undefined : "italic",
					color: "var(--mantine-color-dimmed)",
				}}
			>
				{text}
			</span>
		</>
	);
	if (onQuoteClick == null) return <div style={style}>{body}</div>;
	return (
		<button
			type="button"
			onClick={(event) => {
				event.stopPropagation();
				onQuoteClick();
			}}
			style={{
				...style,
				padding: 0,
				paddingLeft: 6,
				border: "none",
				borderLeft: "3px solid var(--mantine-primary-color-filled)",
				background: "none",
				font: typographyMetrics().font.xs,
				textAlign: "left",
			}}
		>
			{body}
		</button>
	);
}

/**
 * The tombstone line of a soft-deleted message: one dimmed italic line inside
 * the reserved box, replacing body AND attachments.
 */
function TombstoneLine({ block, top }: { block: PreparedFixedBlock; top: number }) {
	const data = block.data ?? {};
	const text = typeof data.text === "string" ? data.text : "";
	return (
		<div
			style={{
				position: "absolute",
				top,
				left: USER_BUBBLE_PADDING,
				height: block.height,
				font: typographyMetrics().font.body,
				fontStyle: "italic",
				color: "var(--mantine-color-dimmed)",
				whiteSpace: "pre",
				overflow: "hidden",
				textOverflow: "ellipsis",
			}}
		>
			{text}
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
	onFetchAttachment,
}: {
	block: PreparedFixedBlock;
	top: number;
	left: number;
	narratorId?: string;
	onOpenAttachment?: (filePath: string) => void;
	openAttachmentLabel?: string;
	onFetchAttachment?: (fetchUrl: string, filename: string) => void;
}) {
	const scope = useFileReferenceScope();
	const data = block.data ?? {};
	const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
	if (block.tag === "user-text-file" || block.tag === "user-file-reference") {
		// The path is a height-neutral passthrough from measure; when both it and a
		// host handler exist the row becomes clickable WITHOUT changing its box.
		const filePath = str(data.filePath);
		const fetchUrl = str(data.fetchUrl);
		const filename = str(data.filename) ?? "";
		const reference = data.reference as FileReference | undefined;
		const openFile =
			block.tag === "user-file-reference"
				? reference && scope.openFile
					? () => scope.openFile?.(reference)
					: undefined
				: fetchUrl && onFetchAttachment
					? () => onFetchAttachment(fetchUrl, filename)
					: filePath && onOpenAttachment
						? () => onOpenAttachment(filePath)
						: undefined;
		return (
			<div style={{ position: "absolute", top, left, height: block.height, maxWidth: "100%" }}>
				<TextFileRow
					filename={filename}
					size={typeof data.size === "number" ? data.size : null}
					height={block.height}
					// The exact box measure reserved. Without it the row is unbounded
					// inside this absolutely positioned host, so a long filename wraps
					// out of its single reserved line.
					width={block.displayWidth}
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
					fetchUrl: str(data.fetchUrl),
				}}
				narratorId={narratorId}
				maxHeight={block.height}
				{...(exactBox ?? {})}
			/>
		</div>
	);
}
