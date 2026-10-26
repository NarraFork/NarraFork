import { ActionIcon, Box, Button, Group, Tooltip } from "@mantine/core";
import { IconPaperclip } from "@tabler/icons-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { AskSelectionInput } from "../interaction/use-ask-selection-in-passing";
import { resolveComposerActionSlot } from "./composer-action-slot";
import { NarratorComposer, type NarratorComposerHandle } from "./NarratorComposer";
import { type QueueMode, SendOptionsSplitButton } from "./SendOptionsSplitButton";
import { StableActionLabel } from "./StableActionLabel";

export interface NarratorComposerRowProps {
	/** 顺便提问 from a message-list selection; absent hides the action. */
	onAskSelection?: (input: AskSelectionInput) => Promise<void>;
	// Core refs
	fileInputRef: RefObject<HTMLInputElement | null>;
	composerRef: RefObject<NarratorComposerHandle | null>;
	sendingRef: RefObject<boolean>;
	appendInputRef: RefObject<((text: string) => void) | null> | undefined;
	interruptBtnRef?: ((btn: HTMLButtonElement | null) => void) | RefObject<HTMLButtonElement | null>;

	// Narrator state
	narratorId: string;
	isActive: boolean;

	// Composer state
	composerHasText: boolean;
	composerHasAttachments: boolean;
	setComposerHasText: (has: boolean) => void;
	effectiveFocusIndex: number | null;

	// User preferences
	enterQueueMode: QueueMode;
	ctrlEnterQueueMode: QueueMode;

	// File handling
	onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onComposerPasteImages: (files: File[]) => void;
	attachedImages?: File[];
	attachedTextFiles?: File[];
	attachmentsHydrating?: boolean;
	attachmentsRestoreFailed?: boolean;
	onRetryAttachments?: () => void;
	restoredAttachmentResources?: ReadonlyMap<string, File>;
	onAttachmentsChange?: (images: File[], textFiles: File[]) => void;
	onDocumentAssetsChange?: (ids: readonly string[]) => void;

	// Actions
	onSendWithMode: (mode: QueueMode) => void | Promise<void>;
	onSend: () => void | Promise<void>;
	onRetry: () => void;
	onContinue: () => void;
	onTakeover: () => void;
	onStopTakeover: () => void;

	// Queue state
	queuedMessagesCount: number;
	showCompactQueueChoice: boolean;
	canCutInLine: boolean;
	hasCutInMessage: boolean;

	// Takeover state
	canTakeover: boolean;
	isTakenOver: boolean;

	// Retry/continue state
	canRetryLastUserMessage: boolean;
	canContinueNarrator: boolean;
	retryRecoveryAllowsInterrupt: boolean;

	// Edit state
	editingMessageState?: {
		submit: () => void;
		canSubmit: boolean;
		isSubmitting: boolean;
	} | null;

	// Loading states
	isSending: boolean;
	takeoverMutationPending: boolean;
	stopTakeoverMutationPending: boolean;
	interruptMutationPending: boolean;

	// Hold gesture states
	interruptProgress: number;
	queueHoldProgress: number;

	// Hold gesture handlers
	startInterruptPress: (_e: React.MouseEvent) => void;
	handleInterruptMouseUp: () => void;
	clearInterruptTimer: () => void;
	startQueueHold: (event: React.PointerEvent<HTMLButtonElement>) => void;
	handleQueuePointerUp: () => void;
	cancelQueueHold: () => void;
	handleQueueClick: () => void;

	// Preference updates
	onUpdateEnterQueueMode: (mode: QueueMode) => void;
	onUpdateCtrlEnterQueueMode: (mode: QueueMode) => void;
}

export function NarratorComposerRow(props: NarratorComposerRowProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	const hasInput = props.composerHasText;
	const hasAttachments = props.composerHasAttachments;
	const sendLabel = props.isActive ? t(`queueMode_${props.enterQueueMode}`) : tc("send");
	const idleCandidates = [tc("send"), t("retry"), t("continue")];
	const stableIdleLabel = (label: string) =>
		props.isActive ? label : <StableActionLabel label={label} candidates={idleCandidates} />;

	// Wrap a primary button as the right segment of the split send-options control
	const withSendOptions = (
		primaryButton: React.ReactNode,
		opts?: { color?: string; variant?: string },
	) => (
		<SendOptionsSplitButton
			enterQueueMode={props.enterQueueMode}
			ctrlEnterQueueMode={props.ctrlEnterQueueMode}
			hasInput={hasInput || hasAttachments}
			compacting={props.showCompactQueueChoice}
			color={opts?.color}
			variant={opts?.variant}
			onSelectEnterMode={props.onUpdateEnterQueueMode}
			onSelectCtrlEnterMode={props.onUpdateCtrlEnterQueueMode}
			onSendWithMode={(mode) => {
				void props.onSendWithMode(mode);
			}}
			t={t}
			primaryButton={primaryButton}
		/>
	);

	// Render the primary action button based on current state
	const renderPrimaryActionButton = () => {
		const showInterrupt =
			props.isActive && !hasInput && !hasAttachments && props.retryRecoveryAllowsInterrupt;
		const showRetry =
			!showInterrupt && !hasInput && !hasAttachments && props.canRetryLastUserMessage;
		const showContinue =
			!showInterrupt && !hasInput && !hasAttachments && props.canContinueNarrator;

		// When a message is being edited, show edit-submit button (no send options)
		if (props.editingMessageState && !showInterrupt) {
			return (
				<Button
					key="edit-submit"
					onClick={props.editingMessageState.submit}
					disabled={!props.editingMessageState.canSubmit}
					loading={props.editingMessageState.isSubmitting}
				>
					{t("editSubmit")}
				</Button>
			);
		}

		// Interrupt button with hold gesture
		if (showInterrupt) {
			return withSendOptions(
				<Button
					key="interrupt"
					ref={props.interruptBtnRef}
					color="red"
					variant="light"
					onMouseDown={props.startInterruptPress}
					onMouseUp={props.handleInterruptMouseUp}
					onMouseLeave={props.clearInterruptTimer}
					onContextMenu={(e) => e.preventDefault()}
					loading={props.interruptMutationPending}
					style={{
						position: "relative",
						overflow: "hidden",
						userSelect: "none",
						touchAction: "none",
					}}
				>
					{props.interruptProgress > 0 && props.interruptProgress < 1 && (
						<div
							style={{
								position: "absolute",
								inset: 0,
								background: "var(--mantine-color-red-filled)",
								opacity: 0.25,
								transformOrigin: "left",
								transform: `scaleX(${props.interruptProgress})`,
								pointerEvents: "none",
							}}
						/>
					)}
					<span style={{ position: "relative" }}>
						{props.hasCutInMessage ? t("interruptCutInLine") : t("interrupt")}
					</span>
				</Button>,
				{ color: "red", variant: "light" },
			);
		}

		// Retry button
		if (showRetry) {
			return withSendOptions(
				<Button key="retry" onClick={props.onRetry}>
					{stableIdleLabel(t("retry"))}
				</Button>,
			);
		}

		// Continue button
		if (showContinue) {
			return withSendOptions(
				<Button key="continue" onClick={props.onContinue}>
					{stableIdleLabel(t("continue"))}
				</Button>,
			);
		}

		// Compaction keeps its wait/run policy, but an idle narrator still says Send.
		if (props.showCompactQueueChoice) {
			return withSendOptions(
				<Button
					key="send-compact-queue"
					onClick={props.onSend}
					disabled={!hasInput && !hasAttachments}
					loading={props.isSending}
				>
					{!props.isActive
						? stableIdleLabel(sendLabel)
						: props.queuedMessagesCount > 0
							? `${t("queue")} (${props.queuedMessagesCount})`
							: t("queue")}
				</Button>,
			);
		}

		// Cut-in-line mode: priority queue with hold gesture
		if (props.canCutInLine) {
			return withSendOptions(
				<Tooltip
					label={t("queueButtonPressHint", {
						shortMode: sendLabel,
						longMode: t(`queueMode_${props.ctrlEnterQueueMode}`),
					})}
					position="top"
				>
					<Button
						key="send-priority"
						disabled={!hasInput && !hasAttachments}
						loading={props.isSending}
						onPointerDown={(event) => {
							if (!hasInput && !hasAttachments) return;
							props.startQueueHold(event);
						}}
						onPointerUp={props.handleQueuePointerUp}
						onPointerCancel={props.cancelQueueHold}
						onPointerLeave={props.cancelQueueHold}
						onClick={props.handleQueueClick}
						onContextMenu={(e) => e.preventDefault()}
						style={{
							position: "relative",
							overflow: "hidden",
							userSelect: "none",
							touchAction: "none",
						}}
					>
						{props.queueHoldProgress > 0 && props.queueHoldProgress < 1 && (
							<div
								style={{
									position: "absolute",
									inset: 0,
									background: "var(--mantine-color-indigo-filled)",
									opacity: 0.25,
									transformOrigin: "left",
									transform: `scaleX(${props.queueHoldProgress})`,
									pointerEvents: "none",
								}}
							/>
						)}
						<span style={{ position: "relative" }}>{stableIdleLabel(sendLabel)}</span>
					</Button>
				</Tooltip>,
			);
		}

		// Default: simple send button
		return withSendOptions(
			<Button
				key="send"
				onClick={props.onSend}
				disabled={!hasInput && !hasAttachments}
				loading={props.isSending}
			>
				{stableIdleLabel(sendLabel)}
			</Button>,
		);
	};

	/**
	 * Action cluster only — NEVER the whole row.
	 *
	 * A running subagent that is not yet taken over must keep the textarea so
	 * the user can still queue/cut-in a message (docs + `use-narrator-send`).
	 * Only the right-hand button swaps to「接管」while the composer is empty;
	 * typing flips the slot back to `primary`.
	 */
	const actionSlot = resolveComposerActionSlot({
		canTakeover: props.canTakeover,
		isTakenOver: props.isTakenOver,
		hasInput,
		hasAttachments,
		editing: !!props.editingMessageState,
	});

	const actions =
		actionSlot === "taken-over" ? (
			<Group gap="xs" align="end" wrap="wrap" justify="flex-end">
				{renderPrimaryActionButton()}
				<Tooltip label={t("stopTakeoverHint")} position="top">
					<Button
						key="stop-takeover"
						color="grape"
						variant="outline"
						onClick={props.onStopTakeover}
						loading={props.stopTakeoverMutationPending}
					>
						{t("stopTakeover")}
					</Button>
				</Tooltip>
			</Group>
		) : actionSlot === "takeover" ? (
			<Button
				key="takeover"
				color="grape"
				variant="light"
				onClick={props.onTakeover}
				loading={props.takeoverMutationPending}
			>
				{t("takeover")}
			</Button>
		) : (
			renderPrimaryActionButton()
		);

	return (
		<Box px="md" style={{ paddingBottom: "var(--mantine-spacing-xs)", flexShrink: 0 }}>
			<input
				ref={props.fileInputRef}
				type="file"
				multiple
				style={{ display: "none" }}
				onChange={props.onFileInputChange}
				disabled={props.isSending}
			/>
			<NarratorComposer
				ref={props.composerRef}
				narratorId={props.narratorId}
				sendingRef={props.sendingRef}
				sending={props.isSending}
				appendInputRef={props.appendInputRef}
				permEnterActive={props.effectiveFocusIndex != null}
				hasAttachments={props.composerHasAttachments}
				enterMode={props.enterQueueMode}
				ctrlEnterMode={props.ctrlEnterQueueMode}
				onSendWithMode={props.onSendWithMode}
				onTextFlagsChange={props.setComposerHasText}
				onPasteImages={props.onComposerPasteImages}
				attachedImages={props.attachedImages}
				attachedTextFiles={props.attachedTextFiles}
				attachmentsHydrating={props.attachmentsHydrating}
				attachmentsRestoreFailed={props.attachmentsRestoreFailed}
				onRetryAttachments={props.onRetryAttachments}
				restoredAttachmentResources={props.restoredAttachmentResources}
				onAttachmentsChange={props.onAttachmentsChange}
				onDocumentAssetsChange={props.onDocumentAssetsChange}
				onAskSelection={props.onAskSelection}
				controls={
					<Tooltip label={t("attachFile")}>
						<ActionIcon
							aria-label={t("attachFile")}
							variant="subtle"
							color="gray"
							disabled={props.isSending}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								props.composerRef.current?.captureAttachmentSelection();
								props.fileInputRef.current?.click();
							}}
						>
							<IconPaperclip size={18} />
						</ActionIcon>
					</Tooltip>
				}
				actions={actions}
			/>
		</Box>
	);
}
