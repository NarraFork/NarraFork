/**
 * public-share-session.ts — The share page's thin session controller.
 *
 * The page's data plane is the narrator's own: the vlist pages the document
 * through the client's `pretextDocument` (Share-token REST) and realtime rides
 * `/ws/narrator` in share-auth mode (setNarratorWSShareAuth). What remains here
 * is the credential lifecycle (load the session card, flip the manager's
 * credential, close it on teardown) and the discussion composer write.
 *
 * One controller per link AND credential, owned by one mounted public page.
 * Nothing persists: no global query cache, no localStorage, no JWT renewal.
 */

import type { PublicSharedSession } from "@shared/public-narrator-share";
import { setNarratorWSShareAuth } from "./narrator-ws-manager";
import { type PublicShareClient, PublicShareError } from "./public-share-api";

export type PublicSharePhase = "loading" | "live" | "error" | "unavailable";
export interface PublicShareViewState {
	session: PublicSharedSession | null;
	phase: PublicSharePhase;
	sending: boolean;
	sendError: boolean;
}

function emptyState(): PublicShareViewState {
	return { session: null, phase: "loading", sending: false, sendError: false };
}

export class PublicShareSession {
	private state = emptyState();
	private listeners = new Set<() => void>();
	private abort = new AbortController();
	private generation = 0;
	private active = false;
	constructor(
		private readonly client: PublicShareClient,
		private readonly shareId: string,
		private readonly credential: string,
	) {}

	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private update(patch: Partial<PublicShareViewState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	start = () => {
		this.active = true;
		void this.connect();
	};
	stop = () => {
		this.active = false;
		this.generation++;
		this.abort.abort();
		// Hand the manager's credential back to the session JWT mode (inert on the
		// public page, but the next mount must never inherit this share).
		setNarratorWSShareAuth(null);
		this.state = emptyState();
	};

	private async connect() {
		this.abort.abort();
		this.abort = new AbortController();
		const generation = ++this.generation;
		this.update({ ...emptyState(), phase: "loading" });
		try {
			const session = await this.client.session(this.abort.signal);
			if (!this.active || generation !== this.generation) return;
			// The session card names the document + room; only now does the manager
			// open the share-authed socket the panes subscribe through.
			setNarratorWSShareAuth({ shareId: this.shareId, token: this.credential });
			this.update({ session, phase: "live" });
		} catch (error) {
			if (!this.active || generation !== this.generation) return;
			if (error instanceof PublicShareError && error.unavailable) {
				this.update({ ...emptyState(), phase: "unavailable" });
				return;
			}
			// Transient failure: the reader retries through the page's reconnect control.
			this.update({ ...emptyState(), phase: "error" });
		}
	}
	reconnect = () => {
		if (this.active && this.state.phase !== "unavailable") void this.connect();
	};

	/** Post one discussion message; the WS broadcast lands it in the pane. */
	post = async (text: string, replyToMessageId?: string): Promise<boolean> => {
		if (this.abort.signal.aborted || this.state.sending || !this.state.session) return false;
		const generation = this.generation;
		this.update({ sending: true, sendError: false });
		try {
			await this.client.post(text, replyToMessageId, this.abort.signal);
			if (!this.active || generation !== this.generation) return false;
			this.update({ sending: false });
			return true;
		} catch (error) {
			if (!this.active || generation !== this.generation) return false;
			if (error instanceof PublicShareError && error.unavailable) {
				this.update({ ...emptyState(), phase: "unavailable" });
				return false;
			}
			this.update({ sending: false, sendError: true });
			return false;
		}
	};
}
