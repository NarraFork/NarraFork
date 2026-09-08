/** Render-only outgoing message bubble. Navigation and full payload fetching belong to the host. */
import type { CommunicationBubbleData } from "@shared/pretext-layout/segment-adapter";
import type { CSSProperties, ReactNode } from "react";
import type { MeasuredCommunicationBubble } from "../measure/measure-communication-bubble";
import {
	INJECTION_BUBBLE_PADDING,
	INJECTION_HEADER_HEIGHT,
} from "../measure/measure-injection-bubble";
import { typographyMetrics } from "../pretext-fonts";
import { RenderMarkdown } from "./RenderMarkdown";

export interface RenderCommunicationBubbleProps {
	measured: MeasuredCommunicationBubble;
	data?: Partial<
		Pick<CommunicationBubbleData, "recipients" | "broadcast" | "awaitReply" | "status" | "labels">
	>;
	/** Interactive recipient chips supplied by the host, with its route/context-menu behavior. */
	header?: ReactNode;
	onOpenRecipient?: (id: string) => void;
	onViewFull?: () => void;
}

export function RenderCommunicationBubble({
	measured,
	data,
	header,
	onOpenRecipient,
	onViewFull,
}: RenderCommunicationBubbleProps) {
	const metrics = typographyMetrics();
	const textLine: CSSProperties = {
		font: metrics.font.xs,
		lineHeight: `${metrics.line.xs}px`,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	};
	const footerLine: CSSProperties = {
		...textLine,
		position: "absolute",
		left: INJECTION_BUBBLE_PADDING,
		right: INJECTION_BUBBLE_PADDING,
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
	const status = failed
		? labels?.communicationError
		: data?.status === "success" || data?.status === "completed"
			? labels?.communicationSuccess
			: data?.status === "cancelled" || data?.status === "timeout" || data?.status === "aborted"
				? labels?.communicationCancelled
				: data?.status === "waiting" || data?.awaitReply
					? labels?.communicationWaiting
					: labels?.communicationRunning;
	const mode = data?.awaitReply ? labels?.sendAwaitReply : labels?.sendNoAwaitReply;
	const meta = [mode, status].filter(Boolean).join(" · ");
	return (
		<div data-vlist-communication-row style={{ display: "flex", justifyContent: "flex-start" }}>
			<div
				data-vlist-communication-frame
				style={{
					position: "relative",
					width: measured.usedWidth,
					height: measured.height,
					padding: INJECTION_BUBBLE_PADDING,
					borderRadius: 8,
					background: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
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
										title={data.recipients?.map((recipient) => recipient.label).join(", ")}
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
													onOpenRecipient(recipient.id as string);
												}}
												style={{ ...chipStyle, cursor: "pointer" }}
											>
												@{recipient.label}
											</button>
										) : (
											<span key={recipient.id ?? recipient.label} style={chipStyle}>
												@{recipient.label}
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
						position: "absolute",
						top: measured.bodyTop,
						left: INJECTION_BUBBLE_PADDING,
						right: INJECTION_BUBBLE_PADDING,
						height: measured.bodyHeight,
						// Native scrollbars must not steal width from the pre-measured lines.
						scrollbarWidth: "none",
						overflowY: "auto",
						overflowX: "hidden",
					}}
				>
					<RenderMarkdown measured={{ ...measured, height: measured.frame.contentHeight }} />
				</div>
				{failed ? (
					<div
						data-vlist-communication-error
						role="status"
						title={measured.errorText || labels?.communicationError}
						style={{ ...footerLine, top: measured.errorTop, color: "var(--mantine-color-red-6)" }}
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
							top: measured.warningTop,
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
						disabled={!onViewFull}
						onClick={(event) => {
							event.stopPropagation();
							onViewFull?.();
						}}
						style={{
							...footerLine,
							top: measured.viewFullTop,
							border: 0,
							padding: 0,
							background: "none",
							color: "var(--mantine-color-dimmed)",
							textAlign: "left",
							cursor: onViewFull ? "pointer" : "default",
						}}
					>
						<span data-vlist-communication-truncated aria-hidden="true">
							… ·{" "}
						</span>
						{labels?.communicationViewFull ?? "View full message"}
					</button>
				) : null}
			</div>
		</div>
	);
}
