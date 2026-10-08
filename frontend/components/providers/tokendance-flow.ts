import type { TokenDanceDraftRestore, TokenDanceDraftSnapshot } from "@shared/tokendance";
import { api } from "../../lib/api";
import { onTokenChange } from "../../lib/api/client";
import { getAppBase } from "../../lib/base-path";
import { rebaseProviderState } from "./provider-settings-rebase";
import { createSnapshot, type ProvidersState, type SavedSnapshot } from "./providers-reducer";

export const TOKENDANCE_FLOW_MARKER = "narrafork_tokendance_flow";
export function tokenDanceCallbackUrl() {
	return new URL(`${getAppBase()}settings/providers/tokendance/callback`, window.location.origin)
		.href;
}
export function tokenDanceDraftSnapshot(
	state: ProvidersState,
	baseline: SavedSnapshot,
	addPage?: Record<string, unknown>,
): TokenDanceDraftSnapshot {
	// Only provider reducer fields: never copy settings or TokenDance connection credentials.
	return structuredClone({
		draft: { ...createSnapshot(state) },
		baseline: { ...baseline },
		...(addPage ? { addPage } : {}),
	});
}
export function restoreTokenDanceDraft(
	snapshot: TokenDanceDraftSnapshot,
	fresh: Record<string, unknown>,
) {
	const draft = snapshot.draft as unknown as SavedSnapshot;
	const local: ProvidersState = {
		...draft,
		initialized: true,
		hiddenModels: new Set(draft.hiddenModels),
		disabledProviders: new Set(draft.disabledProviders),
	};
	return rebaseProviderState(local, snapshot.baseline as unknown as SavedSnapshot, fresh);
}
// StrictMode/remount share a single claim. Retain the result only while the marker exists.
const restoreClaims = new Map<
	string,
	Promise<{ restore: TokenDanceDraftRestore; fresh: Record<string, unknown> }>
>();
let draftOwner: string | undefined;
let draftOwnerEpoch = 0;
export function setTokenDanceDraftOwner(ownerId: string | undefined) {
	if (draftOwner === ownerId) return;
	draftOwner = ownerId;
	draftOwnerEpoch++;
	restoreClaims.clear();
}
onTokenChange((token) => {
	if (!token) setTokenDanceDraftOwner(undefined);
});
export class TokenDanceFreshSettingsError extends Error {
	constructor() {
		super("TokenDance draft settings could not be loaded");
	}
}
export function claimTokenDanceDraft(flowId: string, ownerId: string) {
	if (!ownerId || ownerId !== draftOwner)
		return Promise.reject(new Error("TokenDance draft owner changed"));
	const cacheKey = `${ownerId}\u0000${flowId}`;
	const epoch = draftOwnerEpoch;
	const assertOwner = () => {
		if (draftOwner !== ownerId || draftOwnerEpoch !== epoch)
			throw new Error("TokenDance draft owner changed");
	};
	let promise = restoreClaims.get(cacheKey);
	if (!promise) {
		promise = (async () => {
			const fresh = await api
				.getSettings({ signal: AbortSignal.timeout(30_000), maxResponseBytes: 8 * 1024 * 1024 })
				.catch(() => {
					throw new TokenDanceFreshSettingsError();
				});
			assertOwner();
			const restore = await api.tokenDanceDraftRestore(flowId);
			assertOwner();
			if (restore.status === "pending") await api.tokenDanceOAuthCancel(flowId).catch(() => {});
			assertOwner();
			return { restore, fresh: fresh as Record<string, unknown> };
		})();
		restoreClaims.set(cacheKey, promise);
		void promise.catch(() => {
			if (restoreClaims.get(cacheKey) === promise) restoreClaims.delete(cacheKey);
		});
	}
	return promise;
}
export function readTokenDanceFlowMarker(): string | null {
	try {
		return sessionStorage.getItem(TOKENDANCE_FLOW_MARKER);
	} catch {
		return null;
	}
}
export function clearTokenDanceFlow(flowId: string) {
	try {
		if (readTokenDanceFlowMarker() === flowId) sessionStorage.removeItem(TOKENDANCE_FLOW_MARKER);
	} catch {
		/* Storage may be unavailable in private/embedded browsers. */
	}
	for (const key of restoreClaims.keys())
		if (key.endsWith(`\u0000${flowId}`)) restoreClaims.delete(key);
}
export async function startTokenDanceLogin(snapshot: TokenDanceDraftSnapshot) {
	callbackCapture = undefined;
	callbackCompletion = undefined;
	const flow = await api.tokenDanceOAuthStart({
		callbackUrl: tokenDanceCallbackUrl(),
		draftSnapshot: snapshot,
	});
	try {
		sessionStorage.setItem(TOKENDANCE_FLOW_MARKER, flow.flowId);
		window.location.assign(flow.authorizeUrl);
	} catch {
		await api.tokenDanceOAuthCancel(flow.flowId).catch(() => {});
		clearTokenDanceFlow(flow.flowId);
		throw new Error("TokenDance navigation failed");
	}
}
export type TokenDanceCallbackCapture = { flowId: string | null; code: string | null };
let callbackCapture: TokenDanceCallbackCapture | undefined;
let callbackCompletion: Promise<boolean> | undefined;
export function captureTokenDanceCallback(): TokenDanceCallbackCapture {
	if (!callbackCapture) {
		const params = new URLSearchParams(window.location.search);
		callbackCapture = { flowId: params.get("state"), code: params.get("code") };
		// Remove every query/hash before sending a network request. No code/key in browser storage.
		window.history.replaceState(window.history.state, "", window.location.pathname);
	}
	return callbackCapture;
}
export function completeTokenDanceCallback() {
	if (!callbackCompletion) {
		const { flowId, code } = captureTokenDanceCallback();
		callbackCompletion = (async () => {
			if (!flowId || flowId !== readTokenDanceFlowMarker()) return false;
			if (!code) {
				await api.tokenDanceOAuthCancel(flowId).catch(() => {});
				return false;
			}
			try {
				await api.tokenDanceOAuthComplete({ flowId, code });
				return true;
			} catch {
				return false;
			}
		})();
	}
	return callbackCompletion;
}
