/** Shared historical editor: user messages use the semantic inline document;
 * assistant messages deliberately remain a plain-text edit. */
import { useRevertActionPreview } from "@frontend/hooks/useNarrator";
import { usePromptOptimize } from "@frontend/hooks/usePromptOptimize";
import { Box, Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { ComposerDocument } from "@shared/composer-document";
import {
	type DragEvent,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { type RevertActionConfirmOptions, shouldClearEditDraft } from "../../../lib/api/narrators";
import { UserAvatar } from "../../UserAvatar";
import { ComposerFullscreenModal } from "../composer/ComposerFullscreenModal";
import { readFileReferences } from "../composer/file-reference-input";
import {
	TextareaOptimizeControls,
	textareaOptimizeControlsWidth,
} from "../composer/TextareaOptimizeControls";
import type {
	ComposerEditSnapshot,
	ExistingComposerAttachment,
} from "../interaction/queued-attachment-edit";
import { RevertScopeConfirmModal } from "../permission/RevertScopeConfirmModal";
import { EditableComposerDocument } from "./EditableComposerDocument";
import { EditingMessageCtx } from "./EditingMessageCtx";

export {
	collectTextBlocksPreview,
	MAX_ASSISTANT_MESSAGE_EDIT_CHARS,
	MAX_USER_MESSAGE_EDIT_CHARS,
	resolveEditorInitialText,
} from "./message-edit-text";

/** Files dropped anywhere in the edit UI (portals included) belong to this message, never to
 * the outer composer's pending attachments; unhandled ones are dropped on the floor. */
function claimFileDrop(event: DragEvent<HTMLDivElement>) {
	if (event.dataTransfer.types.includes("Files")) event.preventDefault();
}

export interface MessageEditorPanelProps {
	messageRole: "user" | "assistant";
	narratorId?: string;
	messageId: string;
	imageNarratorId?: string;
	// biome-ignore lint/suspicious/noExplicitAny: persisted SDK blocks
	blocks: readonly any[];
	creator?: {
		id: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	initialText: string;
	/** Optional preloaded detail; absent values are fetched only while editing. */
	composerDocument?: ComposerDocument;
	isLastUserMessage?: boolean;
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		revertOpts: RevertActionConfirmOptions,
		opts?: Omit<ComposerEditSnapshot, "text" | "keepTextFiles" | "composerDocument"> & {
			composerDocument?: ComposerDocument;
		},
	) => Promise<boolean>;
	onEditAssistantMessage?: (messageId: string, newContent: string) => void;
	onClose: () => void;
}

export function MessageEditorPanel({
	messageRole,
	narratorId,
	messageId,
	imageNarratorId,
	blocks,
	creator,
	initialText,
	composerDocument,
	onEditAndRegenerate,
	onEditAssistantMessage,
	onClose,
}: MessageEditorPanelProps) {
	const { t } = useTranslation("narrator");
	const isUser = messageRole === "user";
	const [editContent, setEditContent] = useState(initialText);
	const [snapshot, setSnapshot] = useState<ComposerEditSnapshot>();
	const [showConfirmModal, setShowConfirmModal] = useState(false);
	const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
	const submitting = useRef(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const undo = useRef<string[]>([]);
	const [fullscreenOpened, { open: openFullscreen, close: closeFullscreen }] = useDisclosure(false);
	const optimizeHook = usePromptOptimize({
		narratorId: narratorId ?? "",
		messageId,
		textareaRef: textarea,
		onOptimized: setEditContent,
	});
	// Load while editing so a submit that restores nothing can skip the dialog.
	const previewTarget = useMemo(
		() => (isUser && narratorId ? { messageId } : null),
		[isUser, narratorId, messageId],
	);
	const preview = useRevertActionPreview(narratorId ?? "", "edit_and_regenerate", previewTarget);
	const revertPreview = preview.data;
	const revertPreviewLoading = preview.isLoading;
	const canSubmitEdit = isUser
		? !!snapshot &&
			(!!snapshot.text.trim() ||
				snapshot.fileReferences.length > 0 ||
				snapshot.composerDocument.assets.length > 0)
		: !!editContent.trim();

	const submitUserEdit = useCallback(
		async (revertOpts: RevertActionConfirmOptions) => {
			if (!messageId || !onEditAndRegenerate || !canSubmitEdit || !snapshot || submitting.current)
				return;
			submitting.current = true;
			setIsSubmittingEdit(true);
			try {
				// The compatibility text must match the document exactly, not a separately trimmed copy.
				const result: unknown = await onEditAndRegenerate(
					messageId,
					snapshot.text,
					revertOpts,
					snapshot,
				);
				if (shouldClearEditDraft(result)) {
					setShowConfirmModal(false);
					onClose();
				}
			} finally {
				// The submitted plan is spent either way. Load a fresh one so a retry
				// after a failed save is judged against current state, never the old plan.
				preview.invalidate();
				preview.reload();
				submitting.current = false;
				setIsSubmittingEdit(false);
			}
		},
		[
			messageId,
			onEditAndRegenerate,
			canSubmitEdit,
			snapshot,
			onClose,
			preview.invalidate,
			preview.reload,
		],
	);
	const confirm = useCallback(() => {
		if (!isUser) {
			if (!messageId || !onEditAssistantMessage || !editContent.trim()) return;
			onEditAssistantMessage(messageId, editContent.trim());
			onClose();
			return;
		}
		if (!canSubmitEdit || submitting.current) return;
		// A complete, reviewed plan that restores no files and removes no later
		// messages has nothing to confirm; submit it as-is. Anything else asks.
		const plan = revertPreview?.revertPlan;
		const noop =
			!revertPreviewLoading &&
			!revertPreview?.previewIssue &&
			plan?.status === "prepared" &&
			!!plan.planHash &&
			plan.coverageComplete &&
			plan.filesComplete &&
			plan.expectedFileCount === 0 &&
			plan.previewKey === preview.previewKey &&
			preview.historySummary?.deletedMessageCount === 0;
		if (noop && plan?.planHash) {
			void submitUserEdit({
				skipRevert: false,
				revertPlan: { planId: plan.planId, planHash: plan.planHash, action: plan.action },
			});
			return;
		}
		setShowConfirmModal(true);
	}, [
		isUser,
		messageId,
		onEditAssistantMessage,
		editContent,
		onClose,
		canSubmitEdit,
		revertPreview,
		revertPreviewLoading,
		preview.previewKey,
		preview.historySummary,
		submitUserEdit,
	]);
	const editingCtx = useContext(EditingMessageCtx);
	const confirmRef = useRef(confirm);
	confirmRef.current = confirm;
	useEffect(() => {
		const timer = setTimeout(() => textarea.current?.focus(), 50);
		return () => {
			clearTimeout(timer);
			editingCtx.unregister();
		};
	}, [editingCtx]);
	useEffect(() => {
		editingCtx.register({
			submit: () => confirmRef.current(),
			canSubmit: canSubmitEdit && !isSubmittingEdit,
			isSubmitting: isSubmittingEdit,
		});
	}, [canSubmitEdit, isSubmittingEdit, editingCtx]);

	if (!isUser)
		return (
			<Box display="contents" onDrop={claimFileDrop}>
				<Paper p="sm" radius="md" withBorder>
					<Stack gap="xs">
						<Text size="xs" fw={600} c="dimmed">
							{t("editAssistantTitle")}
						</Text>
						<Textarea
							ref={textarea}
							value={editContent}
							onCompositionStart={() => {
								composing.current = true;
							}}
							onCompositionEnd={() => {
								composing.current = false;
							}}
							onChange={(event) => {
								const next = event.currentTarget.value;
								if (next !== editContent) {
									undo.current.push(editContent);
									if (undo.current.length > 100) undo.current.shift();
								}
								setEditContent(next);
							}}
							onKeyDown={(event) => {
								if (
									composing.current ||
									event.nativeEvent.isComposing ||
									event.nativeEvent.keyCode === 229
								)
									return;
								if (
									(event.ctrlKey || event.metaKey) &&
									!event.shiftKey &&
									event.key.toLowerCase() === "z"
								) {
									const previous = undo.current.pop();
									if (previous !== undefined) {
										event.preventDefault();
										setEditContent(previous);
									}
									return;
								}
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									confirm();
								}
							}}
							autosize
							minRows={3}
							maxRows={16}
							rightSection={
								<TextareaOptimizeControls
									disabled={!editContent.trim() || optimizeHook.loading}
									loading={optimizeHook.loading}
									withContext={optimizeHook.withContext}
									onToggleContext={optimizeHook.toggleContext}
									onOptimize={optimizeHook.handleOptimize}
									onCancelOptimize={optimizeHook.cancelOptimize}
									onExpand={() => {
										optimizeHook.cancelOptimize();
										openFullscreen();
									}}
									contextMessageCount={optimizeHook.contextMessageCount}
									onContextMessageCountChange={optimizeHook.setContextMessageCount}
								/>
							}
							rightSectionWidth={textareaOptimizeControlsWidth(true)}
						/>
						<Text size="xs" c="dimmed">
							{t("editAssistantHint")}
						</Text>
						<Group gap="xs" justify="flex-end">
							<Button size="xs" variant="subtle" onClick={onClose}>
								{t("editCancel")}
							</Button>
							<Button size="xs" onClick={confirm} disabled={!editContent.trim()}>
								{t("editAssistantSubmit")}
							</Button>
						</Group>
					</Stack>
				</Paper>
				<ComposerFullscreenModal
					opened={fullscreenOpened}
					onClose={closeFullscreen}
					initialText={editContent}
					onSubmit={(text) => {
						setEditContent(text);
						closeFullscreen();
						requestAnimationFrame(() => textarea.current?.focus());
					}}
					optimizeHook={optimizeHook}
					narratorId={narratorId}
					messageId={messageId}
				/>
			</Box>
		);

	const attachments: ExistingComposerAttachment[] = [
		...blocks
			.filter((block) => block.type === "image" && typeof block.imageId === "string")
			.map((block) => ({
				kind: "image" as const,
				imageId: block.imageId,
				name: block.filename ?? "image",
				size: block.size ?? 0,
				mimeType:
					block.sourceMimeType ??
					block.mediaType ??
					block.mimeType ??
					block.source?.media_type ??
					"image/png",
				uploadNarratorId: block.uploadNarratorId ?? imageNarratorId ?? narratorId,
				previewUrl: block.previewUrl,
			})),
		...blocks
			.filter((block) => block.type === "text_file" && typeof block.filePath === "string")
			.map((block) => ({
				kind: "textFile" as const,
				filePath: block.filePath,
				name: block.filename ?? "file",
				size: block.size ?? 0,
				mimeType: block.mimeType ?? "text/plain",
			})),
	];
	return (
		<Box display="contents" onDrop={claimFileDrop}>
			<Paper p="sm" radius="md" style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}>
				<Stack gap="xs">
					<Group gap={6}>
						{creator && (
							<UserAvatar
								username={creator.username}
								avatarColor={creator.avatarColor}
								avatarImageId={creator.avatarImageId}
								userId={creator.id}
								size={20}
								showTooltip={false}
							/>
						)}
						<Text size="xs" fw={600} c="indigo">
							{creator?.username ?? t("you")}
						</Text>
					</Group>
					<EditableComposerDocument
						key={messageId}
						text={initialText}
						attachments={attachments}
						fileReferences={readFileReferences(
							blocks
								.filter((block) => block.type === "file_reference")
								.map((block) => block.reference),
						)}
						composerDocument={composerDocument}
						loadDocument={
							narratorId
								? (signal) => api.getMessageComposerDocument(narratorId, messageId, signal)
								: undefined
						}
						onChange={setSnapshot}
						disabled={isSubmittingEdit}
						narratorId={narratorId}
						messageId={messageId}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								confirm();
							}
						}}
					/>
					<Group gap="xs" justify="flex-end">
						<Button size="xs" variant="subtle" onClick={onClose} disabled={isSubmittingEdit}>
							{t("editCancel")}
						</Button>
						<Button
							size="xs"
							onClick={confirm}
							disabled={!canSubmitEdit || isSubmittingEdit}
							loading={isSubmittingEdit}
						>
							{t("editSubmit")}
						</Button>
					</Group>
				</Stack>
			</Paper>
			<RevertScopeConfirmModal
				opened={showConfirmModal}
				title={t("editRevertConfirmTitle")}
				description={
					(preview.historySummary?.deletedMessageCount ?? 0) > 0
						? t("editRevertConfirmDesc", {
								messageCount: preview.historySummary?.deletedMessageCount ?? 0,
							})
						: t("editRevertConfirmDescNoMessages")
				}
				data={revertPreview}
				previewKey={preview.previewKey}
				onReload={preview.reload}
				onRequestSnapshotRestore={preview.requestSnapshotRestore}
				isLoading={revertPreviewLoading}
				submitting={isSubmittingEdit}
				confirmWithRevertLabel={t("editRevertConfirmWithRevert")}
				confirmNoFilesLabel={t("editRevertConfirmNoFiles")}
				messagesOnlyLabel={t("editRevertConfirmMessagesOnly")}
				onConfirm={(opts) => void submitUserEdit(opts)}
				onCancel={() => {
					if (!isSubmittingEdit) setShowConfirmModal(false);
				}}
			/>
		</Box>
	);
}
