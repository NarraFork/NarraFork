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
	subscribedNarrators: Set<string>;
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
	| { type: "send_message"; narratorId: string; message: string; requestId?: string }
	| { type: "interrupt"; narratorId: string; requestId?: string };

export type ExternalNarratorServerMessage =
	| { type: "ready"; version: 1; maxSubscriptions: number }
	| { type: "subscribed"; narratorIds: string[]; requestId?: string }
	| { type: "unsubscribed"; narratorIds: string[]; requestId?: string }
	| { type: "narrator_changed"; narratorId: string; requestId?: string }
	| { type: "message_accepted"; narratorId: string; requestId?: string }
	| { type: "interrupted"; narratorId: string; requestId?: string }
	| { type: "auth_lost"; code: string; message: string }
	| { type: "rate_limited"; retryAfterSeconds: number; requestId?: string }
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
