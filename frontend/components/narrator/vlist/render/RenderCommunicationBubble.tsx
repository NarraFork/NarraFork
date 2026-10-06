/** Render-only outgoing message bubble. Navigation and full payload fetching belong to the host. */
import {
	communicationTargetLabel,
	deriveCommunicationState,
	formatCommunicationState,
} from "@shared/pretext-layout/communication-state";
import type { CommunicationBubbleData } from "@shared/pretext-layout/segment-adapter";
import type { CSSProperties, ReactNode } from "react";
import type { MeasuredCommunicationBubble } from "../measure/measure-communication-bubble";
import {
	INJECTION_BUBBLE_PADDING,
	INJECTION_HEADER_HEIGHT,
	INJECTION_NOTE_GAP,
} from "../measure/measure-injection-bubble";
import { typographyMetrics } from "../pretext-fonts";
import { hasUnpredictableBlock } from "../vlist-unpredictable-blocks";
import { RenderTextPreview, type TextPreviewLabels } from "./RenderTextPreview";

export interface RenderCommunicationBubbleProps {
	textPreviewLabels?: TextPreviewLabels;
	fullTextLoading?: boolean;
	fullTextError?: string;
	onToggleTextExpanded?: (bodyKey?: string) => void;
	/** Accepted for the shared host contract; expanded unknown rows use outer reporting. */
	onUnknownHeight?: (height: number) => void;
	measured: MeasuredCommunicationBubble;
	data?: Partial<
		Pick<
			CommunicationBubbleData,
			"recipients" | "broadcast" | "awaitReply" | "status" | "labels" | "deliveryState"
		>
	>;
	/** Interactive recipient chips supplied by the host, with its route/context-menu behavior. */
	header?: ReactNode;
	onOpenRecipient?: (id: string, deliveryMessageId?: string) => void;
	onViewFull?: () => void;
}

export function RenderCommunicationBubble({
	measured,
	data,
	header,
	onOpenRecipient,
	onViewFull,
	textPreviewLabels,
	onToggleTextExpanded,
	fullTextLoading,
	fullTextError,
	onUnknownHeight,
}: RenderCommunicationBubbleProps) {
	const metrics = typographyMetrics();
	const textExpanded = measured.textPreview?.expanded === true;
	const dynamicBody = textExpanded && hasUnpredictableBlock(measured.blocks);
	// Fetch state must not disable a local collapse. Only another expansion/fetch
	// is blocked while the first payload request is still pending.
	const toggleTextExpanded = fullTextLoading && !textExpanded ? undefined : onToggleTextExpanded;
	const viewFullAction = onToggleTextExpanded
		? toggleTextExpanded
		: fullTextLoading
			? undefined
			: onViewFull;
	const textLine: CSSProperties = {
		font: metrics.font.xs,
		lineHeight: `${metrics.line.xs}px`,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	};
	const footerLine: CSSProperties = {
		...textLine,
		position: dynamicBody ? "relative" : "absolute",
		left: dynamicBody ? undefined : INJECTION_BUBBLE_PADDING,
		right: dynamicBody ? undefined : INJECTION_BUBBLE_PADDING,
		marginTop: dynamicBody ? INJECTION_NOTE_GAP : undefined,
		display: dynamicBody ? "block" : undefined,
		height: metrics.line.xs,
	};
	const chipStyle: CSSProperties = {
		border: 0,
		borderRadius: 4,
		padding: "0 4px",
		background: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
		color: "inherit",
		font: "inherit",
		flexShrink: 0,
	};
	const labels = data?.labels;
	const failed = measured.errorTop >= 0;
	const state =
		data?.deliveryState ??
		deriveCommunicationState({
			targets: data?.recipients,
			awaitReply: data?.awaitReply,
			status: failed ? "error" : data?.status,
		});
	const meta = formatCommunicationState(state, labels);
	return (
		<div data-vlist-communication-row style={{ display: "flex", justifyContent: "flex-start" }}>
			<div
				data-vlist-communication-frame
				style={{
					position: "relative",
					width: measured.usedWidth,
					height: dynamicBody ? undefined : measured.height,
					minHeight: dynamicBody ? measured.height : undefined,
					padding: INJECTION_BUBBLE_PADDING,
					borderRadius: 8,
					// Outgoing messages are tinted; incoming injections keep their neutral frame.
					background:
						"light-dark(var(--mantine-color-indigo-0), color-mix(in srgb, var(--mantine-color-indigo-8) 30%, var(--mantine-color-dark-6)))",
					boxSizing: "border-box",
				}}
			>
				<div
					data-vlist-communication-header
					style={{
						position: "absolute",
						top: INJECTION_BUBBLE_PADDING,
						left: INJECTION_BUBBLE_PADDING,
						right: INJECTION_BUBBLE_PADDING,
						height: INJECTION_HEADER_HEIGHT,
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<div
						data-vlist-communication-recipients
						style={{
							...textLine,
							flex: 1,
							minWidth: 0,
							height: INJECTION_HEADER_HEIGHT,
							scrollbarWidth: "none",
							overflowX: "auto",
							display: "flex",
							gap: 4,
						}}
					>
						{header ?? (
							<>
								{data?.broadcast ? (
									<span
										title={data.recipients?.map(communicationTargetLabel).join(", ")}
										style={chipStyle}
									>
										@{labels?.communicationBroadcast ?? "all"}
									</span>
								) : null}
								{!data?.broadcast &&
									data?.recipients?.map((recipient) =>
										recipient.id && onOpenRecipient ? (
											<button
												type="button"
												key={recipient.id}
												data-vlist-communication-recipient={recipient.id}
												onClick={(event) => {
													event.stopPropagation();
													onOpenRecipient(recipient.id as string, recipient.deliveryMessageId);
												}}
												style={{ ...chipStyle, cursor: "pointer" }}
											>
												@{communicationTargetLabel(recipient)}
											</button>
										) : (
											<span key={recipient.id ?? recipient.label} style={chipStyle}>
												@{communicationTargetLabel(recipient)}
											</span>
										),
									)}
								{!data?.broadcast && !data?.recipients?.length ? (
									<span>@{labels?.communicationRecipientUnknown ?? "?"}</span>
								) : null}
							</>
						)}
					</div>
					{meta ? (
						<span
							data-vlist-communication-meta
							title={meta}
							style={{ ...textLine, maxWidth: "40%", color: "var(--mantine-color-dimmed)" }}
						>
							{meta}
						</span>
					) : null}
				</div>
				<div
					data-vlist-communication-body
					style={{
						position: dynamicBody ? "relative" : "absolute",
						top: dynamicBody ? undefined : measured.bodyTop,
						left: dynamicBody ? undefined : INJECTION_BUBBLE_PADDING,
						right: dynamicBody ? undefined : INJECTION_BUBBLE_PADDING,
						marginTop: dynamicBody ? measured.bodyTop - INJECTION_BUBBLE_PADDING : undefined,
						width: dynamicBody ? measured.contentWidth : undefined,
						height: dynamicBody ? undefined : measured.bodyHeight,
						// Expanded unknown content contributes its real height, including
						// body controls and footers, to the host's outer row reporter.
						overflowY: dynamicBody ? undefined : "hidden",
						overflowX: dynamicBody ? undefined : "hidden",
					}}
				>
					<RenderTextPreview
						measured={measured}
						textPreviewLabels={
							fullTextLoading && !textExpanded
								? {
										...textPreviewLabels,
										expand: textPreviewLabels?.loading ?? "Loading…",
										collapse: textPreviewLabels?.loading ?? "Loading…",
									}
								: textPreviewLabels
						}
						onToggleTextExpanded={toggleTextExpanded}
						onUnknownHeight={dynamicBody ? undefined : onUnknownHeight}
					/>
				</div>
				{failed ? (
					<div
						data-vlist-communication-error
						role="status"
						title={measured.errorText || labels?.communicationError}
						style={{
							...footerLine,
							top: dynamicBody ? undefined : measured.errorTop,
							color: "var(--mantine-color-red-6)",
						}}
					>
						{measured.errorText || labels?.communicationError || "Error"}
					</div>
				) : null}
				{measured.warningTop >= 0 ? (
					<div
						data-vlist-communication-warning
						role="status"
						title={measured.warningText}
						style={{
							...footerLine,
							top: dynamicBody ? undefined : measured.warningTop,
							color: "var(--mantine-color-dimmed)",
						}}
					>
						{measured.warningText}
					</div>
				) : null}
				{measured.viewFullTop >= 0 ? (
					<button
						type="button"
						data-vlist-communication-view-full
						disabled={!viewFullAction}
						aria-busy={fullTextLoading || undefined}
						onClick={(event) => {
							event.stopPropagation();
							viewFullAction?.();
						}}
						style={{
							...footerLine,
							top: dynamicBody ? undefined : measured.viewFullTop,
							border: 0,
							padding: 0,
							background: "none",
							color: "var(--mantine-color-dimmed)",
							textAlign: "left",
							cursor: viewFullAction ? "pointer" : "default",
						}}
					>
						<span data-vlist-communication-truncated aria-hidden="true">
							… ·{" "}
						</span>
						{fullTextLoading
							? (textPreviewLabels?.loading ?? "Loading…")
							: fullTextError
								? (textPreviewLabels?.loadFailed ?? fullTextError)
								: (labels?.communicationTruncated ?? "Source was truncated")}
					</button>
				) : null}
			</div>
		</div>
	);
}
