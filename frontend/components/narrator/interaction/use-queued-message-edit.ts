import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BufferMessageSummary } from "../../../lib/api";
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
			edit.error = `${t("queuedEditProtectionLost")} ${error instanceof Error ? error.message : String(error)}`;
			refresh();
			notifications.show({ color: "red", title: t("editQueuedFailed"), message: edit.error });
		},
		[live, refresh, t],
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
				if (previous.acquiring) return previous.acquiring;
				if (previous.status === "active" && previous.expiresAt > Date.now())
					return Promise.resolve();
			}
			const edit: EditLease =
				previous?.message.id === message.id
					? previous
					: {
							message,
							token: crypto.randomUUID(),
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
					const admission = api.beginBufferedMessageEdit(narratorId, message.id, edit.token);
					edit.admitting = admission;
					const result = await admission;
					if (!live(edit) || edit.retired) return;
					if (result.token !== edit.token || result.expiresAt <= Date.now()) {
						throw new Error(t("queuedEditExpired"));
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
		isQueuedEditLocked: (id?: string) =>
			!!scope.edit && (id === undefined || scope.edit.message.id === id),
		handleStartEditQueued,
		handleCancelEditQueued,
		handleSaveEditQueued,
	};
}
