import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
	Anchor,
	Badge,
	Box,
	Button,
	CloseButton,
	Group,
	Image,
	Loader,
	Progress,
	Stack,
	Text,
} from "@mantine/core";
import { IconBolt, IconChevronDown, IconChevronUp, IconFile } from "@tabler/icons-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { startBottomSpacingResize, useBottomSpacing } from "../../hooks/useResizableBottomSpacing";
import type { BufferMessageSummary } from "../../lib/api";
import { ChapterBar } from "./ChapterBar";
import { HumanAttentionInboxButton } from "./GlobalQuestionInbox";
import {
	NarratorInteractionStatusBar,
	type NarratorInteractionStatusBarProps,
} from "./interaction/NarratorInteractionStatusBar";
import { NarratorComposerRow, type NarratorComposerRowProps } from "./NarratorComposerRow";
import { QueuedAttachmentPreview, QueuedMessageRow } from "./QueuedMessageRow";

/** Number of queued messages before the queue collapses into a summary bar. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

export interface NarratorInteractionAreaProps {
	// ── Attachments ──
	attachedImages: File[];
	attachedTextFiles: File[];
	imagePreviewUrls: string[];
	updateAttachedImages: React.Dispatch<React.SetStateAction<File[]>>;
	updateAttachedTextFiles: React.Dispatch<React.SetStateAction<File[]>>;
	formatFileSize: (size: number) => string;
	openImageViewer: (opts: { src: string; filename: string; alt: string }) => void;

	// ── Send / upload progress ──
	sendingState: {
		attachmentCount: number;
		progress: number | null;
		canCancel: boolean;
	} | null;
	cancelSending: () => void;

	// ── Queue state ──
	queuedMessages: BufferMessageSummary[];
	queueExpanded: boolean;
	setQueueExpanded: (expanded: boolean) => void;
	editingQueuedId: string | null;

	// ── Queue actions ──
	handleDragEndQueued: (event: DragEndEvent) => void;
	handleSaveEditQueued: (
		msg: BufferMessageSummary,
		text: string,
		payload: {
			keepImageIds: string[];
			keepTextFiles: { index: number; filename: string }[];
			newImages: File[];
			newTextFiles: File[];
		},
	) => Promise<boolean>;
	handleCancelEditQueued: () => void;
	handleStartEditQueued: (msg: BufferMessageSummary) => void;
	handleRemoveQueued: (id: string) => void;
	handleRetryQueued: (id: string) => Promise<{ ok: true; resumed: boolean }>;
	handleCancelAllQueued: () => void;

	// ── ChapterBar ──
	chapterId?: string | null;
	onOpenGitPanel?: () => void;

	// ── Status bar (fully described by the grouped-props contract) ──
	statusBar: NarratorInteractionStatusBarProps;

	// ── Human-attention inbox ──
	isWorkspacePreview: boolean;
	showHumanAttentionInbox: boolean;
	narratorId: string;

	// ── Composer row ──
	composerRowProps: NarratorComposerRowProps;

	// ── Merged-chapter read-only state ──
	isChapterMerged: boolean;
}

export function NarratorInteractionArea(props: NarratorInteractionAreaProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const bottomSpacing = useBottomSpacing();

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } }),
	);

	const hasImages = props.attachedImages.length > 0;

	return (
		<Box style={{ position: "relative", flexShrink: 0 }}>
			{/* Drag handle — top edge of the whole interaction area lets the user
			    resize the bottom spacing (see useResizableBottomSpacing). */}
			<Box
				onMouseDown={startBottomSpacingResize}
				style={{
					position: "absolute",
					top: -3,
					left: 0,
					right: 0,
					height: 6,
					cursor: "ns-resize",
					zIndex: 100,
				}}
			/>

			{/* Image previews */}
			{hasImages && (
				<Group
					pt="xs"
					px="md"
					pb={6}
					gap="xs"
					style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
				>
					{props.attachedImages.map((file, i) => (
						<Box
							key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
							pos="relative"
							style={{ display: "inline-block" }}
						>
							<Image
								src={props.imagePreviewUrls[i]}
								alt={file.name}
								radius="sm"
								h={60}
								w={60}
								fit="cover"
								style={{ cursor: "pointer" }}
								onClick={() =>
									props.openImageViewer({
										src: props.imagePreviewUrls[i],
										filename: file.name,
										alt: file.name,
									})
								}
							/>
							<CloseButton
								size="xs"
								radius="xl"
								variant="filled"
								color="dark"
								style={{ position: "absolute", top: -6, right: -6 }}
								onClick={() => props.updateAttachedImages((prev) => prev.filter((_, j) => j !== i))}
								title={t("removeImage")}
							/>
						</Box>
					))}
				</Group>
			)}

			{/* Text file previews */}
			{props.attachedTextFiles.length > 0 && (
				<Group
					pt="xs"
					px="md"
					pb={6}
					gap={6}
					wrap="wrap"
					style={{
						borderTop: hasImages ? undefined : "1px solid var(--mantine-color-default-border)",
						flexShrink: 0,
					}}
				>
					{props.attachedTextFiles.map((file, i) => (
						<Group
							key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
							gap={6}
							px="xs"
							py={4}
							wrap="nowrap"
							style={{
								borderRadius: "var(--mantine-radius-sm)",
								backgroundColor:
									"light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
								fontSize: "var(--mantine-font-size-xs)",
							}}
						>
							<IconFile size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
							<Text size="xs" truncate style={{ maxWidth: 160, minWidth: 0 }}>
								{file.name}
							</Text>
							<Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
								{props.formatFileSize(file.size)}
							</Text>
							<CloseButton
								size={16}
								iconSize={12}
								variant="transparent"
								c="dimmed"
								onClick={() =>
									props.updateAttachedTextFiles((prev) => prev.filter((_, j) => j !== i))
								}
							/>
						</Group>
					))}
				</Group>
			)}

			{/* Upload / send progress — shown while attachments are being uploaded
			    so the input area doesn't look empty after the draft is cleared. */}
			{props.sendingState && props.sendingState.attachmentCount > 0 && (
				<Stack
					gap={4}
					pt="xs"
					px="md"
					pb={6}
					style={{
						borderTop: "1px solid var(--mantine-color-default-border)",
						flexShrink: 0,
					}}
				>
					<Group gap="xs" wrap="nowrap" justify="space-between">
						{props.sendingState.progress !== null && props.sendingState.progress < 1 ? (
							<Text size="xs" c="dimmed">
								{t("uploadingAttachments", {
									percent: Math.round(props.sendingState.progress * 100),
								})}
							</Text>
						) : (
							<Group gap="xs" wrap="nowrap">
								<Loader size="xs" />
								<Text size="xs" c="dimmed">
									{t("sendingMessage")}
								</Text>
							</Group>
						)}
						{props.sendingState.canCancel && (
							<Anchor
								component="button"
								type="button"
								size="xs"
								c="dimmed"
								style={{ textDecoration: "underline", flexShrink: 0 }}
								onClick={props.cancelSending}
							>
								{tc("cancel")}
							</Anchor>
						)}
					</Group>
					{props.sendingState.progress !== null && props.sendingState.progress < 1 && (
						<Progress
							value={props.sendingState.progress * 100}
							size="sm"
							radius="xl"
							transitionDuration={150}
						/>
					)}
				</Stack>
			)}

			{/* Queued messages indicator */}
			{props.queuedMessages.length > 0 && (
				<Stack
					gap={0}
					style={{
						borderTop: hasImages ? undefined : "1px solid var(--mantine-color-default-border)",
						flexShrink: 0,
					}}
				>
					{props.queuedMessages.length > QUEUE_COLLAPSE_THRESHOLD && !props.queueExpanded ? (
						/* Collapsed summary bar */
						<Group
							component="button"
							px="md"
							py={4}
							gap="xs"
							wrap="nowrap"
							bg="var(--mantine-color-blue-light)"
							style={{ cursor: "pointer", border: "none", width: "100%", textAlign: "left" }}
							onClick={() => props.setQueueExpanded(true)}
							aria-expanded={false}
							aria-label={t("queuedCount", { count: props.queuedMessages.length })}
						>
							<IconChevronUp size={14} color="var(--mantine-color-blue-5)" />
							<Text size="xs" c="blue" fw={500} style={{ flexShrink: 0 }}>
								{t("queuedCount", { count: props.queuedMessages.length })}
							</Text>
							{props.queuedMessages.some((msg) => msg.state === "failed") && (
								<Badge color="red" size="xs" style={{ flexShrink: 0 }}>
									{t("queuedFailedCount", {
										count: props.queuedMessages.filter((msg) => msg.state === "failed").length,
									})}
								</Badge>
							)}
							<QueuedAttachmentPreview
								images={props.queuedMessages[0].images ?? []}
								textFiles={props.queuedMessages[0].textFiles ?? []}
							/>
							{props.queuedMessages[0].priority && (
								<Badge
									size="xs"
									color="orange"
									variant="light"
									leftSection={<IconBolt size={10} />}
									style={{ flexShrink: 0 }}
								>
									{t("queuedPriorityNextRequest")}
								</Badge>
							)}
							<Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
								{props.queuedMessages[0].text}
							</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								color="red"
								onClick={(e) => {
									e.stopPropagation();
									props.handleCancelAllQueued();
								}}
							>
								{t("clearAllQueued")}
							</Button>
						</Group>
					) : (
						/* Expanded full list */
						<>
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragEnd={props.handleDragEndQueued}
							>
								<SortableContext
									items={props.queuedMessages.map((m) => m.id)}
									strategy={verticalListSortingStrategy}
								>
									{props.queuedMessages.map((msg, index) => (
										<QueuedMessageRow
											key={msg.id}
											msg={msg}
											index={index}
											isEditing={props.editingQueuedId === msg.id}
											onSaveEdit={props.handleSaveEditQueued}
											onCancelEdit={props.handleCancelEditQueued}
											onStartEdit={props.handleStartEditQueued}
											onRemove={props.handleRemoveQueued}
											onRetry={props.handleRetryQueued}
											cancelBufferLabel={t("cancelBuffer")}
											editLabel={tc("edit")}
											priorityLabel={t("queuedPriority")}
											priorityNextRequestLabel={t("queuedPriorityNextRequest")}
										/>
									))}
								</SortableContext>
							</DndContext>
							{props.queuedMessages.length > 1 && (
								<Group
									px="md"
									py={2}
									justify="flex-end"
									gap="xs"
									style={{ backgroundColor: "var(--mantine-color-blue-light)" }}
								>
									{props.queuedMessages.length > QUEUE_COLLAPSE_THRESHOLD && (
										<Button
											size="compact-xs"
											variant="subtle"
											color="blue"
											onClick={() => props.setQueueExpanded(false)}
											leftSection={<IconChevronDown size={12} />}
											style={{ marginRight: "auto" }}
										>
											{t("collapseQueue")}
										</Button>
									)}
									<Button
										size="compact-xs"
										variant="subtle"
										color="red"
										onClick={props.handleCancelAllQueued}
									>
										{t("clearAllQueued")}
									</Button>
								</Group>
							)}
						</>
					)}
				</Stack>
			)}

			{/* Chapter bar — clicking the info strip opens the Git view. */}
			{props.chapterId && (
				<ChapterBar chapterId={props.chapterId} onOpenGitPanel={props.onOpenGitPanel} />
			)}

			{/* Status bar */}
			<NarratorInteractionStatusBar {...props.statusBar} />

			{/* Question inbox, directly above the composer. */}
			{!props.isWorkspacePreview && props.showHumanAttentionInbox && (
				<Box px="md" pb={4} style={{ flexShrink: 0 }}>
					<HumanAttentionInboxButton currentNarratorId={props.narratorId} />
				</Box>
			)}

			{/* Input */}
			{props.isWorkspacePreview ? null : props.isChapterMerged ? (
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
				<NarratorComposerRow {...props.composerRowProps} />
			)}

			{/* Resizable bottom spacing (shared across all sub-regions). */}
			<Box style={{ height: `${bottomSpacing}px`, flexShrink: 0 }} />
		</Box>
	);
}
