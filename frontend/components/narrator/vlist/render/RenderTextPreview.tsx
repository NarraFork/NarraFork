import { TEXT_PREVIEW_BUTTON_GAP } from "@shared/pretext-layout/text-preview";
import { typographyMetrics } from "../pretext-fonts";
import type { RenderMarkdownProps } from "./RenderMarkdown";
import { RenderMarkdown } from "./RenderMarkdown";

export interface TextPreviewLabels {
	expand?: string;
	collapse?: string;
	loading?: string;
	loadFailed?: string;
}

export interface RenderTextPreviewProps extends RenderMarkdownProps {
	textPreviewLabels?: TextPreviewLabels;
	onToggleTextExpanded?: (bodyKey?: string) => void;
	bodyKey?: string;
	/** Disclosure chrome fits a shrink-wrapped bubble without re-wrapping its text. */
	controlWidth?: number;
}

/** Shared in-place text disclosure. Only body space and its own button belong here. */
export function RenderTextPreview({
	textPreviewLabels,
	onToggleTextExpanded,
	bodyKey,
	controlWidth,
	...props
}: RenderTextPreviewProps) {
	const preview = props.measured.textPreview;
	if (!preview) return <RenderMarkdown {...props} />;
	const topButton = preview.direction === "tail";
	const metrics = typographyMetrics();
	return (
		<div
			data-vlist-text-preview={preview.expanded ? "expanded" : "collapsed"}
			style={{
				position: "relative",
				display: preview.expanded ? "flex" : undefined,
				flexDirection: "column",
				height: preview.expanded ? undefined : preview.bodyHeight + preview.buttonHeight,
				minHeight: preview.expanded ? preview.bodyHeight + preview.buttonHeight : undefined,
			}}
		>
			{preview.buttonHeight > 0 ? (
				<button
					type="button"
					data-vlist-text-preview-toggle
					aria-expanded={preview.expanded}
					disabled={!onToggleTextExpanded}
					onClick={(event) => {
						event.stopPropagation();
						if (bodyKey === undefined) onToggleTextExpanded?.();
						else onToggleTextExpanded?.(bodyKey);
					}}
					style={{
						position: preview.expanded ? "relative" : "absolute",
						top: preview.expanded
							? undefined
							: topButton
								? 0
								: preview.bodyHeight + TEXT_PREVIEW_BUTTON_GAP,
						order: topButton ? 0 : 2,
						alignSelf: "stretch",
						left: preview.expanded ? undefined : 0,
						width: controlWidth ?? "100%",
						textAlign: "center",
						marginTop: preview.expanded && !topButton ? TEXT_PREVIEW_BUTTON_GAP : undefined,
						marginBottom: preview.expanded && topButton ? TEXT_PREVIEW_BUTTON_GAP : undefined,
						flexShrink: 0,
						height: metrics.line.xs,
						border: 0,
						padding: 0,
						background: "none",
						color: "var(--mantine-color-dimmed)",
						font: metrics.font.xs,
						lineHeight: `${metrics.line.xs}px`,
						cursor: "pointer",
					}}
				>
					{preview.expanded
						? (textPreviewLabels?.collapse ?? "Collapse")
						: (textPreviewLabels?.expand ?? "Expand")}
				</button>
			) : null}
			<div
				data-vlist-text-preview-body
				style={{
					position: "relative",
					top: preview.expanded ? 0 : topButton ? preview.buttonHeight : 0,
					order: 1,
					height: preview.expanded ? undefined : preview.bodyHeight,
					minHeight: preview.expanded ? preview.bodyHeight : undefined,
					overflow: preview.expanded ? undefined : "hidden",
					maskImage:
						!preview.expanded && preview.clipped && preview.bodyHeight >= 48
							? preview.direction === "tail"
								? "linear-gradient(to bottom, transparent, black 12px)"
								: "linear-gradient(to top, transparent, black 12px)"
							: undefined,
				}}
			>
				<RenderMarkdown
					{...props}
					// A moving tail is a sliding source window, not an append-only run.
					// Reusing per-grapheme births here would replay old characters.
					animateStreaming={
						!preview.expanded && preview.direction === "tail" && preview.clipped
							? false
							: props.animateStreaming
					}
					sourceText={
						preview.expanded ? (props.sourceText ?? preview.sourceText) : preview.previewText
					}
					onUnknownHeight={preview.expanded ? props.onUnknownHeight : undefined}
				/>
			</div>
		</div>
	);
}
