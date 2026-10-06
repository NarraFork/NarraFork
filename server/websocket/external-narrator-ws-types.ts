import type { OAuthAuthPrincipal } from "../middleware/auth";

export const EXTERNAL_NARRATOR_WS_CHANNEL = "external-narrators" as const;

export type ExternalOAuthWsAuthSnapshot = OAuthAuthPrincipal;

export interface ExternalOAuthTokenIdentity {
	tokenId: string;
	userId: string;
	clientId: string;
	oauthClientId: string;
	grantId: string | null;
	refreshFamilyId: string | null;
	expiresAt: string;
	scopes: string[];
}

export interface ExternalNarratorWSData {
	connectedAt: number;
	lastPongAt: number;
	connectionId: string;
	integrationSubscriptions: Map<string, string>;
	/**
	 * Optional tool-progress subscriptions, kept apart from the primary ones so a grant that is not
	 * authorized for `narrafork.narrator.tool.changed` still gets a working connection.
	 */
	toolSubscriptions: Map<string, string>;
	authSnapshot: ExternalOAuthWsAuthSnapshot;
	controlTokens: number;
	writeTokens: number;
	rateUpdatedAt: number;
	controlLimited: boolean;
	writeLimited: boolean;
}

export type ExternalNarratorClientMessage =
	| { type: "pong" }
	| { type: "subscribe"; narratorIds: string[]; requestId?: string }
	| { type: "unsubscribe"; narratorIds: string[]; requestId?: string }
	| { type: "sync_check"; narratorId: string; requestId?: string }
	| {
			type: "send_message";
			narratorId: string;
			message: string;
			locale?: "en" | "zh-CN";
			requestId?: string;
	  }
	| { type: "interrupt"; narratorId: string; requestId?: string };

export type ExternalNarratorServerMessage =
	| { type: "ready"; version: 1; maxSubscriptions: number }
	| { type: "subscribed"; narratorIds: string[]; requestId?: string }
	| { type: "unsubscribed"; narratorIds: string[]; requestId?: string }
	/**
	 * Something about the narrator changed; the client re-reads over REST.
	 *
	 * `documentRevision` is present ONLY on a `sync_check` reply, never on a pushed
	 * frame. It mirrors `narrators.message_version`, the same value the REST message
	 * page returns, so a client can compare it against the revision it already holds
	 * and skip re-reading a page that cannot have changed — a meaningful saving at
	 * the `full` detail tier, where a page build joins tool rows and projects
	 * payloads.
	 *
	 * It is deliberately absent from pushed frames: the domain event that produces
	 * them carries no version, so filling the field would mean one indexed read per
	 * subscriber per event on the fan-out path. A pushed frame stays a pure signal;
	 * a client that wants the cheap check asks for it with `sync_check`.
	 */
	| { type: "narrator_changed"; narratorId: string; documentRevision?: number; requestId?: string }
	/**
	 * A tool call reached a terminal state. Bounded metadata only: tool input/output are never sent.
	 * Best-effort — grants without the tool topic simply never receive this frame.
	 */
	| {
			type: "tool_changed";
			narratorId: string;
			toolName: string;
			status: string;
			toolUseId?: string;
			durationMs?: number;
			executionDeviceId?: string;
			errorMessage?: string;
	  }
	/**
	 * The server-side event queue for this subscription overflowed (or otherwise lost events),
	 * so incremental `narrator_changed` notifications are no longer trustworthy. The client must
	 * re-read state over REST and resubscribe; an overflowed subscription stays silent forever
	 * otherwise, which looks exactly like "everything is fine".
	 */
	| { type: "resync_required"; narratorId: string; reason: string }
	/**
	 * The subscription is gone (revoked after a delivery failure, or cancelled server-side).
	 * Previously this was completely silent: the client kept a "connected" UI with no updates.
	 */
	| { type: "subscription_lost"; narratorId: string; reason: string }
	| { type: "message_accepted"; narratorId: string; requestId?: string }
	/** `interrupted` reports whether a running turn was actually aborted, not just accepted. */
	| { type: "interrupted"; narratorId: string; interrupted: boolean; requestId?: string }
	| { type: "auth_lost"; code: string; message: string }
	/**
	 * `retryAfterSeconds` is the legacy, whole-second field (always >= 1). The connection budget
	 * actually refills in 50-500ms, so new clients should back off on `retryAfterMs` instead.
	 */
	| {
			type: "rate_limited";
			retryAfterSeconds: number;
			retryAfterMs?: number;
			requestId?: string;
	  }
	| { type: "error"; code: string; message: string; requestId?: string }
	| { type: "ping" };

export function principalFromExternalWsAuth(auth: ExternalOAuthTokenIdentity): OAuthAuthPrincipal {
	return {
		type: "oauth",
		user: {
			sub: auth.userId,
			role: "user",
			iat: 0,
			exp: Math.max(0, Math.floor(Date.parse(auth.expiresAt) / 1_000)),
		},
		oauth: {
			tokenId: auth.tokenId,
			clientId: auth.clientId,
			oauthClientId: auth.oauthClientId,
			grantId: auth.grantId,
			refreshFamilyId: auth.refreshFamilyId,
			expiresAt: auth.expiresAt,
			scopes: [...auth.scopes],
		},
	};
}
