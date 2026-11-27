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
	Menu,
	Modal,
	Paper,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { type CompactMessageDetail, isCompactRetryableDetail } from "@shared/compact-message";
import { IconArrowsMinimize, IconChevronDown } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../../hooks/useModels";
import { api } from "../../../lib/api";
import type { CompactRetryModel, RetryFailedCompactResponse } from "../../../lib/api/narrators";
import { consumeCompactLiveStream } from "../../../lib/compact-live-stream";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { MarkdownContent } from "../markdown/MarkdownContent";
import { ModelMenuItems } from "../model/ModelMenuItems";
import { MODEL_MENU_POSITIONING } from "../model/model-menu-selection";

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

/**
 * Context occupancy is an estimate that routinely carries a long tail (`0.9545%`), and the
 * lifecycle line is a label, not a measurement: one decimal reads, five do not.
 */
function formatCompactPercent(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value)
		? String(Math.round(value * 10) / 10)
		: "-";
}

function pendingCompactDetail(previous?: CompactMessageDetail): CompactMessageDetail {
	return {
		...previous,
		status: "compacting",
		summary: "",
		error: undefined,
		attempt: undefined,
		finishedAt: undefined,
		output: undefined,
		thinking: undefined,
		outputChars: 0,
		thinkingChars: 0,
		streamVersion: undefined,
		pendingModel: undefined,
		attempts: previous?.attempts ?? [],
		canRetry: false,
		canChangeModel: false,
	};
}

export type CompactSummaryKind = "context" | "segment";

export interface CompactSummaryModalTarget {
	kind: CompactSummaryKind;
	narratorId: string;
	messageId: string;
	onDelete?: () => void;
	/** Open directly in edit mode (e.g. for the manual summarize flow). */
	autoEdit?: boolean;
}

export function compactSummaryQueryKey(
	narratorId: string,
	messageId: string,
	kind: CompactSummaryKind = "context",
) {
	return [
		kind === "segment" ? "segment-compact-summary" : "compact-summary",
		narratorId,
		messageId,
	] as const;
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
	const { visibleModels, summaryModelValue, providerLabels } = useAllModels(target != null);
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const retryRequestId = useRef(0);
	const compactModelRevision = useRef(0);
	const [now, setNow] = useState(() => Date.now());
	const [retryModelMenuOpened, setRetryModelMenuOpened] = useState(false);
	const sourceTargetKey = target ? `${target.kind}:${target.narratorId}:${target.messageId}` : null;
	const [retryTargetOverride, setRetryTargetOverride] = useState<{
		sourceTargetKey: string;
		messageId: string;
	} | null>(null);
	const pendingRetryMigrationRef = useRef<{
		narratorId: string;
		kind: CompactSummaryKind;
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
		? compactSummaryQueryKey(activeTarget.narratorId, activeTarget.messageId, activeTarget.kind)
		: (["compact-summary", "closed"] as const);
	const targetKey = activeTarget
		? `${activeTarget.kind}:${activeTarget.narratorId}:${activeTarget.messageId}`
		: null;
	const previousTargetKeyRef = useRef(targetKey);
	const activeTargetRef = useRef<CompactSummaryModalTarget | null>(activeTarget);
	activeTargetRef.current = activeTarget;
	const sourceTargetKeyRef = useRef(sourceTargetKey);
	sourceTargetKeyRef.current = sourceTargetKey;

	const applyCompactReplacement = useCallback(
		(event: Record<string, unknown>) => {
			const currentTarget = activeTargetRef.current;
			if (!currentTarget) return;
			const migration = resolveCompactReplacementEvent(currentTarget.messageId, event);
			if (!migration) return;
			const currentQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				currentTarget.messageId,
				currentTarget.kind,
			);
			const currentDetail = queryClient.getQueryData<CompactMessageDetail>(currentQueryKey);
			const retiredMessageIds = new Set(migration.retiredMessageIds);
			if (migration.changed) retiredMessageIds.add(currentTarget.messageId);
			for (const retiredMessageId of retiredMessageIds) {
				const retiredKey = compactSummaryQueryKey(
					currentTarget.narratorId,
					retiredMessageId,
					currentTarget.kind,
				);
				void queryClient.cancelQueries({
					queryKey: retiredKey,
					exact: true,
				});
				queryClient.removeQueries({
					queryKey: retiredKey,
					exact: true,
				});
			}

			const nextQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				migration.nextMessageId,
				currentTarget.kind,
			);
			const existingNextDetail = queryClient.getQueryData<CompactMessageDetail>(nextQueryKey);
			if (!existingNextDetail) {
				queryClient.setQueryData(nextQueryKey, pendingCompactDetail(currentDetail));
			}

			if (!migration.changed) {
				// A duplicate frame after the HTTP response has already migrated the
				// modal must still clean stale aliases. Do not regress a completed
				// detail back to `compacting` or issue a second fetch.
				if (!existingNextDetail || existingNextDetail.status === "compacting") {
					void queryClient.invalidateQueries(
						{ queryKey: nextQueryKey, exact: true },
						{ cancelRefetch: false },
					);
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
					kind: currentTarget.kind,
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
					"compact_progress",
					"compact_done",
					"compact_failed",
				],
			},
			(event) => {
				const current = activeTargetRef.current;
				if (event.type === "compact_progress") {
					if (current && event.messageId === current.messageId) {
						queryClient.setQueryData<CompactMessageDetail>(
							compactSummaryQueryKey(current.narratorId, current.messageId, current.kind),
							(previous) => {
								const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
								const previousAttempt =
									previous?.attempt ?? previous?.attempts.at(-1)?.attempt ?? 0;
								if (
									previous &&
									((attempt !== undefined && attempt < previousAttempt) ||
										(previous.status !== "compacting" && (attempt ?? 0) <= previousAttempt))
								) {
									return previous;
								}
								if (
									(attempt !== undefined && attempt !== previousAttempt) ||
									(typeof event.model === "string" && event.model !== previous?.model) ||
									((event.pendingModel === null || typeof event.pendingModel === "string") &&
										(event.pendingModel ?? null) !== (previous?.pendingModel ?? null))
								) {
									compactModelRevision.current += 1;
								}
								return {
									...(previous?.status === "compacting"
										? previous
										: pendingCompactDetail(previous)),
									...(typeof event.model === "string" ? { model: event.model } : {}),
									...(attempt === undefined ? {} : { attempt }),
									...(typeof event.canChangeModel === "boolean"
										? { canChangeModel: event.canChangeModel }
										: {}),
									...(event.pendingModel === null || typeof event.pendingModel === "string"
										? { pendingModel: event.pendingModel }
										: {}),
									...(typeof event.reasoningEffort === "string"
										? { reasoningEffort: event.reasoningEffort }
										: {}),
									...(typeof event.startedAt === "string" ? { startedAt: event.startedAt } : {}),
									outputChars: typeof event.outputChars === "number" ? event.outputChars : 0,
									thinkingChars: typeof event.thinkingChars === "number" ? event.thinkingChars : 0,
								};
							},
						);
					}
					return;
				}
				if (
					(event.type === "compact_done" || event.type === "compact_failed") &&
					current &&
					event.messageId === current.messageId
				) {
					void queryClient.invalidateQueries(
						{
							queryKey: compactSummaryQueryKey(current.narratorId, current.messageId, current.kind),
							exact: true,
						},
						{ cancelRefetch: false },
					);
				}
				applyCompactReplacement(event);
			},
		);
		return () => narratorWSManager.removeListener(listener);
	}, [applyCompactReplacement, queryClient, target?.narratorId]);

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
		refetchOnWindowFocus: false,
	});
	const compactDetail = data && "status" in data ? data : undefined;
	const isCompacting = compactDetail?.status === "compacting";

	useEffect(() => {
		if (!isCompacting || !activeTargetNarratorId || !activeTargetMessageId) return;
		const controller = new AbortController();
		const queryKeyForStream = compactSummaryQueryKey(
			activeTargetNarratorId,
			activeTargetMessageId,
			activeTargetKind,
		);
		let reconnectTimer: number | undefined;
		let reconnectDelayMs = 500;
		const connect = async () => {
			const current = queryClient.getQueryData<CompactMessageDetail>(queryKeyForStream);
			if (controller.signal.aborted || current?.status !== "compacting") return;
			let output = current.output;
			let thinking = current.thinking;
			let streamVersion = current.streamVersion;
			let canReconnect = true;
			try {
				const response = await api.streamCompactSummary(
					activeTargetNarratorId,
					activeTargetMessageId,
					{
						output: output?.length ?? 0,
						thinking: thinking?.length ?? 0,
						...(streamVersion === undefined ? {} : { streamVersion }),
					},
					controller.signal,
				);
				canReconnect = ![401, 403, 404].includes(response.status);
				if (response.ok && !controller.signal.aborted) {
					await consumeCompactLiveStream(
						response,
						(event) => {
							if (controller.signal.aborted || event.kind === "finished") return;
							reconnectDelayMs = 500;
							if (event.kind === "delta") {
								if (event.channel === "output") output = `${output ?? ""}${event.delta}`;
								else thinking = `${thinking ?? ""}${event.delta}`;
							} else if (event.kind === "reset") {
								output = output?.slice(0, event.outputLength);
								thinking = thinking?.slice(0, event.thinkingLength);
								streamVersion = event.streamVersion;
							}
							queryClient.setQueryData<CompactMessageDetail>(queryKeyForStream, (previous) =>
								previous?.status === "compacting"
									? {
											...previous,
											output,
											thinking,
											streamVersion,
											outputChars: event.outputChars,
											thinkingChars: event.thinkingChars,
										}
									: previous,
							);
						},
						controller.signal,
					);
				}
			} catch {
				// Refresh the status and resume from the buffered text on transient failures.
			}
			if (
				controller.signal.aborted ||
				queryClient.getQueryData<CompactMessageDetail>(queryKeyForStream)?.status !== "compacting"
			) {
				return;
			}
			await queryClient.invalidateQueries(
				{ queryKey: queryKeyForStream, exact: true },
				{ cancelRefetch: false },
			);
			if (canReconnect && !controller.signal.aborted) {
				reconnectTimer = window.setTimeout(() => void connect(), reconnectDelayMs);
				reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
			}
		};
		void connect();
		return () => {
			controller.abort();
			window.clearTimeout(reconnectTimer);
		};
	}, [activeTargetKind, activeTargetMessageId, activeTargetNarratorId, isCompacting, queryClient]);

	const failed = compactDetail?.status === "failed";
	const canRetry = compactDetail ? isCompactRetryableDetail(compactDetail) : false;
	const canQueueModel = isCompacting && compactDetail.canChangeModel === true;
	const waitingForStream =
		isCompacting &&
		(canQueueModel ||
			(!(compactDetail.outputChars || compactDetail.output) &&
				!(compactDetail.thinkingChars || compactDetail.thinking)));
	const retryModel =
		compactDetail?.model ?? compactDetail?.attempts.at(-1)?.model ?? summaryModelValue;
	const selectedModelValue = compactDetail?.pendingModel ?? retryModel;
	const selectedRetryModel = visibleModels.find((model) => model.value === selectedModelValue);
	const retryModelLabel = selectedRetryModel
		? selectedRetryModel.provider
			? `${providerLabels?.[selectedRetryModel.provider] ?? selectedRetryModel.provider} · ${selectedRetryModel.label}`
			: selectedRetryModel.label
		: (selectedModelValue ?? t("compactRetryModel"));
	const previousSourceTargetKeyRef = useRef(sourceTargetKey);

	useEffect(() => {
		if (compactDetail?.status !== "compacting") return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [compactDetail?.status]);

	useEffect(() => {
		if (previousSourceTargetKeyRef.current === sourceTargetKey) return;
		previousSourceTargetKeyRef.current = sourceTargetKey;
		setRetryTargetOverride(null);
	}, [sourceTargetKey]);

	useEffect(() => {
		const pending = pendingRetryMigrationRef.current;
		if (
			!pending ||
			activeTargetKind !== pending.kind ||
			activeTargetNarratorId !== pending.narratorId ||
			activeTargetMessageId !== pending.nextMessageId
		) {
			return;
		}
		pendingRetryMigrationRef.current = null;
		for (const retiredMessageId of pending.retiredMessageIds) {
			queryClient.removeQueries({
				queryKey: compactSummaryQueryKey(pending.narratorId, retiredMessageId, pending.kind),
				exact: true,
			});
		}
		pending.onDelete?.();
		void queryClient.invalidateQueries(
			{
				queryKey: compactSummaryQueryKey(pending.narratorId, pending.nextMessageId, pending.kind),
				exact: true,
			},
			{ cancelRefetch: false },
		);
	}, [activeTargetKind, activeTargetNarratorId, activeTargetMessageId, queryClient]);

	useEffect(() => {
		if (previousTargetKeyRef.current === targetKey) return;
		previousTargetKeyRef.current = targetKey;
		setRetryModelMenuOpened(false);
		setEditing(false);
		setEditText("");
		setDeleting(false);
		setSaving(false);
		setRetrying(false);
	}, [targetKey]);

	useEffect(() => {
		if (!activeTarget?.autoEdit || isLoading) return;
		setEditText(data?.summary ?? "");
		setEditing(true);
	}, [activeTarget?.autoEdit, isLoading, data?.summary]);

	const startedAtMs = compactDetail?.startedAt ? Date.parse(compactDetail.startedAt) : NaN;
	const finishedAtMs = compactDetail?.finishedAt ? Date.parse(compactDetail.finishedAt) : NaN;
	const elapsedMs = Number.isFinite(startedAtMs)
		? Math.max(0, (Number.isFinite(finishedAtMs) ? finishedAtMs : now) - startedAtMs)
		: 0;
	const elapsedLabel = `${Math.floor(elapsedMs / 60_000)}:${String(Math.floor((elapsedMs % 60_000) / 1000)).padStart(2, "0")}`;

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

	const handleRetry = async (selection?: CompactRetryModel) => {
		if (!activeTarget || retrying) return;
		if (!canRetry && !(canQueueModel && selection)) return;
		const currentTarget = activeTarget;
		const originalAttempt = compactDetail?.attempt ?? compactDetail?.attempts.at(-1)?.attempt;
		const expectedAttempt = canQueueModel ? originalAttempt : undefined;
		const requestId = ++retryRequestId.current;
		const modelRevisionAtRequest = compactModelRevision.current;
		setRetryModelMenuOpened(false);
		setRetrying(true);
		try {
			const response = await api.retryFailedCompact(
				currentTarget.narratorId,
				currentTarget.messageId,
				selection &&
					(expectedAttempt === undefined ? selection : { ...selection, expectedAttempt }),
			);
			if (response.queued) {
				if (
					retryRequestId.current !== requestId ||
					sourceTargetKeyRef.current !== sourceTargetKey ||
					compactModelRevision.current !== modelRevisionAtRequest
				) {
					return;
				}
				queryClient.setQueryData<CompactMessageDetail>(
					compactSummaryQueryKey(
						currentTarget.narratorId,
						currentTarget.messageId,
						currentTarget.kind,
					),
					(previous) => {
						if (
							previous?.status !== "compacting" ||
							(expectedAttempt !== undefined &&
								expectedAttempt !== (previous.attempt ?? previous.attempts.at(-1)?.attempt)) ||
							previous.model !== compactDetail?.model ||
							response.pendingModel === previous.model
						) {
							return previous;
						}
						return { ...previous, pendingModel: response.pendingModel ?? undefined };
					},
				);
				return;
			}
			if (sourceTargetKeyRef.current !== sourceTargetKey) return;
			const migration = resolveCompactRetryTargetMigration(currentTarget.messageId, response);
			await Promise.all(
				migration.retiredMessageIds.map((retiredMessageId) =>
					queryClient.cancelQueries({
						queryKey: compactSummaryQueryKey(
							currentTarget.narratorId,
							retiredMessageId,
							currentTarget.kind,
						),
						exact: true,
					}),
				),
			);
			if (
				sourceTargetKeyRef.current !== sourceTargetKey ||
				activeTargetRef.current?.messageId !== currentTarget.messageId ||
				(migration.changed &&
					pendingRetryMigrationRef.current?.nextMessageId === migration.nextMessageId)
			) {
				return;
			}
			const nextQueryKey = compactSummaryQueryKey(
				currentTarget.narratorId,
				migration.nextMessageId,
				currentTarget.kind,
			);
			queryClient.setQueryData<CompactMessageDetail>(nextQueryKey, (previous) => {
				if (previous?.status === "compacting" || previous?.status === "compacted") return previous;
				const currentAttempt = previous?.attempt ?? previous?.attempts.at(-1)?.attempt;
				if (currentAttempt !== undefined && currentAttempt > (originalAttempt ?? 0))
					return previous;
				return pendingCompactDetail(compactDetail);
			});
			if (migration.changed) {
				const retrySourceTargetKey =
					sourceTargetKey ??
					`${currentTarget.kind}:${currentTarget.narratorId}:${currentTarget.messageId}`;
				pendingRetryMigrationRef.current = {
					narratorId: currentTarget.narratorId,
					kind: currentTarget.kind,
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
						queryKey: compactSummaryQueryKey(
							currentTarget.narratorId,
							retiredMessageId,
							currentTarget.kind,
						),
						exact: true,
					});
				}
				await queryClient.invalidateQueries(
					{ queryKey: nextQueryKey, exact: true },
					{ cancelRefetch: false },
				);
			}
		} catch (err) {
			notifications.show({
				title: t(canQueueModel ? "compactQueueModelFailed" : "retryCompactFailed"),
				message: err instanceof Error ? err.message : t("compactFailedDesc"),
				color: "red",
			});
		} finally {
			if (retryRequestId.current === requestId) setRetrying(false);
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
				{editing ? (
					<Textarea
						value={editText}
						onChange={(e) => setEditText(e.currentTarget.value)}
						autosize
						minRows={8}
						maxRows={20}
					/>
				) : (
					<Stack gap="md">
						{compactDetail && (
							<Stack gap="xs">
								{isCompacting && (
									<Group gap="xs" role="status">
										<Loader size="xs" />
										<Text size="sm">
											{t(waitingForStream ? "compactWaitingForOutput" : "compacting")}
										</Text>
									</Group>
								)}
								{failed && (
									<Text
										c="red"
										size="sm"
										style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
									>
										{compactDetail.error || t("compactFailedDesc")}
									</Text>
								)}
								{(isCompacting || failed) && (
									<Text size="xs" c="dimmed">
										{t("compactModelMeta", {
											model: compactDetail.model ?? compactDetail.attempts.at(-1)?.model ?? "-",
											effort: compactDetail.reasoningEffort ?? "-",
										})}
										{" · "}
										{t("compactElapsed", { elapsed: elapsedLabel })}
									</Text>
								)}
								<Text size="xs" c="dimmed">
									{t("compactLifecycleMeta", {
										mode: compactDetail.mode ?? "-",
										trigger: compactDetail.trigger ?? "-",
										before: formatCompactPercent(compactDetail.contextPercentBefore),
										after: formatCompactPercent(compactDetail.contextPercentAfter),
									})}
								</Text>
								{compactDetail.pendingModel && isCompacting && (
									<Text size="xs" role="status">
										{t("compactQueuedModel", { model: retryModelLabel })}
									</Text>
								)}
								{(isCompacting || failed) && compactDetail.thinking && (
									<Paper p="xs" withBorder>
										<Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
											{compactDetail.thinking}
										</Text>
									</Paper>
								)}
								{(isCompacting || failed) && compactDetail.output && (
									<MarkdownContent text={compactDetail.output} />
								)}
							</Stack>
						)}
						{data?.summary && <MarkdownContent text={data.summary} />}
						{compactDetail && compactDetail.attempts.length > 0 && (
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
											style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
										>
											{attempt.error || t(`compactAttemptStatus.${attempt.status}`)}
										</Text>
									</Paper>
								))}
							</Stack>
						)}
					</Stack>
				)}
			</Box>
			{data && (!isCompacting || canQueueModel) && (
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
							{!isCompacting && (
								<Button
									color="red"
									variant="light"
									size="xs"
									loading={deleting}
									onClick={handleDelete}
								>
									{t(failed ? "dismiss" : isSegment ? "deleteSegmentCompact" : "deleteCompact")}
								</Button>
							)}
							{(canQueueModel || canRetry) && (
								<Menu
									opened={retryModelMenuOpened}
									onChange={setRetryModelMenuOpened}
									position="bottom-start"
									width={280}
									withinPortal
									{...MODEL_MENU_POSITIONING}
									zIndex={1100}
								>
									<Menu.Target>
										<Button
											variant="default"
											size="xs"
											fw={400}
											aria-label={t("compactRetryModel")}
											loading={retrying}
											rightSection={<IconChevronDown size={14} />}
										>
											{t("compactRetryModel")}
										</Button>
									</Menu.Target>
									<Menu.Dropdown
										data-model-menu-scroll
										style={{ maxHeight: "60vh", overflowY: "auto" }}
									>
										<Menu.Label>
											{t(canQueueModel ? "compactQueueModelHint" : "compactRetryModelHint")}
										</Menu.Label>
										<Menu.Item onClick={() => void handleRetry({ useSessionModel: true })}>
											{t("compactUseSessionModel")}
										</Menu.Item>
										<ModelMenuItems
											opened={retryModelMenuOpened}
											allModels={visibleModels}
											currentModel={selectedModelValue}
											totalCostUsd={null}
											providerLabels={providerLabels}
											onSelect={(model) => void handleRetry({ model })}
										/>
									</Menu.Dropdown>
								</Menu>
							)}
							{canRetry ? (
								<Button
									size="xs"
									loading={retrying}
									onClick={() =>
										void handleRetry(selectedRetryModel && { model: selectedRetryModel.value })
									}
								>
									{t("retryCompact")}
								</Button>
							) : !failed && !isCompacting ? (
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
