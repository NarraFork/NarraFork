import type { EditorFileClientMessage, EditorFileServerMessage } from "@shared/editor-file-events";
import { resolveLiveSession } from "../lib/auth";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { editorActorForSubject } from "../routes/editor-documents";
import { getEditorDocumentService } from "../services/editor-document-runtime";
import { editorFileSubscriptions } from "../services/editor-file-subscription";

interface Socket {
	data: { userId?: string; sessionId?: string; sessionExp?: number; lastPongAt: number };
	send(frame: string): unknown;
	getBufferedAmount?(): number;
	close?(code?: number, reason?: string): void;
}
interface Subscription {
	controller: AbortController;
	stop?: () => void;
}
const sockets = new Map<Socket, Map<string, Subscription>>();
function cancel(ws: Socket, id: string) {
	const entries = sockets.get(ws),
		entry = entries?.get(id);
	entry?.controller.abort();
	entry?.stop?.();
	entries?.delete(id);
	if (!entries?.size) sockets.delete(ws);
}
export function releaseEditorFileSubscriptions(ws: Socket) {
	for (const id of sockets.get(ws)?.keys() ?? []) cancel(ws, id);
}
function send(ws: Socket, frame: EditorFileServerMessage) {
	if ((ws.getBufferedAmount?.() ?? 0) > 256 * 1024) {
		releaseEditorFileSubscriptions(ws);
		ws.close?.(1013, "Editor backpressure; reconnect");
		return;
	}
	try {
		ws.send(JSON.stringify(frame));
	} catch {
		releaseEditorFileSubscriptions(ws);
	}
}
export async function handleEditorFileMessage(ws: Socket, message: EditorFileClientMessage) {
	cancel(ws, message.subscriptionId);
	if (message.type === "editor_file_unsubscribe") return;
	let entries = sockets.get(ws);
	if (!entries) {
		entries = new Map();
		sockets.set(ws, entries);
	}
	if (!ws.data.userId || entries.size >= 16 || sockets.size > 256) {
		send(ws, {
			type: "editor_file_error",
			subscriptionId: message.subscriptionId,
			code: "unavailable",
		});
		if (!entries.size) sockets.delete(ws);
		return;
	}
	const sub: Subscription = { controller: new AbortController() };
	entries.set(message.subscriptionId, sub);
	const live = () =>
		!sub.controller.signal.aborted &&
		sockets.get(ws)?.get(message.subscriptionId) === sub &&
		Date.now() - ws.data.lastPongAt < 90_000 &&
		(ws.data.sessionExp ?? 0) > Date.now() / 1000;
	const actor = editorActorForSubject(
		{ userId: ws.data.userId, narratorId: message.narratorId },
		sub.controller.signal,
	);
	const authorize = actor.authorize.bind(actor);
	actor.authorize = async (...args) => {
		// The session the socket was opened with must still be live: logout, a token
		// generation bump or expiry all end the subscription.
		const session = ws.data.sessionId ? await resolveLiveSession(ws.data.sessionId) : null;
		if (!live() || !session || session.sub !== actor.userId)
			throw new AppError("Editor authorization expired", 403, "EDITOR_IDENTITY_CHANGED");
		return authorize(...args);
	};
	try {
		const target = await getEditorDocumentService().watchTarget(actor, message.docId);
		if (!live()) {
			cancel(ws, message.subscriptionId);
			return;
		}
		sub.stop = editorFileSubscriptions.subscribe({
			id: message.subscriptionId,
			narratorId: message.narratorId,
			target,
			live,
			send: (frame) => {
				if (!live()) return;
				send(ws, frame);
				if (frame.type === "editor_file_error") {
					cancel(ws, message.subscriptionId);
					void getEditorDocumentService()
						.remove(actor, message.docId)
						.catch(() => {});
				}
			},
		});
	} catch (error) {
		const denied = error instanceof AppError && [401, 403, 404].includes(error.statusCode);
		if (live())
			send(ws, {
				type: "editor_file_error",
				subscriptionId: message.subscriptionId,
				code: denied ? "access_denied" : "unavailable",
			});
		cancel(ws, message.subscriptionId);
	}
}

// These are hints and synchronous epoch fences, never authorization or versions.
// Narrator ACL/context changes also call hint directly at their existing exits.
eventBus.onAny((event) => {
	if (
		event.type.startsWith("device:") ||
		event.type.startsWith("oauth:") ||
		event.type === "auth:changed"
	)
		editorFileSubscriptions.hint();
});
