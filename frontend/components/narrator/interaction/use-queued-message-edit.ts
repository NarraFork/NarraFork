import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BufferMessageSummary } from "../../../lib/api";
import { ApiError } from "../../../lib/api/client";
import type {
	QueuedEditPayload,
	UseQueuedMessageActionsOptions,
} from "./use-queued-message-actions";

interface EditLease {
	message: BufferMessageSummary;
	token: string;
	narratorId: string;
	status: "acquiring" | "active" | "lost";
	opened: boolean;
	expiresAt: number;
	contentRevision?: number;
	stale?: boolean;
	error?: string;
	attempted?: boolean;
	retired?: boolean;
	released?: boolean;
	previous?: EditLease;
	acquiring?: Promise<void>;
	admitting?: Promise<unknown>;
	detailController?: AbortController;
	renewing?: Promise<void>;
	saving?: Promise<boolean>;
	releasing?: Promise<boolean>;
	interval?: ReturnType<typeof setInterval>;
	expiryTimer?: ReturnType<typeof setTimeout>;
}
interface EditScope {
	narratorId: string;
	disposed: boolean;
	edit: EditLease | null;
	releasingEdit?: EditLease;
}

/** Secure UUID v4, including non-secure LAN HTTP origins without randomUUID. */
function editToken() {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stopTimers(edit: EditLease) {
	clearInterval(edit.interval);
	clearTimeout(edit.expiryTimer);
}

/** Wait for in-flight admission/renewal/save before releasing the original token. */
function releaseLease(edit: EditLease): Promise<boolean> {
	if (edit.released) return Promise.resolve(true);
	if (edit.releasing) return edit.releasing;
	edit.retired = true;
	stopTimers(edit);
	edit.detailController?.abort();
	const releasing = (async () => {
		await Promise.allSettled([edit.admitting, edit.renewing, edit.saving]);
		if (edit.previous && !(await releaseLease(edit.previous))) return false;
		if (edit.attempted) {
			try {
				await api.releaseBufferedMessageEdit(edit.narratorId, edit.message.id, edit.token);
			} catch {
				return false;
			}
		}
		edit.released = true;
		return true;
	})();
	edit.releasing = releasing;
	void releasing.finally(() => {
		edit.releasing = undefined;
	});
	return releasing;
}

/** The ref is authoritative: React batching must not admit two edits or cancel a pending save. */
export function useQueuedMessageEdit(options: UseQueuedMessageActionsOptions) {
	const { narratorId, setQueuedMessages, reconcileBufferedMessages, t } = options;
	const scopeRef = useRef<EditScope>({ narratorId, disposed: false, edit: null });
	if (scopeRef.current.narratorId !== narratorId) {
		scopeRef.current = { narratorId, disposed: false, edit: null };
	}
	const scope = scopeRef.current;
	const [, render] = useState(0);
	const live = useCallback(
		(edit: EditLease) => !scope.disposed && scopeRef.current === scope && scope.edit === edit,
		[scope],
	);
	const refresh = useCallback(() => {
		if (!scope.disposed && scopeRef.current === scope) render((n) => n + 1);
	}, [scope]);
	useEffect(() => {
		scope.disposed = false;
		return () => {
			scope.disposed = true;
			if (scope.edit) void releaseLease(scope.edit);
			if (scope.releasingEdit) void releaseLease(scope.releasingEdit);
			scope.edit = null;
		};
	}, [scope]);

	const loseProtection = useCallback(
		(edit: EditLease, error: unknown) => {
			if (!live(edit) || edit.retired) return;
			stopTimers(edit);
			edit.status = "lost";
			edit.stale =
				error instanceof ApiError &&
				error.status === 409 &&
				error.data?.code === "BUFFER_EDIT_STALE";
			edit.error = edit.stale
				? t("queuedEditStale")
				: `${t("queuedEditProtectionLost")} ${error instanceof Error ? error.message : String(error)}`;
			refresh();
			notifications.show({ color: "red", title: t("editQueuedFailed"), message: edit.error });
			if (edit.stale) {
				reconcileBufferedMessages();
				void releaseLease(edit);
			}
		},
		[live, refresh, reconcileBufferedMessages, t],
	);
	const startTimers = useCallback(
		(edit: EditLease) => {
			const armExpiry = () => {
				clearTimeout(edit.expiryTimer);
				edit.expiryTimer = setTimeout(
					() => loseProtection(edit, t("queuedEditExpired")),
					Math.max(0, edit.expiresAt - Date.now()),
				);
			};
			stopTimers(edit);
			armExpiry();
			edit.interval = setInterval(() => {
				if (!live(edit) || edit.retired || edit.status !== "active" || edit.renewing) return;
				if (edit.expiresAt <= Date.now()) {
					loseProtection(edit, t("queuedEditExpired"));
					return;
				}
				edit.renewing = Promise.resolve().then(async () => {
					try {
						if (!live(edit) || edit.retired || edit.status !== "active") return;
						const result = await api.renewBufferedMessageEdit(
							narratorId,
							edit.message.id,
							edit.token,
						);
						if (!live(edit) || edit.retired || edit.status !== "active") return;
						if (result.token !== edit.token || result.expiresAt <= Date.now()) {
							throw new Error(t("queuedEditExpired"));
						}
						if (result.contentRevision !== edit.contentRevision) {
							throw new ApiError(t("queuedEditStale"), 409, { code: "BUFFER_EDIT_STALE" });
						}
						edit.expiresAt = result.expiresAt;
						armExpiry();
					} catch (error) {
						loseProtection(edit, error);
					} finally {
						edit.renewing = undefined;
					}
				});
			}, 20_000);
		},
		[live, loseProtection, narratorId, t],
	);

	const handleStartEditQueued = useCallback(
		(message: BufferMessageSummary): Promise<void> => {
			if (scope.disposed || scopeRef.current !== scope) return Promise.resolve();
			const previous = scope.edit;
			if (previous?.saving) return Promise.resolve();
			if (previous?.message.id === message.id) {
				if (previous.stale) return Promise.resolve();
				if (previous.acquiring) return previous.acquiring;
				if (previous.status === "active" && previous.expiresAt > Date.now())
					return Promise.resolve();
			}
			const edit: EditLease =
				previous?.message.id === message.id
					? previous
					: {
							message,
							token: editToken(),
							narratorId,
							status: "acquiring",
							opened: false,
							expiresAt: 0,
							previous: previous ?? scope.releasingEdit,
						};
			scope.edit = edit;
			edit.status = "acquiring";
			edit.error = undefined;
			refresh();
			edit.acquiring = Promise.resolve().then(async () => {
				try {
					if (edit.previous && !(await releaseLease(edit.previous))) {
						throw new Error(t("queuedEditReleaseFailed"));
					}
					edit.previous = undefined;
					if (!live(edit) || edit.retired) return;
					// Retry an uncertain POST with the same token; never create a second lease.
					if (edit.renewing) await edit.renewing;
					if (!live(edit) || edit.retired) return;
					edit.attempted = true;
					const admission = api.beginBufferedMessageEdit(
						narratorId,
						message.id,
						edit.token,
						edit.opened ? edit.contentRevision : undefined,
					);
					edit.admitting = admission;
					const result = await admission;
					if (!live(edit) || edit.retired) return;
					if (result.token !== edit.token || result.expiresAt <= Date.now()) {
						throw new Error(t("queuedEditExpired"));
					}
					if (!Number.isSafeInteger(result.contentRevision) || result.contentRevision < 0) {
						throw new Error(t("queuedEditExpired"));
					}
					if (edit.opened && result.contentRevision !== edit.contentRevision) {
						throw new ApiError(t("queuedEditStale"), 409, { code: "BUFFER_EDIT_STALE" });
					}
					edit.expiresAt = result.expiresAt;
					// On first open, do not seed the draft from a potentially stale WS snapshot.
					if (!edit.opened) {
						edit.detailController = new AbortController();
						const messages = await api.getBufferedMessages(
							narratorId,
							edit.detailController.signal,
						);
						if (!live(edit) || edit.retired) return;
						const latest = messages.find((row) => row.id === message.id);
						if (!latest || edit.expiresAt <= Date.now()) throw new Error(t("queuedEditExpired"));
						if (
							latest.contentRevision !== undefined &&
							latest.contentRevision !== result.contentRevision
						) {
							throw new ApiError(t("queuedEditStale"), 409, { code: "BUFFER_EDIT_STALE" });
						}
						edit.contentRevision = result.contentRevision;
						edit.message = latest;
						setQueuedMessages((rows) => rows.map((row) => (row.id === message.id ? latest : row)));
					}
					edit.status = "active";
					edit.opened = true;
					startTimers(edit);
					refresh();
				} catch (error) {
					loseProtection(edit, error);
				} finally {
					edit.acquiring = undefined;
					edit.admitting = undefined;
					edit.detailController = undefined;
				}
			});
			return edit.acquiring;
		},
		[scope, narratorId, live, refresh, loseProtection, setQueuedMessages, startTimers, t],
	);

	const edit = scope.edit;
	const handleCancelEditQueued = useCallback(() => {
		// Capture an open editor's lease so a row's late post-save cancel cannot
		// close a newer editor; still allow cancellation of a same-tick admission.
		const target = edit ?? (scope.edit?.opened ? null : scope.edit);
		if (!target || !live(target) || target.saving) return;
		scope.edit = null;
		scope.releasingEdit = target;
		refresh();
		void releaseLease(target).then((ok) => {
			if (ok && scope.releasingEdit === target) scope.releasingEdit = undefined;
			refresh();
			if (!ok && !scope.disposed && scopeRef.current === scope) {
				notifications.show({ color: "red", message: t("queuedEditReleaseFailed") });
			}
		});
	}, [edit, scope, live, refresh, t]);

	const handleSaveEditQueued = useCallback(
		(message: BufferMessageSummary, text: string, payload: QueuedEditPayload): Promise<boolean> => {
			const edit = scope.edit;
			if (!edit || !live(edit) || edit.message.id !== message.id || edit.saving) {
				return Promise.resolve(false);
			}
			if (edit.status !== "active" || edit.expiresAt <= Date.now()) {
				loseProtection(edit, t("queuedEditExpired"));
				return Promise.resolve(false);
			}
			edit.saving = Promise.resolve().then(async () => {
				try {
					if (!live(edit) || edit.retired) return false;
					if (edit.status !== "active" || edit.expiresAt <= Date.now()) {
						loseProtection(edit, t("queuedEditExpired"));
						return false;
					}
					const result = await api.updateBufferedMessage(
						narratorId,
						message.id,
						text,
						payload,
						edit.token,
					);
					if (!live(edit)) return false;
					reconcileBufferedMessages();
					if (result.ok !== true) return false;
					scope.edit = null;
					refresh();
					// A successful save already releases server-side. DELETE is idempotent.
					void releaseLease(edit);
					return true;
				} catch (error) {
					if (!live(edit)) return false;
					if (
						error instanceof ApiError &&
						error.status === 409 &&
						error.data?.code === "BUFFER_EDIT_STALE"
					) {
						loseProtection(edit, error);
						return false;
					}
					reconcileBufferedMessages();
					notifications.show({
						color: "red",
						title: t("editQueuedFailed"),
						message: error instanceof Error ? error.message : String(error),
					});
					return false;
				} finally {
					edit.saving = undefined;
				}
			});
			return edit.saving;
		},
		[scope, live, narratorId, reconcileBufferedMessages, refresh, loseProtection, t],
	);
	return {
		editingQueuedId: edit?.opened ? edit.message.id : null,
		editingQueuedMessage: edit?.message ?? null,
		startingQueuedId: edit?.status === "acquiring" ? edit.message.id : null,
		queuedEditLockedId: edit?.message.id,
		queuedEditProtected: edit?.status === "active" && edit.expiresAt > Date.now(),
		queuedEditError: edit?.error,
		queuedEditStale: edit?.stale === true,
		queueMutationsDisabled: !!scope.edit || !!scope.releasingEdit?.releasing,
		isQueuedEditLocked: () =>
			scope.disposed ||
			scopeRef.current !== scope ||
			!!scope.edit ||
			!!scope.releasingEdit?.releasing,
		handleStartEditQueued,
		handleCancelEditQueued,
		handleSaveEditQueued,
	};
}
