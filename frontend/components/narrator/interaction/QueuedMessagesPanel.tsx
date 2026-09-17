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
import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconBolt, IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BufferMessageSummary } from "../../../lib/api";
import { QueuedAttachmentPreview, QueuedMessageRow } from "./QueuedMessageRow";

/** Number of queued messages before the queue collapses into a summary bar. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

/**
 * The queue state + handlers, assembled once by the panel and threaded through
 * NarratorInteractionArea as a single `queue` group (mirrors `statusBarInputs`).
 * Excludes `hasImages`, which the interaction area derives from its attachments.
 */
export interface QueuedMessagesData {
	queuedMessages: BufferMessageSummary[];
	queueExpanded: boolean;
	setQueueExpanded: (expanded: boolean) => void;
	editingQueuedId: string | null;
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
}

export interface QueuedMessagesPanelProps extends QueuedMessagesData {
	hasImages: boolean;
}

/**
 * The queued-messages region above the composer: a collapsed summary bar past the
 * collapse threshold, or the full drag-reorderable list. Owns its own DnD sensors.
 */
export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } }),
	);

	if (props.queuedMessages.length === 0) return null;

	return (
		<Stack
			gap={0}
			style={{
				borderTop: props.hasImages ? undefined : "1px solid var(--mantine-color-default-border)",
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
	);
}
