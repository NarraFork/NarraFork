import type { ServerWebSocket } from "bun";
import { getExternalWebSocketRolloutSettings } from "../services/oauth-ws-ticket-service";
import type {
	ExternalNarratorServerMessage,
	ExternalNarratorWSData,
} from "./external-narrator-ws-types";

export type ExternalNarratorWS = ServerWebSocket<
	ExternalNarratorWSData & { channel: "external-narrator" }
>;

const connections = new Set<ExternalNarratorWS>();
const byToken = new Map<string, Set<ExternalNarratorWS>>();
const byFamily = new Map<string, Set<ExternalNarratorWS>>();
const byGrant = new Map<string, Set<ExternalNarratorWS>>();
const byClient = new Map<string, Set<ExternalNarratorWS>>();
const byUser = new Map<string, Set<ExternalNarratorWS>>();

function addIndex(
	index: Map<string, Set<ExternalNarratorWS>>,
	key: string | null,
	ws: ExternalNarratorWS,
) {
	if (!key) return;
	let values = index.get(key);
	if (!values) {
		values = new Set();
		index.set(key, values);
	}
	values.add(ws);
}

function removeIndex(
	index: Map<string, Set<ExternalNarratorWS>>,
	key: string | null,
	ws: ExternalNarratorWS,
) {
	if (!key) return;
	const values = index.get(key);
	if (!values) return;
	values.delete(ws);
	if (values.size === 0) index.delete(key);
}

function indexSize(index: Map<string, Set<ExternalNarratorWS>>, key: string | null): number {
	return key ? (index.get(key)?.size ?? 0) : 0;
}

export function canAcceptExternalNarratorConnection(): boolean {
	return connections.size < getExternalWebSocketRolloutSettings().maxGlobalConnections;
}

export function registerExternalNarratorConnection(ws: ExternalNarratorWS): boolean {
	if (connections.has(ws)) return true;
	const limits = getExternalWebSocketRolloutSettings();
	const auth = ws.data.authSnapshot.oauth;
	if (
		connections.size >= limits.maxGlobalConnections ||
		indexSize(byToken, auth.tokenId) >= limits.maxConnectionsPerToken ||
		indexSize(byGrant, auth.grantId) >= limits.maxConnectionsPerGrant ||
		indexSize(byClient, auth.oauthClientId) >= limits.maxConnectionsPerClient ||
		indexSize(byUser, ws.data.authSnapshot.user.sub) >= limits.maxConnectionsPerUser
	) {
		return false;
	}
	connections.add(ws);
	addIndex(byToken, auth.tokenId, ws);
	addIndex(byFamily, auth.refreshFamilyId, ws);
	addIndex(byGrant, auth.grantId, ws);
	addIndex(byClient, auth.oauthClientId, ws);
	addIndex(byUser, ws.data.authSnapshot.user.sub, ws);
	return true;
}

/** The only registry cleanup path. Safe to call repeatedly. */
export function unregisterExternalNarratorConnection(ws: ExternalNarratorWS): void {
	if (!connections.delete(ws)) return;
	const auth = ws.data.authSnapshot.oauth;
	removeIndex(byToken, auth.tokenId, ws);
	removeIndex(byFamily, auth.refreshFamilyId, ws);
	removeIndex(byGrant, auth.grantId, ws);
	removeIndex(byClient, auth.oauthClientId, ws);
	removeIndex(byUser, ws.data.authSnapshot.user.sub, ws);
	ws.data.subscribedNarrators.clear();
}

export function getExternalNarratorConnections(): ReadonlySet<ExternalNarratorWS> {
	return connections;
}

export function getExternalNarratorConnectionSnapshot() {
	let subscriptions = 0;
	for (const ws of connections) subscriptions += ws.data.subscribedNarrators.size;
	return {
		connections: connections.size,
		subscriptions,
		tokenIndexKeys: byToken.size,
		familyIndexKeys: byFamily.size,
		grantIndexKeys: byGrant.size,
		clientIndexKeys: byClient.size,
		userIndexKeys: byUser.size,
	};
}

export function isExternalNarratorConnectionRegistered(ws: ExternalNarratorWS): boolean {
	return connections.has(ws);
}

function hardClose(ws: ExternalNarratorWS): void {
	unregisterExternalNarratorConnection(ws);
	try {
		ws.terminate();
	} catch {
		try {
			ws.close(1011, "connection closed");
		} catch {
			// already dead
		}
	}
}

export function sendExternalNarratorFrame(
	ws: ExternalNarratorWS,
	message: ExternalNarratorServerMessage,
): boolean {
	if (!connections.has(ws)) return false;
	const maxBufferedAmount = getExternalWebSocketRolloutSettings().maxBufferedAmount;
	if (ws.getBufferedAmount() > maxBufferedAmount) {
		hardClose(ws);
		return false;
	}
	try {
		ws.send(JSON.stringify(message));
	} catch {
		hardClose(ws);
		return false;
	}
	if (ws.getBufferedAmount() > maxBufferedAmount) {
		hardClose(ws);
		return false;
	}
	return true;
}

export function closeExternalNarratorConnectionForAuthLoss(
	ws: ExternalNarratorWS,
	code = "AUTH_LOST",
	message = "OAuth authorization is no longer valid",
	closeCode = 4003,
): void {
	if (!connections.has(ws)) return;
	try {
		ws.send(
			JSON.stringify({ type: "auth_lost", code, message } satisfies ExternalNarratorServerMessage),
		);
	} catch {
		// close below
	}
	unregisterExternalNarratorConnection(ws);
	try {
		ws.close(closeCode, closeCode === 4001 ? "token expired" : "authorization lost");
	} catch {
		try {
			ws.terminate();
		} catch {
			// already dead
		}
	}
}

function closeIndexed(
	index: Map<string, Set<ExternalNarratorWS>>,
	key: string | null | undefined,
	code: string,
	message: string,
): number {
	if (!key) return 0;
	const matches = [...(index.get(key) ?? [])];
	for (const ws of matches) closeExternalNarratorConnectionForAuthLoss(ws, code, message);
	return matches.length;
}

export function closeExternalNarratorConnectionsByToken(tokenId: string): number {
	return closeIndexed(byToken, tokenId, "TOKEN_REVOKED", "OAuth access token was revoked");
}

export function closeExternalNarratorConnectionsByFamily(refreshFamilyId: string): number {
	return closeIndexed(
		byFamily,
		refreshFamilyId,
		"TOKEN_FAMILY_REVOKED",
		"OAuth refresh token family was revoked",
	);
}

export function closeExternalNarratorConnectionsByGrant(grantId: string): number {
	return closeIndexed(byGrant, grantId, "GRANT_REVOKED", "OAuth grant was revoked");
}

export function closeExternalNarratorConnectionsByClient(oauthClientId: string): number {
	return closeIndexed(byClient, oauthClientId, "CLIENT_REVOKED", "OAuth client was revoked");
}

export function closeAllExternalNarratorConnections(
	code = 1001,
	reason = "server shutting down",
): void {
	for (const ws of [...connections]) {
		unregisterExternalNarratorConnection(ws);
		try {
			ws.close(code, reason);
		} catch {
			// already dead
		}
	}
}
