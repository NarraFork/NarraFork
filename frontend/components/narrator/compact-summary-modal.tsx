/**
 * Compact-summary modal and its supporting types/helpers.
 *
 * Extracted from MessageBubble.tsx: the modal is opened from the narrator shell
 * (NarratorPanel) and from the vlist compact bridge, neither of which should
 * depend on the message-bubble component tree. The modal styles and query-gc
 * constant are also consumed by the compact indicators in MessageBubble, which
 * import them back from here.
 */

import {
	Box,
	Button,
	Group,
	Loader,
	Modal,
	Paper,
	Select,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { type CompactMessageDetail, isCompactRetryableDetail } from "@shared/compact-message";
import { IconArrowsMinimize } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import { api } from "../../lib/api";
import type { RetryFailedCompactResponse } from "../../lib/api/narrators";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { MarkdownContent } from "./MarkdownContent";

export const COMPACTING_MARKER_ATTR = "data-compacting-marker";
export const COMPACT_DETAIL_QUERY_GC_TIME_MS = 30_000;

/**
 * Compact-summary dialogs render arbitrarily long markdown. With Mantine's
 * default layout the whole body scrolls, so the action bar (revoke / edit /
 * retry) ends up far below the fold and the user has to scroll a long summary
 * to reach it. Instead the content shell becomes a flex column that never
 * scrolls: the sticky header stays put, only the summary column scrolls, and
 * the actions stay docked at the bottom edge.
 */
export const COMPACT_SUMMARY_MODAL_STYLES = {
	content: {
		display: "flex",
		flexDirection: "column" as const,
		// Mantine's own `overflow-y: auto` here would let the footer scroll away.
		overflow: "hidden",
	},
	// Flex items shrink by default; the title row must keep its full height even
	// when a long summary fills the dialog.
	header: { flexShrink: 0 },
	body: {
		// `1 1 auto` (not `flex: 1`) so a short summary still yields a short modal:
		// the base size stays content-driven and only shrinks once the content
		// shell hits its max-height.
		flex: "1 1 auto",
		minHeight: 0,
		display: "flex",
		flexDirection: "column" as const,
		overflow: "hidden",
		// The scroll column and footer carry their own padding so the divider can
		// span the full modal width.
		padding: 0,
	},
};
export const COMPACT_SUMMARY_SCROLL_STYLE = {
	flex: 1,
	minHeight: 0,
	overflowY: "auto" as const,
	overscrollBehavior: "contain" as const,
	padding: "var(--mantine-spacing-md)",
	paddingTop: 0,
};
export const COMPACT_SUMMARY_FOOTER_STYLE = {
	flexShrink: 0,
	borderTop: "1px solid var(--mantine-color-default-border)",
	padding: "var(--mantine-spacing-sm) var(--mantine-spacing-md)",
};

export type CompactSummaryKind = "context" | "segment";

export interface CompactSummaryModalTarget {
	kind: CompactSummaryKind;
	narratorId: string;
	messageId: string;
	onDelete?: () => void;
	/** Open directly in edit mode (e.g. for the manual summarize flow). */
	autoEdit?: boolean;
}

export function compactSummaryQueryKey(narratorId: string, messageId: string) {
	return ["compact-summary", narratorId, messageId] as const;
}

export interface CompactRetryTargetMigration {
	nextMessageId: string;
	retiredMessageIds: string[];
	changed: boolean;
}

export function resolveCompactRetryTargetMigration(
	currentMessageId: string,
	response: Partial<RetryFailedCompactResponse>,
): CompactRetryTargetMigration {
	const nextMessageId =
		typeof response.messageId === "string" && response.messageId.length > 0
			? response.messageId
			: currentMessageId;
	const retiredMessageIds = new Set<string>();
	for (const messageId of [currentMessageId, response.oldMessageId, response.replacedMessageId]) {
		if (typeof messageId === "string" && messageId.length > 0 && messageId !== nextMessageId) {
			retiredMessageIds.add(messageId);
		}
	}
	return {
		nextMessageId,
		retiredMessageIds: [...retiredMessageIds],
		changed: nextMessageId !== currentMessageId,
	};
}

/**
 * Resolve a COW replacement directly from a WS frame. The HTTP response is not
 * required: old IDs may be listed as deletion aliases while the replacement is
 * exposed as `messageId`, `newMessageId`, `replacementMessageId`, or the updated
 * message's own ID. Frames without both sides are ordinary deletions/updates.
 */
export function resolveCompactReplacementEvent(
	currentMessageId: string,
	event: Record<string, unknown>,
): CompactRetryTargetMigration | null {
	const oldIds = new Set<string>();
	for (const value of [event.oldMessageId, event.replacedMessageId]) {
		if (typeof value === "string" && value) oldIds.add(value);
	}
	if (Array.isArray(event.deletedMessageIds)) {
		for (const value of event.deletedMessageIds) {
			if (typeof value === "string" && value) oldIds.add(value);
		}
	}
	const message = event.message;
	const nestedMessageId =
		message && typeof message === "object" && !Array.isArray(message)
			? (message as { id?: unknown }).id
			: undefined;
	if (!oldIds.has(currentMessageId)) {
		// Once the modal has already switched, a duplicate WS frame should still
		// clean the retired key, but unrelated narrator deletions must be ignored.
		const currentIsCandidate = [
			event.messageId,
			event.newMessageId,
			event.replacementMessageId,
			nestedMessageId,
		].some((value) => value === currentMessageId);
		if (!currentIsCandidate) return null;
	}

	const candidates: string[] = [];
	for (const value of [
		event.newMessageId,
		event.replacementMessageId,
		event.messageId,
		nestedMessageId,
	]) {
		if (typeof value === "string" && value && !candidates.includes(value)) candidates.push(value);
	}
	const nextMessageId = candidates.find((value) => !oldIds.has(value));
	if (!nextMessageId || (nextMessageId === currentMessageId && oldIds.size === 0)) return null;

	const retiredMessageIds = [...oldIds].filter((value) => value !== nextMessageId);
	return {
		nextMessageId,
		retiredMessageIds,
		changed: nextMessageId !== currentMessageId,
	};
}

export const CompactSummaryModalCtx = createContext<{
	open: (target: CompactSummaryModalTarget) => void;
} | null>(null);

export function CompactSummaryModal({
	target,
	onClose,
}: {
	target: CompactSummaryModalTarget | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const { visibleModels, summaryModelValue } = useAllModels();
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const [retryModel, setRetryModel] = useState<string | null>(null);
	const sourceTargetKey = target ? `${target.kind}:${target.narratorId}:${target.messageId}` : null;
	const [retryTargetOverride, setRetryTargetOverride] = useState<{
		sourceTargetKey: string;
		messageId: string;
	} | null>(null);
	const pendingRetryMigrationRef = useRef<{
		narratorId: string;
		nextMessageId: string;
		retiredMessageIds: string[];
		onDelete?: () => void;
	} | null>(null);
	const activeTarget =
		target && retryTargetOverride?.sourceTargetKey === sourceTargetKey
			? { ...target, messageId: retryTargetOverride.messageId }
			: target;
	const activeTargetKind = activeTarget?.kind;
	const activeTargetNarratorId = activeTarget?.narratorId;
	const activeTargetMessageId = activeTarget?.messageId;
	const isSegment = activeTargetKind === "segment";
	const queryKey = activeTarget
		? isSegment
			? (["segment-compact-summary", activeTarget.narratorId, activeTarget.messageId] as const)
			: compactSummaryQueryKey(activeTarget.narratorId, activeTarget.messageId)
		: (["compact-summary", "closed"] as const);
	const targetKey = activeTarget
		? `${activeTarget.kind}:${activeTarget.narratorId}:${activeTarget.messageId}`
		: null;
	const activeTargetRef = useRef<CompactSummaryModalTarget | null>(activeTarget);
	activeTargetRef.current = activeTarget;
	const sourceTargetKeyRef = useRef(sourceTargetKey);
	sourceTargetKeyRef.current = sourceTargetKey;

	const applyCompactReplacement = useCallback(
		(event: Record<string, unknown>) => {
			const currentTarget = activeTargetRef.current;
			if (!currentTarget || currentTarget.kind !== "context") return;
			const migration = resolveCompactReplacementEvent(currentTarget.messageId, event);
			if (!migration) return;
			const currentQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				currentTarget.messageId,
			);
			const currentDetail = queryClient.getQueryData<CompactMessageDetail>(currentQueryKey);
			const retiredMessageIds = new Set(migration.retiredMessageIds);
			if (migration.changed) retiredMessageIds.add(currentTarget.messageId);
			for (const retiredMessageId of retiredMessageIds) {
				void queryClient.cancelQueries({
					queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
					exact: true,
				});
				queryClient.removeQueries({
					queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
					exact: true,
				});
			}

			const nextQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				migration.nextMessageId,
			);
			const existingNextDetail = queryClient.getQueryData<CompactMessageDetail>(nextQueryKey);
			if (migration.changed || existingNextDetail?.status !== "compacted") {
				queryClient.setQueryData<CompactMessageDetail>(nextQueryKey, {
					...currentDetail,
					...existingNextDetail,
					status: "compacting",
					summary: existingNextDetail?.summary ?? currentDetail?.summary ?? "",
					error: undefined,
					attempts: existingNextDetail?.attempts ?? currentDetail?.attempts ?? [],
					canRetry: false,
				});
			}

			if (!migration.changed) {
				// A duplicate frame after the HTTP response has already migrated the
				// modal must still clean stale aliases. Do not regress a completed
				// detail back to `compacting` or issue a second fetch.
				if (existingNextDetail?.status !== "compacted") {
					void queryClient.invalidateQueries({ queryKey: nextQueryKey, exact: true });
				}
				return;
			}

			const sourceKey =
				sourceTargetKeyRef.current ??
				`${currentTarget.kind}:${currentTarget.narratorId}:${currentTarget.messageId}`;
			const pending = pendingRetryMigrationRef.current;
			if (
				!pending ||
				pending.narratorId !== currentTarget.narratorId ||
				pending.nextMessageId !== migration.nextMessageId
			) {
				pendingRetryMigrationRef.current = {
					narratorId: currentTarget.narratorId,
					nextMessageId: migration.nextMessageId,
					retiredMessageIds: [...retiredMessageIds],
					onDelete: currentTarget.onDelete,
				};
			} else {
				pending.retiredMessageIds = [
					...new Set([...pending.retiredMessageIds, ...retiredMessageIds]),
				];
			}
			setRetryTargetOverride((previous) =>
				previous?.sourceTargetKey === sourceKey && previous.messageId === migration.nextMessageId
					? previous
					: { sourceTargetKey: sourceKey, messageId: migration.nextMessageId },
			);
		},
		[queryClient],
	);

	useEffect(() => {
		const narratorId = target?.narratorId;
		if (!narratorId) return;
		const listener = narratorWSManager.addListener(
			{
				narratorIds: [narratorId],
				types: [
					"messages_deleted",
					"message_replaced",
					"message_updated",
					"compact_done",
					"compact_failed",
				],
			},
			applyCompactReplacement,
		);
		return () => narratorWSManager.removeListener(listener);
	}, [applyCompactReplacement, target?.narratorId]);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey,
		queryFn: async () => {
			if (!activeTarget) return { summary: "" };
			return isSegment
				? api.getSegmentCompactSummary(activeTarget.narratorId, activeTarget.messageId)
				: api.getCompactSummary(activeTarget.narratorId, activeTarget.messageId);
		},
		enabled: !!activeTarget,
		gcTime: COMPACT_DETAIL_QUERY_GC_TIME_MS,
		refetchInterval: (query) =>
			!isSegment && (query.state.data as CompactMessageDetail | undefined)?.status === "compacting"
				? 1_000
				: false,
	});
	const compactDetail = !isSegment ? (data as CompactMessageDetail | undefined) : undefined;
	const failed = compactDetail?.status === "failed";
	const canRetry = compactDetail ? isCompactRetryableDetail(compactDetail) : false;
	const retryModelOptions = useMemo(
		() => visibleModels.map((model) => ({ value: model.value, label: model.label })),
		[visibleModels],
	);
	const previousSourceTargetKeyRef = useRef(sourceTargetKey);

	useEffect(() => {
		if (previousSourceTargetKeyRef.current === sourceTargetKey) return;
		previousSourceTargetKeyRef.current = sourceTargetKey;
		setRetryTargetOverride(null);
	}, [sourceTargetKey]);

	useEffect(() => {
		const pending = pendingRetryMigrationRef.current;
		if (
			!pending ||
			activeTargetKind !== "context" ||
			activeTargetNarratorId !== pending.narratorId ||
			activeTargetMessageId !== pending.nextMessageId
		) {
			return;
		}
		pendingRetryMigrationRef.current = null;
		for (const retiredMessageId of pending.retiredMessageIds) {
			queryClient.removeQueries({
				queryKey: compactSummaryQueryKey(pending.narratorId, retiredMessageId),
				exact: true,
			});
		}
		pending.onDelete?.();
		void queryClient.invalidateQueries({
			queryKey: compactSummaryQueryKey(pending.narratorId, pending.nextMessageId),
			exact: true,
		});
	}, [activeTargetKind, activeTargetNarratorId, activeTargetMessageId, queryClient]);

	useEffect(() => {
		if (!targetKey) {
			setEditing(false);
			setEditText("");
			setDeleting(false);
			setSaving(false);
			setRetrying(false);
			setRetryModel(null);
			return;
		}
		setEditing(false);
		setEditText("");
		setDeleting(false);
		setSaving(false);
		setRetrying(false);
		setRetryModel(null);
	}, [targetKey]);

	useEffect(() => {
		if (!canRetry) return;
		const availableModels = new Set(retryModelOptions.map((model) => model.value));
		if (retryModel && availableModels.has(retryModel)) return;
		const lastAttemptModel = compactDetail?.attempts.at(-1)?.model;
		const preferredModel = [lastAttemptModel, summaryModelValue].find(
			(model): model is string => typeof model === "string" && availableModels.has(model),
		);
		setRetryModel(preferredModel ?? retryModelOptions[0]?.value ?? null);
	}, [canRetry, compactDetail?.attempts, retryModel, retryModelOptions, summaryModelValue]);

	useEffect(() => {
		if (!activeTarget?.autoEdit || isLoading) return;
		setEditText(data?.summary ?? "");
		setEditing(true);
	}, [activeTarget?.autoEdit, isLoading, data?.summary]);

	const handleClose = () => {
		pendingRetryMigrationRef.current = null;
		setRetryTargetOverride(null);
		onClose();
		setEditing(false);
	};

	const handleDelete = async () => {
		if (!activeTarget) return;
		const currentTarget = activeTarget;
		setDeleting(true);
		try {
			if (currentTarget.kind === "segment") {
				await api.deleteSegmentCompact(currentTarget.narratorId, currentTarget.messageId);
			} else {
				await api.deleteCompactMessage(currentTarget.narratorId, currentTarget.messageId);
			}
			handleClose();
			currentTarget.onDelete?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
			});
		} finally {
			setDeleting(false);
		}
	};

	const handleSave = async () => {
		if (!activeTarget) return;
		setSaving(true);
		try {
			if (activeTarget.kind === "segment") {
				await api.updateSegmentCompactSummary(
					activeTarget.narratorId,
					activeTarget.messageId,
					editText,
				);
			} else {
				await api.updateCompactSummary(activeTarget.narratorId, activeTarget.messageId, editText);
			}
			queryClient.setQueryData(queryKey, { ...data, summary: editText });
			setEditing(false);
			refetch();
		} catch (err) {
			// Without this the rejection escaped through onClick: the editor stayed open
			// with the user's text intact but NOTHING said the save had failed, so the
			// obvious reading was that it had worked. The other two actions in this modal
			// (delete / retry) both report their failures; this one did not.
			//
			// Editing state is deliberately left ON — the text is still in the editor and
			// the user can retry or copy it out. Closing it here would discard the edit.
			notifications.show({
				title: t("saveCompactSummaryFailed"),
				message: err instanceof Error ? err.message : t("saveCompactSummaryFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setSaving(false);
		}
	};

	const handleRetry = async () => {
		if (!activeTarget || activeTarget.kind === "segment" || !canRetry) return;
		const currentTarget = activeTarget;
		setRetrying(true);
		try {
			const response = await api.retryFailedCompact(
				currentTarget.narratorId,
				currentTarget.messageId,
				retryModel ?? undefined,
			);
			const migration = resolveCompactRetryTargetMigration(currentTarget.messageId, response);
			await Promise.all(
				migration.retiredMessageIds.map((retiredMessageId) =>
					queryClient.cancelQueries({
						queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
						exact: true,
					}),
				),
			);
			const nextQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				migration.nextMessageId,
			);
			queryClient.setQueryData<CompactMessageDetail>(nextQueryKey, {
				...compactDetail,
				status: "compacting",
				summary: compactDetail?.summary ?? "",
				error: undefined,
				attempts: compactDetail?.attempts ?? [],
				canRetry: false,
			});
			if (migration.changed) {
				const retrySourceTargetKey =
					sourceTargetKey ??
					`${currentTarget.kind}:${currentTarget.narratorId}:${currentTarget.messageId}`;
				pendingRetryMigrationRef.current = {
					narratorId: currentTarget.narratorId,
					nextMessageId: migration.nextMessageId,
					retiredMessageIds: migration.retiredMessageIds,
					onDelete: currentTarget.onDelete,
				};
				setRetryTargetOverride({
					sourceTargetKey: retrySourceTargetKey,
					messageId: migration.nextMessageId,
				});
			} else {
				// WS may already have switched the modal before the POST response arrives.
				// Treat the response as an idempotent refresh, not a second deletion callback.
				for (const retiredMessageId of migration.retiredMessageIds) {
					queryClient.removeQueries({
						queryKey: compactSummaryQueryKey(currentTarget.narratorId, retiredMessageId),
						exact: true,
					});
				}
				await queryClient.invalidateQueries({ queryKey: nextQueryKey, exact: true });
			}
		} catch (err) {
			notifications.show({
				title: t("retryCompactFailed"),
				message: err instanceof Error ? err.message : t("compactFailedDesc"),
				color: "red",
			});
		} finally {
			setRetrying(false);
		}
	};

	return (
		<Modal
			opened={!!activeTarget}
			onClose={handleClose}
			title={
				<Group gap="xs">
					<IconArrowsMinimize size={18} />
					<Text fw={600}>
						{t(isSegment ? "segmentCompactSummaryTitle" : "compactSummaryTitle")}
					</Text>
				</Group>
			}
			size="lg"
			styles={COMPACT_SUMMARY_MODAL_STYLES}
		>
			<Box data-compact-summary-scroll style={COMPACT_SUMMARY_SCROLL_STYLE}>
				{isLoading && (
					<Group justify="center" py="xl">
						<Loader size="sm" />
					</Group>
				)}
				{error && (
					<Text c="red" size="sm">
						{error instanceof Error ? error.message : String(error)}
					</Text>
				)}
				{failed && compactDetail ? (
					<Stack gap="md">
						<Text c="red" size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
							{compactDetail.error || t("compactFailedDesc")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("compactLifecycleMeta", {
								mode: compactDetail.mode ?? "-",
								trigger: compactDetail.trigger ?? "-",
								before: compactDetail.contextPercentBefore ?? "-",
								after: compactDetail.contextPercentAfter ?? "-",
							})}
						</Text>
						{compactDetail.summary && <MarkdownContent text={compactDetail.summary} />}
						<Stack gap="xs">
							<Text fw={600} size="sm">
								{t("compactAttempts")}
							</Text>
							{compactDetail.attempts.slice(-10).map((attempt) => (
								<Paper key={`${attempt.attempt}:${attempt.startedAt}`} p="xs" withBorder>
									<Text size="xs" fw={600}>
										{t("compactAttempt", { attempt: attempt.attempt, model: attempt.model })}
									</Text>
									<Text
										size="xs"
										c={attempt.status === "failed" ? "red" : "dimmed"}
										style={{ whiteSpace: "pre-wrap" }}
									>
										{attempt.error || t(`compactAttemptStatus.${attempt.status}`)}
									</Text>
								</Paper>
							))}
						</Stack>
						{canRetry && (
							<Select
								label={t("compactRetryModel")}
								data={retryModelOptions}
								value={retryModel}
								onChange={setRetryModel}
								searchable
							/>
						)}
					</Stack>
				) : editing ? (
					<Textarea
						value={editText}
						onChange={(e) => setEditText(e.currentTarget.value)}
						autosize
						minRows={8}
						maxRows={20}
					/>
				) : data?.summary || compactDetail?.status === "compacting" ? (
					<Stack gap="md">
						{compactDetail?.status === "compacting" && (
							<Group gap="xs">
								<Loader size="xs" />
								<Text size="sm">{t("compacting")}</Text>
							</Group>
						)}
						{data?.summary && <MarkdownContent text={data.summary} />}
						{compactDetail && compactDetail.status !== "compacting" && (
							<>
								<Text size="xs" c="dimmed">
									{t("compactLifecycleMeta", {
										mode: compactDetail.mode ?? "-",
										trigger: compactDetail.trigger ?? "-",
										before: compactDetail.contextPercentBefore ?? "-",
										after: compactDetail.contextPercentAfter ?? "-",
									})}
								</Text>
								{compactDetail.attempts.length > 0 && (
									<Stack gap="xs">
										<Text fw={600} size="sm">
											{t("compactAttempts")}
										</Text>
										{compactDetail.attempts.slice(-10).map((attempt) => (
											<Paper key={`${attempt.attempt}:${attempt.startedAt}`} p="xs" withBorder>
												<Text size="xs" fw={600}>
													{t("compactAttempt", {
														attempt: attempt.attempt,
														model: attempt.model,
													})}
												</Text>
												<Text
													size="xs"
													c={attempt.status === "failed" ? "red" : "dimmed"}
													style={{ whiteSpace: "pre-wrap" }}
												>
													{attempt.error || t(`compactAttemptStatus.${attempt.status}`)}
												</Text>
											</Paper>
										))}
									</Stack>
								)}
							</>
						)}
					</Stack>
				) : null}
			</Box>
			{activeTarget && (
				<Group data-compact-summary-actions justify="flex-end" style={COMPACT_SUMMARY_FOOTER_STYLE}>
					{editing ? (
						<>
							<Button variant="subtle" size="xs" onClick={() => setEditing(false)}>
								{t("cancelEdit")}
							</Button>
							<Button size="xs" loading={saving} onClick={handleSave}>
								{t("saveEdit")}
							</Button>
						</>
					) : (
						<>
							<Button
								color="red"
								variant="light"
								size="xs"
								loading={deleting}
								onClick={handleDelete}
							>
								{t(failed ? "dismiss" : isSegment ? "deleteSegmentCompact" : "deleteCompact")}
							</Button>
							{canRetry ? (
								<Button size="xs" loading={retrying} disabled={!retryModel} onClick={handleRetry}>
									{t("retryCompact")}
								</Button>
							) : !failed && compactDetail?.status !== "compacting" ? (
								<Button
									variant="light"
									size="xs"
									onClick={() => {
										setEditText(data?.summary ?? "");
										setEditing(true);
									}}
								>
									{t("editCompact")}
								</Button>
							) : null}
						</>
					)}
				</Group>
			)}
		</Modal>
	);
}
