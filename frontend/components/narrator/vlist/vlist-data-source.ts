/**
 * vlist-data-source.ts — The vlist's pluggable data boundary.
 *
 * `PretextExactMessageList` reads through four seams: document pages, message
 * location, tool-call detail, and "who is viewing" (bubble side). In the
 * narrator panel all four default to the authenticated narrator APIs. Surfaces
 * that render the same document through a DIFFERENT credential — the anonymous
 * public share page, whose requests carry `Authorization: Share <token>` —
 * inject these instead of forking the shell.
 *
 * Everything is optional: an absent field falls back to the narrator behavior,
 * so the panel's data path is byte-identical when no dataSource is passed.
 *
 * Realtime does NOT ride this interface: the public share connects to the same
 * `/ws/narrator` channel (the manager's share-auth mode, see
 * `narrator-ws-manager.setNarratorWSShareAuth`), so streaming, live patches and
 * structural events arrive through the shell's existing subscriptions.
 */

import type { NarratorWSCallbacks } from "@frontend/hooks/useNarratorWS";
import type { PretextDocumentFetchPage } from "./pretext-document-loader";

/** Reference pinning for a tool detail fetch (provider ids can repeat). */
export interface VListToolDetailRef {
	toolCallId?: string;
	messageId?: string;
	/** Cache discriminator only; never a substitute for a row PK or message ref. */
	executionAttempt?: number;
}

/** What a detail fetch must return; fields mirror ToolCallRecord's JSON. */
export interface VListToolDetailPayload {
	inputJson?: unknown;
	outputJson?: unknown;
}

export interface VListDataSource {
	/** Complete Write fields, using this surface's existing authorization policy. */
	fetchTextDocumentRange?: import("@shared/pretext-layout/text-document").TextDocumentRangeReader;
	/** Lazily recover a persisted Write as a pageable source instead of a giant detail payload. */
	ensureWriteDocumentSource?: import("../content/useWriteDocumentSources").WriteDocumentSourceEnsurer;
	/**
	 * Viewer identity for bubble side resolution (isSelf). `null` means "every
	 * user bubble is somebody else's" — the anonymous share reading a session.
	 * Absent → the signed-in user via `useCurrentUser()`.
	 */
	viewerId?: string | null;
	/** Host-owned download/auth policy; absent leaves narrator/share behavior unchanged. */
	onFetchAttachment?: (fetchUrl: string, filename: string) => void;
	/** Document page fetch (pretext document windows). */
	fetchPage?: PretextDocumentFetchPage;
	/** Message id → document coordinate (jump targets). */
	locateMessage?: (
		narratorId: string,
		messageId: string,
		signal?: AbortSignal,
	) => Promise<{ messageId: string; topLevelMessageId?: string; seq: number }>;
	/** Full (untruncated) tool input/output for an expanded card. */
	fetchToolDetail?: (
		narratorId: string,
		toolUseId: string,
		ref: VListToolDetailRef,
		signal: AbortSignal,
	) => Promise<VListToolDetailPayload | null>;
	/**
	 * External message-event subscription (chat rooms, and any surface whose
	 * updates do not arrive as narrator WS messages). Receives the shell's
	 * handler set (a stable forwarding object) and returns an unsubscribe.
	 * When present, the shell's own useNarratorWS subscription is skipped.
	 */
	subscribeMessages?: (handlers: NarratorWSCallbacks) => () => void;
}
