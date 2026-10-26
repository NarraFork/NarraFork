import { Box } from "@mantine/core";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../hooks/useLocalPref";
import { startBottomSpacingResize, useBottomSpacing } from "../../hooks/useResizableBottomSpacing";
import { NarratorComposerRow, type NarratorComposerRowProps } from "./composer/NarratorComposerRow";
import { NarratorGitBar } from "./header/NarratorGitBar";
import { NarratorInteractionStatusBar } from "./interaction/NarratorInteractionStatusBar";
import { PendingAgentMessagesPanel } from "./interaction/PendingAgentMessagesPanel";
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
import { useNarratorPanelCompact } from "./panels/compact-context";
import { PermissionRulePolicySync } from "./permission/PermissionRuleResultNotice";

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
	attachmentsHydrating?: boolean;
	attachmentsRestoreFailed?: boolean;
	onRetryAttachments?: () => void;
	restoredAttachmentResources?: ReadonlyMap<string, File>;
	updateAttachedImages: React.Dispatch<React.SetStateAction<File[]>>;
	updateAttachedTextFiles: React.Dispatch<React.SetStateAction<File[]>>;
	reconcileDocumentAssets?: (ids: readonly string[]) => void;

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

	// ── Git strip ──
	onOpenGitPanel?: () => void;

	// ── Status bar — raw inputs; the props are assembled here via useStatusBarProps
	//    (model / reasoning / codex / permission control sub-objects are computed
	//    from the control hooks rather than in NarratorPanel). The shared context
	//    fields (narratorId/narrator/isWorkspacePreview/isMobileViewport) come from
	//    `common`; compact comes from the responsive context. All are omitted here. ──
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
}

export function NarratorInteractionArea(props: NarratorInteractionAreaProps) {
	const { t } = useTranslation("narrator");
	const retainWorktreeRequirement = (text: string) =>
		props.composerRowProps.composerRef.current?.appendText(text);
	const bottomSpacing = useBottomSpacing();
	const [resizeEnabled] = useLocalPref("narrafork_narrator_bottom_spacing_resize");
	// Assemble the status-bar props here (computing the model/reasoning/codex/
	// permission control sub-objects via the control hooks) instead of in the panel.
	const compact = useNarratorPanelCompact();
	const statusBar = useStatusBarProps({ ...props.common, ...props.statusBarInputs, compact });
	// Queue buffer interactions live here rather than in the panel: every output
	// below is consumed only within this component's subtree.
	const {
		visibleQueuedMessages,
		urgentDispatches,
		queueHoldProgress,
		startQueueHold,
		cancelQueueHold,
		handleQueuePointerUp,
		handleQueueClick,
		handleCancelAllQueued,
		handleRemoveQueued,
		handleRetryQueued,
		handleDragEndQueued,
		handleMoveQueued,
		handleChangeMode,
		editingQueuedId,
		queueExpanded,
		setQueueExpanded,
		handleStartEditQueued,
		handleCancelEditQueued,
		handleSaveEditQueued,
	} = useQueuedMessageActions({ narratorId: props.common.narratorId, ...props.queueDeps, t });

	return (
		<Box style={{ position: "relative", flexShrink: 0 }}>
			{/* Resize boundary; the queue draws its own top border when present. */}
			<Box
				onPointerDown={resizeEnabled ? startBottomSpacingResize : undefined}
				role={resizeEnabled ? "separator" : undefined}
				aria-orientation={resizeEnabled ? "horizontal" : undefined}
				aria-label={resizeEnabled ? t("resizeBottomSpacing") : undefined}
				style={{
					position: "absolute",
					top: -1,
					left: 0,
					right: 0,
					height: resizeEnabled ? 3 : 1,
					cursor: resizeEnabled ? "ns-resize" : undefined,
					touchAction: resizeEnabled ? "none" : undefined,
					pointerEvents: resizeEnabled ? undefined : "none",
					zIndex: 100,
					borderTop:
						props.queueDeps.queuedMessages.length > 0
							? undefined
							: "1px solid var(--mantine-color-default-border)",
				}}
			/>

			{!props.common.isWorkspacePreview && (
				<PendingAgentMessagesPanel narratorId={props.common.narratorId} />
			)}

			{/* Queued messages indicator */}
			<QueuedMessagesPanel
				narratorId={props.common.narratorId}
				queuedMessages={visibleQueuedMessages ?? props.queueDeps.queuedMessages}
				urgentDispatches={urgentDispatches}
				queueExpanded={queueExpanded}
				setQueueExpanded={setQueueExpanded}
				editingQueuedId={editingQueuedId}
				handleDragEndQueued={handleDragEndQueued}
				handleMoveQueued={handleMoveQueued}
				handleChangeMode={handleChangeMode}
				handleSaveEditQueued={handleSaveEditQueued}
				handleCancelEditQueued={handleCancelEditQueued}
				handleStartEditQueued={handleStartEditQueued}
				handleRemoveQueued={handleRemoveQueued}
				handleRetryQueued={handleRetryQueued}
				handleCancelAllQueued={handleCancelAllQueued}
			/>

			{/* Git workspace strip — clicking it opens the Git view. */}
			{props.onOpenGitPanel && (
				<Box style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
					<NarratorGitBar
						narratorId={props.common.narratorId}
						onOpenGitPanel={props.onOpenGitPanel}
						onRequirement={retainWorktreeRequirement}
					/>
				</Box>
			)}

			{/* Keep existing permission lists current without taking up composer space. */}
			{!props.common.isWorkspacePreview && (
				<PermissionRulePolicySync
					key={props.common.narratorId}
					narratorId={props.common.narratorId}
				/>
			)}
			{/* Status bar */}
			<NarratorInteractionStatusBar
				{...statusBar}
				borderTop={props.onOpenGitPanel ? undefined : statusBar.borderTop}
			/>

			{/* Upload / send progress while attachments upload. */}
			<UploadProgressBar sendingState={props.sendingState} cancelSending={props.cancelSending} />
			{/* Input */}
			{props.common.isWorkspacePreview ? null : (
				<NarratorComposerRow
					{...props.composerRowProps}
					attachedImages={props.attachedImages}
					attachedTextFiles={props.attachedTextFiles}
					attachmentsHydrating={props.attachmentsHydrating}
					attachmentsRestoreFailed={props.attachmentsRestoreFailed}
					onRetryAttachments={props.onRetryAttachments}
					restoredAttachmentResources={props.restoredAttachmentResources}
					onDocumentAssetsChange={props.reconcileDocumentAssets}
					onAttachmentsChange={(images, textFiles) => {
						props.updateAttachedImages(images);
						props.updateAttachedTextFiles(textFiles);
					}}
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
