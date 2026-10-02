import { Box, Text } from "@mantine/core";
import type React from "react";
import { useTranslation } from "react-i18next";
import { startBottomSpacingResize, useBottomSpacing } from "../../hooks/useResizableBottomSpacing";
import { NarratorComposerRow, type NarratorComposerRowProps } from "./composer/NarratorComposerRow";
import { ChapterBar, NarratorGitBar } from "./header/ChapterBar";
import { AttachmentPreviews } from "./interaction/AttachmentPreviews";
import { NarratorInteractionStatusBar } from "./interaction/NarratorInteractionStatusBar";
import { QueuedMessagesPanel } from "./interaction/QueuedMessagesPanel";
import { UploadProgressBar } from "./interaction/UploadProgressBar";
import {
	type UseQueuedMessageActionsOptions,
	useQueuedMessageActions,
} from "./interaction/use-queued-message-actions";
import {
	type UseStatusBarPropsOptions,
	useStatusBarProps,
} from "./interaction/use-status-bar-props";

/**
 * Context shared by several of the interaction area's sub-regions (status bar,
 * queue hook, composer, merged hint). Passed ONCE and merged locally into
 * the grouped prop objects, rather than repeated inside each of statusBarInputs /
 * queueDeps / composerRowProps by the panel.
 */
export interface NarratorInteractionCommon {
	narratorId: string;
	narrator: UseStatusBarPropsOptions["narrator"];
	isWorkspacePreview: boolean;
	compact: boolean | undefined;
	isMobileViewport: boolean;
}

export interface NarratorInteractionAreaProps {
	// ── Shared context, passed once (see NarratorInteractionCommon). ──
	common: NarratorInteractionCommon;

	// ── Attachments ──
	// imagePreviewUrls, formatFileSize and openImageViewer are no longer passed in:
	// the preview URLs are derived here from attachedImages, formatFileSize is a
	// pure util imported directly, and the image viewer comes from context.
	attachedImages: File[];
	attachedTextFiles: File[];
	updateAttachedImages: React.Dispatch<React.SetStateAction<File[]>>;
	updateAttachedTextFiles: React.Dispatch<React.SetStateAction<File[]>>;

	// ── Send / upload progress ──
	sendingState: {
		attachmentCount: number;
		progress: number | null;
		canCancel: boolean;
	} | null;
	cancelSending: () => void;

	// ── Queue — the hook is CALLED HERE (not in the panel): all of its outputs
	//    are consumed only within this subtree (the queued-messages panel + the
	//    composer's press-and-hold gesture), so the panel only supplies the stable
	//    refs/setters the hook depends on. `t` is provided locally. ──
	//    `narratorId` comes from `common`, so it is omitted here.
	queueDeps: Omit<UseQueuedMessageActionsOptions, "t" | "narratorId">;

	// ── ChapterBar ──
	chapterId?: string | null;
	onOpenGitPanel?: () => void;

	// ── Status bar — raw inputs; the props are assembled here via useStatusBarProps
	//    (model / reasoning / codex / permission control sub-objects are computed
	//    from the control hooks rather than in NarratorPanel). The shared context
	//    fields (narratorId/narrator/isWorkspacePreview/compact/isMobileViewport)
	//    come from `common` and are omitted here. ──
	statusBarInputs: Omit<
		UseStatusBarPropsOptions,
		"narratorId" | "narrator" | "isWorkspacePreview" | "compact" | "isMobileViewport"
	>;

	// ── Composer row — the queue press-and-hold gesture fields are injected here
	//    from the local useQueuedMessageActions call, not threaded from the panel;
	//    `narratorId` comes from `common`. ──
	composerRowProps: Omit<
		NarratorComposerRowProps,
		| "narratorId"
		| "queueHoldProgress"
		| "startQueueHold"
		| "handleQueuePointerUp"
		| "cancelQueueHold"
		| "handleQueueClick"
	>;

	// ── Merged-chapter read-only state ──
	isChapterMerged: boolean;
}

export function NarratorInteractionArea(props: NarratorInteractionAreaProps) {
	const { t } = useTranslation("narrator");
	const bottomSpacing = useBottomSpacing();
	// Assemble the status-bar props here (computing the model/reasoning/codex/
	// permission control sub-objects via the control hooks) instead of in the panel.
	const statusBar = useStatusBarProps({ ...props.common, ...props.statusBarInputs });
	// Queue buffer interactions live here rather than in the panel: every output
	// below is consumed only within this component's subtree.
	const {
		queueHoldProgress,
		startQueueHold,
		cancelQueueHold,
		handleQueuePointerUp,
		handleQueueClick,
		handleCancelAllQueued,
		handleRemoveQueued,
		handleRetryQueued,
		handleDragEndQueued,
		editingQueuedId,
		queueExpanded,
		setQueueExpanded,
		handleStartEditQueued,
		handleCancelEditQueued,
		handleSaveEditQueued,
	} = useQueuedMessageActions({ narratorId: props.common.narratorId, ...props.queueDeps, t });

	const hasImages = props.attachedImages.length > 0;

	return (
		<Box style={{ position: "relative", flexShrink: 0 }}>
			{/* Thin resize line at the Git boundary; the line itself is the drag target. */}
			<Box
				onPointerDown={startBottomSpacingResize}
				role="separator"
				aria-orientation="horizontal"
				aria-label={t("resizeBottomSpacing")}
				style={{
					position: "absolute",
					top: -1,
					left: 0,
					right: 0,
					height: 3,
					cursor: "ns-resize",
					touchAction: "none",
					zIndex: 100,
					borderTop: "1px solid var(--mantine-color-default-border)",
				}}
			/>

			{/* Staged image + text-file previews (owns its own object-URL previews). */}
			<AttachmentPreviews
				attachedImages={props.attachedImages}
				attachedTextFiles={props.attachedTextFiles}
				updateAttachedImages={props.updateAttachedImages}
				updateAttachedTextFiles={props.updateAttachedTextFiles}
			/>

			{/* Upload / send progress while attachments upload. */}
			<UploadProgressBar sendingState={props.sendingState} cancelSending={props.cancelSending} />

			{/* Queued messages indicator */}
			<QueuedMessagesPanel
				queuedMessages={props.queueDeps.queuedMessages}
				queueExpanded={queueExpanded}
				setQueueExpanded={setQueueExpanded}
				editingQueuedId={editingQueuedId}
				hasImages={hasImages}
				handleDragEndQueued={handleDragEndQueued}
				handleSaveEditQueued={handleSaveEditQueued}
				handleCancelEditQueued={handleCancelEditQueued}
				handleStartEditQueued={handleStartEditQueued}
				handleRemoveQueued={handleRemoveQueued}
				handleRetryQueued={handleRetryQueued}
				handleCancelAllQueued={handleCancelAllQueued}
			/>

			{/* Chapter bar — clicking the info strip opens the Git view. */}
			{props.chapterId && (
				<ChapterBar chapterId={props.chapterId} onOpenGitPanel={props.onOpenGitPanel} />
			)}

			{/* Standalone narrators have no chapter bar; offer the git workspace strip instead. */}
			{!props.chapterId && props.onOpenGitPanel && (
				<Box style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
					<NarratorGitBar
						narratorId={props.common.narratorId}
						onOpenGitPanel={props.onOpenGitPanel}
					/>
				</Box>
			)}

			{/* Status bar */}
			<NarratorInteractionStatusBar {...statusBar} />

			{/* Input */}
			{props.common.isWorkspacePreview ? null : props.isChapterMerged ? (
				<Box
					px="md"
					py="sm"
					style={{
						flexShrink: 0,
						backgroundColor: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
						opacity: 0.7,
					}}
				>
					<Text size="sm" c="dimmed" ta="center">
						{t("chapterMergedHint")}
					</Text>
				</Box>
			) : (
				<NarratorComposerRow
					{...props.composerRowProps}
					narratorId={props.common.narratorId}
					queueHoldProgress={queueHoldProgress}
					startQueueHold={startQueueHold}
					handleQueuePointerUp={handleQueuePointerUp}
					cancelQueueHold={cancelQueueHold}
					handleQueueClick={handleQueueClick}
				/>
			)}

			{/* Resizable bottom spacing (shared across all sub-regions). */}
			<Box style={{ height: `${bottomSpacing}px`, flexShrink: 0 }} />
		</Box>
	);
}
