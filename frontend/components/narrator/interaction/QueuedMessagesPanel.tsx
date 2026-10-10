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
import { restrictToVerticalAxis } from "@frontend/lib/dnd-modifiers";
import { ActionIcon, Button, Group, Menu, Stack, Text } from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconDotsVertical } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BufferMessageSummary } from "../../../lib/api";
import type { QueueMode } from "../composer/SendOptionsSplitButton";
import { QueuedMessageRow } from "./QueuedMessageRow";
import { queuedMessageMode } from "./queue-message-mode";
import type { UrgentDispatch } from "./use-queued-message-actions";

export interface QueuedMessagesData {
	narratorId?: string;
	queuedMessages: BufferMessageSummary[];
	urgentDispatches?: UrgentDispatch[];
	queueExpanded: boolean;
	setQueueExpanded: (expanded: boolean) => void;
	editingQueuedId: string | null;
	handleDragEndQueued: (event: DragEndEvent) => void;
	handleMoveQueued: (id: string, direction: -1 | 1) => void;
	handleChangeMode: (id: string, mode: QueueMode) => Promise<boolean> | Promise<void>;
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
export type QueuedMessagesPanelProps = QueuedMessagesData;

export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } }),
	);
	const urgent = (props.urgentDispatches ?? []).filter((entry) => entry.status !== "sent");
	const trackedIds = new Set((props.urgentDispatches ?? []).map((entry) => entry.message.id));
	for (const message of props.queuedMessages) {
		if (
			queuedMessageMode(message) === "interrupt" &&
			!trackedIds.has(message.id) &&
			message.id !== props.editingQueuedId
		) {
			urgent.push({ message, status: "failed" });
		}
	}
	const queuedMessages = props.queuedMessages.filter(
		(message) =>
			(queuedMessageMode(message) !== "interrupt" || message.id === props.editingQueuedId) &&
			!trackedIds.has(message.id),
	);
	if (queuedMessages.length === 0 && urgent.length === 0) return null;
	// Consecutive segments preserve the authoritative FIFO order across guidance modes.
	const groups: { mode: QueueMode; messages: BufferMessageSummary[] }[] = [];
	for (const message of queuedMessages) {
		// An asynchronous snapshot may change an open editor's mode. Keep that
		// keyed editor in place until it closes; urgent controls are disabled there.
		const rawMode = queuedMessageMode(message);
		const mode = rawMode === "interrupt" ? "turn" : rawMode;
		const previous = groups[groups.length - 1];
		if (previous?.mode === mode) previous.messages.push(message);
		else groups.push({ mode, messages: [message] });
	}
	const counts = (["turn", "tool"] as const)
		.map((mode) => ({
			mode,
			count: queuedMessages.filter((message) => queuedMessageMode(message) === mode).length,
		}))
		.filter(({ count }) => count > 0);
	const ordinaryIds = queuedMessages
		.filter((message) => queuedMessageMode(message) === "turn")
		.map((message) => message.id);
	const single = queuedMessages.length === 1;
	const hasActiveEditor =
		typeof props.editingQueuedId === "string" &&
		queuedMessages.some((msg) => msg.id === props.editingQueuedId);
	// Pin an active editor open, including single-to-multiple queue transitions.
	// Manual collapse is unavailable until editing ends; keep the user's preference unchanged.
	const listVisible = props.queueExpanded || single || hasActiveEditor;
	const failures = queuedMessages.filter((msg) => msg.state === "failed").length;
	return (
		<Stack
			gap={0}
			style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
		>
			{urgent.length > 0 && (
				<Stack
					gap={0}
					data-urgent-dispatches
					style={{ maxHeight: "min(32vh, 280px)", overflowY: "auto" }}
				>
					{urgent.map((dispatch) => (
						<QueuedMessageRow
							key={dispatch.message.id}
							msg={dispatch.message}
							narratorId={props.narratorId}
							index={0}
							isEditing={false}
							urgentStatus={dispatch.status === "sending" ? "sending" : "failed"}
							urgentError={dispatch.error}
							onSaveEdit={props.handleSaveEditQueued}
							onCancelEdit={props.handleCancelEditQueued}
							onStartEdit={props.handleStartEditQueued}
							onRemove={props.handleRemoveQueued}
							onRetry={props.handleRetryQueued}
							onChangeMode={props.handleChangeMode}
							onMove={props.handleMoveQueued}
							cancelBufferLabel={t("cancelBuffer")}
							editLabel={tc("edit")}
						/>
					))}
				</Stack>
			)}
			{queuedMessages.length > 1 && (
				<Group px="md" py={2} gap="xs" wrap="wrap" data-queue-summary>
					<Button
						size="compact-xs"
						variant="subtle"
						color="gray"
						onClick={() => props.setQueueExpanded(!props.queueExpanded)}
						disabled={hasActiveEditor}
						aria-expanded={listVisible}
						leftSection={listVisible ? <IconChevronDown size={12} /> : <IconChevronUp size={12} />}
					>
						{t("queuedCount", { count: queuedMessages.length })}
					</Button>
					<Text
						size="xs"
						c="dimmed"
						style={{ flex: "1 1 140px", minWidth: 0, overflowWrap: "anywhere" }}
					>
						{counts.map(({ mode, count }) => `${t(`queueMode_${mode}`)} ${count}`).join(" · ")}
					</Text>
					{failures > 0 && (
						<Text size="xs" c="red">
							{t("queuedFailedCount", { count: failures })}
						</Text>
					)}
					<Menu position="top-end" withinPortal>
						<Menu.Target>
							<ActionIcon variant="subtle" color="gray" size="sm" aria-label={t("queuedActions")}>
								<IconDotsVertical size={14} />
							</ActionIcon>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Item color="red" onClick={props.handleCancelAllQueued}>
								{t("clearAllQueued")}
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>
				</Group>
			)}
			{listVisible && (
				<Stack gap={0} style={{ maxHeight: "min(32vh, 280px)", overflowY: "auto" }}>
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={[restrictToVerticalAxis]}
						onDragEnd={props.handleDragEndQueued}
					>
						<SortableContext items={ordinaryIds} strategy={verticalListSortingStrategy}>
							{/* Rows stay keyed siblings even when FIFO segments split, merge or lose a head.
							    A keyed group wrapper would remount them and discard unsaved edits. */}
							{groups.flatMap(({ mode, messages }) => [
								<Text key={`heading:${messages[0].id}`} size="xs" c="dimmed" px="md" py={2}>
									{t(`queueMode_${mode}`)}
								</Text>,
								...messages.map((msg, index) => (
									<QueuedMessageRow
										key={msg.id}
										msg={msg}
										narratorId={props.narratorId}
										index={index}
										canMoveUp={ordinaryIds.indexOf(msg.id) > 0}
										canMoveDown={ordinaryIds.indexOf(msg.id) < ordinaryIds.length - 1}
										onClearAll={single ? props.handleCancelAllQueued : undefined}
										isEditing={props.editingQueuedId === msg.id}
										onSaveEdit={props.handleSaveEditQueued}
										onCancelEdit={props.handleCancelEditQueued}
										onStartEdit={props.handleStartEditQueued}
										onRemove={props.handleRemoveQueued}
										onRetry={props.handleRetryQueued}
										onChangeMode={props.handleChangeMode}
										onMove={props.handleMoveQueued}
										cancelBufferLabel={t("cancelBuffer")}
										editLabel={tc("edit")}
									/>
								)),
							])}
						</SortableContext>
					</DndContext>
				</Stack>
			)}
		</Stack>
	);
}
