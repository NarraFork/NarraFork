import type {
	PublicDiscussionMessage,
	PublicDiscussionPage,
	PublicLiveBlock,
	PublicSharedMessagePage,
	PublicSharedSession,
	PublicSharedToolDetail,
	PublicShareEvent,
} from "@shared/public-narrator-share";
import {
	linkPublicShareSignals,
	type PublicShareClient,
	PublicShareError,
} from "./public-share-api";

export const PUBLIC_SHARE_MAX_ROWS = 500;
const MAX_LIVE_CHARS = 256 * 1024;
const RETRY_MAX_MS = 30_000;
export type PublicSharePhase =
	| "loading"
	| "connecting"
	| "live"
	| "reconnecting"
	| "limited"
	| "unavailable"
	| "error";
export interface PublicShareViewState {
	session: PublicSharedSession | null;
	phase: PublicSharePhase;
	messages: PublicSharedMessagePage | null;
	discussion: PublicDiscussionPage | null;
	live: PublicLiveBlock[];
	liveTruncated: boolean;
	loadingMessages: boolean;
	loadingDiscussion: boolean;
	sending: boolean;
	sendError: boolean;
	historyRevision: number;
}

function emptyState(): PublicShareViewState {
	return {
		session: null,
		phase: "loading",
		messages: null,
		discussion: null,
		live: [],
		liveTruncated: false,
		loadingMessages: false,
		loadingDiscussion: false,
		sending: false,
		sendError: false,
		historyRevision: 0,
	};
}

export function mergePublicRows<T extends { id: string; seq: number }>(old: T[], next: T[]): T[] {
	return [...new Map([...old, ...next].map((row) => [row.id, row])).values()].sort(
		(a, b) => a.seq - b.seq,
	);
}

/** Offset is a JS string offset. Duplicate/overlapping retransmits are harmless; gaps must resync. */
export function applyPublicDelta(
	blocks: PublicLiveBlock[],
	event: Extract<PublicShareEvent, { type: "delta" }>,
): PublicLiveBlock[] | null {
	const index = blocks.findIndex((block) => block.id === event.blockId);
	const current = index === -1 ? "" : blocks[index].text;
	if (event.offset > current.length || (index !== -1 && blocks[index].kind !== event.kind))
		return null;
	const overlap = Math.min(current.length - event.offset, event.text.length);
	if (current.slice(event.offset, event.offset + overlap) !== event.text.slice(0, overlap))
		return null;
	const suffix = event.text.slice(overlap);
	if (!suffix && index !== -1) return blocks;
	const block = { id: event.blockId, kind: event.kind, text: current + suffix };
	const next = [...blocks];
	if (index === -1) next.push(block);
	else next[index] = block;
	if (next.length > 256 || next.reduce((sum, item) => sum + item.text.length, 0) > MAX_LIVE_CHARS)
		return null;
	return next;
}

/**
 * One controller per link AND credential, owned by one mounted public page. No global query
 * cache, persistence or auth client. Epochs fence late requests, including pagination racing
 * an edit/delete, and the SSE snapshot is installed BEFORE the first tail page is requested.
 */
export class PublicShareSession {
	private state = emptyState();
	private listeners = new Set<() => void>();
	private abort = new AbortController();
	private generation = 0;
	private messagesEpoch = 0;
	private discussionEpoch = 0;
	private retryAttempt = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private messageTimer: ReturnType<typeof setTimeout> | undefined;
	private discussionTimer: ReturnType<typeof setTimeout> | undefined;
	private active = false;
	constructor(private readonly client: PublicShareClient) {}

	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private update(patch: Partial<PublicShareViewState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	private current(generation: number) {
		return this.active && generation === this.generation && !this.abort.signal.aborted;
	}
	private clearTimers() {
		clearTimeout(this.timer);
		clearTimeout(this.messageTimer);
		clearTimeout(this.discussionTimer);
		this.timer = this.messageTimer = this.discussionTimer = undefined;
	}
	start = () => {
		this.active = true;
		void this.connect();
	};
	stop = () => {
		this.active = false;
		this.generation++;
		this.abort.abort();
		this.clearTimers();
		this.state = emptyState();
	};
	reconnect = () => {
		if (this.active && this.state.phase !== "unavailable") void this.connect();
	};
	private unavailable() {
		this.abort.abort();
		this.generation++;
		this.clearTimers();
		this.update({ ...emptyState(), phase: "unavailable" });
	}
	private fail(error: unknown, generation: number) {
		if (!this.current(generation)) return;
		if (error instanceof PublicShareError && error.unavailable) {
			this.unavailable();
			return;
		}
		this.abort.abort();
		this.clearTimers();
		const limited = error instanceof PublicShareError && error.status === 429;
		this.update({
			phase: limited ? "limited" : this.state.session ? "reconnecting" : "error",
			live: [],
			loadingMessages: false,
			loadingDiscussion: false,
			sending: false,
		});
		const delay = limited
			? RETRY_MAX_MS
			: Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(this.retryAttempt++, 5));
		this.timer = setTimeout(() => {
			if (this.active) void this.connect();
		}, delay);
	}
	private async connect() {
		this.abort.abort();
		this.clearTimers();
		this.abort = new AbortController();
		const generation = ++this.generation;
		this.messagesEpoch++;
		this.discussionEpoch++;
		this.update({
			phase: this.state.session ? "reconnecting" : "loading",
			live: [],
			loadingMessages: false,
			loadingDiscussion: false,
			// Old-generation POSTs cannot settle state after this reconnect. Keep the
			// draft and warn that its delivery is unconfirmed, rather than locking input.
			sending: false,
			sendError: this.state.sendError || this.state.sending,
		});
		try {
			const session = await this.client.session(this.abort.signal);
			if (!this.current(generation)) return;
			this.update({ session, phase: "connecting" });
			let snapshotReceived = false;
			await this.client.events(this.abort.signal, (event) => {
				if (!this.current(generation)) return;
				if (event.type === "revoked") {
					this.unavailable();
					return;
				}
				if (event.type === "ping") return;
				if (event.type === "reset") {
					this.resetMessages();
					this.resetDiscussion();
					this.fail(new PublicShareError(409), generation);
					return;
				}
				if (event.type === "snapshot") {
					const firstSnapshot = !snapshotReceived;
					snapshotReceived = true;
					this.retryAttempt = 0;
					if (firstSnapshot) {
						this.resetMessages();
						this.resetDiscussion();
					}
					this.update({ live: event.blocks, liveTruncated: event.truncated, phase: "live" });
					if (firstSnapshot) {
						void this.refreshMessages(generation);
						void this.refreshDiscussion(generation);
					}
					return;
				}
				if (!snapshotReceived) {
					this.fail(new PublicShareError(409), generation);
					return;
				}
				if (event.type === "delta") {
					const live = applyPublicDelta(this.state.live, event);
					if (live) this.update({ live });
					else this.fail(new PublicShareError(409), generation);
					return;
				}
				if (event.scope === "messages") {
					// Tool activity can invalidate persisted rows without ending live output.
					// Only a server snapshot authoritatively replaces/clears the live blocks.
					this.resetMessages(false);
					this.scheduleMessages(generation);
				} else if (event.scope === "discussion") {
					this.resetDiscussion();
					this.scheduleDiscussion(generation);
				} else {
					void this.refreshSession(generation);
				}
			});
			if (this.current(generation)) this.fail(new PublicShareError(503), generation);
		} catch (error) {
			this.fail(error, generation);
		}
	}
	private resetMessages(clearLive = true) {
		this.messagesEpoch++;
		this.update({
			messages: null,
			...(clearLive ? { live: [], liveTruncated: false } : {}),
			loadingMessages: false,
			historyRevision: this.state.historyRevision + 1,
		});
	}
	private resetDiscussion() {
		this.discussionEpoch++;
		this.update({ discussion: null, loadingDiscussion: false });
	}
	private scheduleMessages(generation: number) {
		if (this.messageTimer) return;
		this.messageTimer = setTimeout(() => {
			this.messageTimer = undefined;
			if (this.current(generation)) void this.refreshMessages(generation);
		}, 200);
	}
	private scheduleDiscussion(generation: number) {
		if (this.discussionTimer) return;
		this.discussionTimer = setTimeout(() => {
			this.discussionTimer = undefined;
			if (this.current(generation)) void this.refreshDiscussion(generation);
		}, 200);
	}
	private async refreshSession(generation: number) {
		try {
			const session = await this.client.session(this.abort.signal);
			if (!this.current(generation)) return;
			if (session.messageVersion !== this.state.session?.messageVersion) {
				this.resetMessages(false);
				this.scheduleMessages(generation);
			}
			this.update({ session });
		} catch (error) {
			this.fail(error, generation);
		}
	}
	private async refreshMessages(generation: number) {
		const epoch = this.messagesEpoch;
		this.update({ loadingMessages: true });
		try {
			// Tail reads intentionally omit messageVersion: edits may have advanced it.
			const page = await this.client.messages(this.abort.signal);
			if (!this.current(generation) || epoch !== this.messagesEpoch) return;
			this.update({
				messages: { ...page, messages: mergePublicRows([], page.messages) },
				loadingMessages: false,
				session: this.state.session && {
					...this.state.session,
					messageVersion: page.messageVersion,
				},
			});
		} catch (error) {
			if (epoch === this.messagesEpoch) this.fail(error, generation);
		}
	}
	private async refreshDiscussion(generation: number) {
		const epoch = this.discussionEpoch;
		this.update({ loadingDiscussion: true });
		try {
			const page = await this.client.discussion(this.abort.signal);
			if (!this.current(generation) || epoch !== this.discussionEpoch) return;
			this.update({
				discussion: { ...page, messages: mergePublicRows([], page.messages) },
				loadingDiscussion: false,
			});
		} catch (error) {
			if (epoch === this.discussionEpoch) this.fail(error, generation);
		}
	}
	loadEarlierMessages = async () => {
		const page = this.state.messages;
		if (
			!page?.hasMore ||
			page.nextBeforeSeq === null ||
			this.state.loadingMessages ||
			page.messages.length >= PUBLIC_SHARE_MAX_ROWS ||
			this.abort.signal.aborted
		)
			return;
		const generation = this.generation;
		const epoch = this.messagesEpoch;
		this.update({ loadingMessages: true });
		try {
			const older = await this.client.messages(
				this.abort.signal,
				page.nextBeforeSeq,
				page.messageVersion,
			);
			if (!this.current(generation) || epoch !== this.messagesEpoch) return;
			if (older.messageVersion !== page.messageVersion) {
				this.resetMessages(false);
				this.scheduleMessages(generation);
				return;
			}
			this.update({
				messages: { ...older, messages: mergePublicRows(page.messages, older.messages) },
				loadingMessages: false,
			});
		} catch (error) {
			if (epoch === this.messagesEpoch) this.fail(error, generation);
		}
	};
	loadEarlierDiscussion = async () => {
		const page = this.state.discussion;
		if (
			!page?.hasMore ||
			page.nextBeforeSeq === null ||
			this.state.loadingDiscussion ||
			page.messages.length >= PUBLIC_SHARE_MAX_ROWS ||
			this.abort.signal.aborted
		)
			return;
		const generation = this.generation;
		const epoch = this.discussionEpoch;
		this.update({ loadingDiscussion: true });
		try {
			const older = await this.client.discussion(this.abort.signal, page.nextBeforeSeq);
			if (!this.current(generation) || epoch !== this.discussionEpoch) return;
			this.update({
				discussion: { ...older, messages: mergePublicRows(page.messages, older.messages) },
				loadingDiscussion: false,
			});
		} catch (error) {
			if (epoch === this.discussionEpoch) this.fail(error, generation);
		}
	};
	tool = async (id: string, signal: AbortSignal): Promise<PublicSharedToolDetail | null> => {
		const generation = this.generation;
		const epoch = this.messagesEpoch;
		const linked = linkPublicShareSignals([signal, this.abort.signal]);
		try {
			const detail = await this.client.tool(id, linked.signal);
			return this.current(generation) && epoch === this.messagesEpoch && !signal.aborted
				? detail
				: null;
		} catch (error) {
			if (error instanceof PublicShareError && error.unavailable) this.fail(error, generation);
			throw error;
		} finally {
			linked.dispose();
		}
	};
	post = async (text: string, replyToMessageId?: string): Promise<boolean> => {
		if (this.abort.signal.aborted || this.state.sending || !this.state.session) return false;
		const generation = this.generation;
		const discussionEpoch = this.discussionEpoch;
		this.update({ sending: true, sendError: false });
		try {
			const message: PublicDiscussionMessage = await this.client.post(
				text,
				replyToMessageId,
				this.abort.signal,
			);
			if (!this.current(generation)) return false;
			const page = this.state.discussion;
			// A deletion/invalidation may have overtaken this POST response. Its old
			// body must not overwrite a tombstone from the newer authoritative page.
			if (page && discussionEpoch === this.discussionEpoch)
				this.update({
					discussion: {
						...page,
						messages: mergePublicRows(page.messages, [message]).slice(-PUBLIC_SHARE_MAX_ROWS),
					},
				});
			else this.scheduleDiscussion(generation);
			this.update({ sending: false });
			return true;
		} catch (error) {
			if (!this.current(generation)) return false;
			if (error instanceof PublicShareError && error.unavailable) this.fail(error, generation);
			else this.update({ sending: false, sendError: true });
			return false;
		}
	};
}
