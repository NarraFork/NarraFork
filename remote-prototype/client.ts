import {
	generateIdentity,
	hex,
	instanceId,
	sha256Hex,
	sign,
	verify,
} from "../shared/remote-access/identity";
import { LIMITS, type SessionTicket } from "../shared/remote-access/protocol";
import {
	type GrantMessage,
	type PrototypeChannels,
	PrototypeTransport,
	type TransportOptions,
} from "./transport";

export { PrototypeSocket, PrototypeTransport, remotePath } from "./transport";

export interface Invitation {
	instanceId: string;
	publicKey: string;
	pairId: string;
	pairingSecret: string;
	discoveryCapability: string;
	signalUrl: string;
}
/** Stored only in this instance's origin; the non-exportable CryptoKey is structured cloned. */
export interface SavedGrant {
	instanceId: string;
	publicKey: string;
	signalUrl: string;
	grantId: string;
	clientPublicKey: string;
	privateKey: CryptoKey;
	discoveryCapability: string;
	expiresAt: number;
}
export interface ConnectOptions extends TransportOptions {
	stunUrls?: readonly string[];
	allowLocalhost?: boolean;
	/** Additional pin, never overrides a real 52-character instance host. Required on localhost. */
	expectedInstanceId?: string;
	grant?: SavedGrant;
	persistGrant?: boolean;
	negotiationTimeoutMs?: number;
	/** Test-only factories; production defaults are browser native RTC and WebSocket. */
	peerFactory?: (config: RTCConfiguration) => RTCPeerConnection;
	signalFactory?: (url: string) => WebSocket;
	origin?: string;
}
export interface CandidateStats {
	selectedPairId: string;
	localType: string;
	remoteType: string;
	bytesSent: number;
	bytesReceived: number;
}
const encoder = new TextEncoder();
const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
const opaque = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const fingerprint = (value: unknown): value is string =>
	typeof value === "string" && /^[a-z2-7]{52}$/.test(value);
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid_message");
	return value as Record<string, unknown>;
}

/** Validate before creating either the signaling socket or RTCPeerConnection. */
export async function validateInvitation(
	invitation: Invitation,
	options: ConnectOptions = {},
): Promise<void> {
	if (
		!fingerprint(invitation.instanceId) ||
		(await instanceId(invitation.publicKey)) !== invitation.instanceId
	)
		throw new Error("instance_pin_mismatch");
	const origin = new URL(options.origin ?? globalThis.location?.origin ?? "http://localhost");
	const hostPin = origin.hostname.split(".")[0];
	if (fingerprint(hostPin)) {
		if (origin.protocol !== "https:" || hostPin !== invitation.instanceId)
			throw new Error("instance_host_mismatch");
	} else if (
		!loopback(origin.hostname) ||
		!options.allowLocalhost ||
		options.expectedInstanceId !== invitation.instanceId
	)
		throw new Error("instance_origin_required");
	if (
		options.expectedInstanceId !== undefined &&
		options.expectedInstanceId !== invitation.instanceId
	)
		throw new Error("instance_pin_mismatch");
	const signal = new URL(invitation.signalUrl);
	if (
		signal.username ||
		signal.password ||
		signal.hash ||
		signal.search ||
		signal.pathname !== "/signal/browser" ||
		(signal.protocol !== "wss:" &&
			!(signal.protocol === "ws:" && loopback(signal.hostname) && options.allowLocalhost))
	)
		throw new Error("invalid_signal_url");
	if (!opaque(invitation.discoveryCapability)) throw new Error("invalid_discovery_capability");
	if (options.grant) {
		const grant = options.grant;
		if (
			grant.instanceId !== invitation.instanceId ||
			grant.publicKey !== invitation.publicKey ||
			grant.signalUrl !== invitation.signalUrl ||
			grant.discoveryCapability !== invitation.discoveryCapability ||
			!opaque(grant.grantId) ||
			!Number.isSafeInteger(grant.expiresAt) ||
			grant.expiresAt <= Date.now() / 1000 ||
			!/^04[0-9a-f]{128}$/.test(grant.clientPublicKey) ||
			grant.privateKey.type !== "private" ||
			grant.privateKey.extractable
		)
			throw new Error("invalid_saved_grant");
	} else if (
		!opaque(invitation.pairId) ||
		!/^[0-9a-f]{64}$/.test(invitation.pairingSecret) ||
		invitation.pairingSecret === invitation.discoveryCapability
	)
		throw new Error("invalid_invitation");
	assertStunUrls(options.stunUrls ?? []);
}

/** Reject every non-STUN scheme; no usernames, credentials or TURN configuration exist. */
export function assertStunUrls(urls: readonly string[]): void {
	if (urls.length > 4) throw new Error("too_many_stun_servers");
	for (const url of urls) {
		if (!/^stuns?:[A-Za-z0-9.\-[\]:]+(?:\?transport=(?:udp|tcp))?$/.test(url))
			throw new Error("turn_forbidden");
	}
}
export function assertDirectSdp(sdp: string): void {
	if (
		typeof sdp !== "string" ||
		!sdp.startsWith("v=0") ||
		sdp.includes("\0") ||
		encoder.encode(sdp).byteLength > LIMITS.sdpBytes
	)
		throw new Error("invalid_sdp");
	let candidates = 0;
	for (const line of sdp.split(/\r?\n/)) {
		if (!/^a=candidate:/i.test(line)) continue;
		const parts = line.trim().split(/\s+/);
		if (
			++candidates > LIMITS.candidates ||
			encoder.encode(line).byteLength > LIMITS.candidateBytes ||
			parts[6] !== "typ" ||
			!["host", "srflx", "prflx"].includes(parts[7] ?? "")
		)
			throw new Error("relay_or_invalid_candidate");
	}
}

function waitEvent(
	target: EventTarget,
	eventName: string,
	check: () => boolean,
	timeout: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	if (check()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			target.removeEventListener(eventName, event);
			signal?.removeEventListener("abort", abort);
		};
		const event = () => {
			if (check()) {
				cleanup();
				resolve();
			}
		};
		const abort = () => {
			cleanup();
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("negotiation_timeout"));
		}, timeout);
		target.addEventListener(eventName, event);
		signal?.addEventListener("abort", abort, { once: true });
		event();
	});
}

/**
 * Standalone M1 native browser client. connect() completes DC pairing, not business auth.
 * await client.authenticate(B_JWT) (or client.ready) before protected HTTP and sockets.
 * Signal loss does not close direct channels. No HTTP fallback, TURN, restart, PWA or retry.
 */
export class PrototypeClient extends PrototypeTransport {
	readonly peer: RTCPeerConnection;
	private readonly lifecycle = new AbortController();
	private signal?: WebSocket;
	private disconnectTimer?: ReturnType<typeof setTimeout>;
	private statsTimer?: ReturnType<typeof setInterval>;
	private constructor(
		channels: PrototypeChannels,
		peer: RTCPeerConnection,
		options: ConnectOptions,
	) {
		super(channels, options);
		this.peer = peer;
		peer.addEventListener("connectionstatechange", () => {
			clearTimeout(this.disconnectTimer);
			if (peer.connectionState === "failed" || peer.connectionState === "closed")
				this.close(new Error("rtc_failed"));
			else if (peer.connectionState === "disconnected")
				this.disconnectTimer = setTimeout(() => this.close(new Error("rtc_disconnected")), 5000);
		});
	}

	static async connect(
		invitation: Invitation,
		options: ConnectOptions = {},
	): Promise<PrototypeClient> {
		await validateInvitation(invitation, options);
		const identity = options.grant
			? { publicKey: options.grant.clientPublicKey, privateKey: options.grant.privateKey }
			: await generateIdentity();
		const peer = (options.peerFactory ?? ((config) => new RTCPeerConnection(config)))({
			iceServers: (options.stunUrls ?? []).map((url) => ({ urls: url })),
			iceTransportPolicy: "all",
		});
		const channels = {
			control: peer.createDataChannel("nf.control.v1", { ordered: true }),
			realtime: peer.createDataChannel("nf.realtime.v1", { ordered: true }),
			bulk: peer.createDataChannel("nf.bulk.v1", { ordered: true }),
		};
		let client!: PrototypeClient;
		const onGrant = async (message: GrantMessage) => {
			const capability = message.discoveryCapability || options.grant?.discoveryCapability;
			if (!capability || !opaque(capability)) throw new Error("missing_grant_capability");
			if (options.grant && message.grantId !== options.grant.grantId)
				throw new Error("grant_binding_mismatch");
			if (options.persistGrant !== false) {
				await saveGrant({
					instanceId: invitation.instanceId,
					publicKey: invitation.publicKey,
					signalUrl: invitation.signalUrl,
					grantId: message.grantId,
					discoveryCapability: capability,
					expiresAt: message.expiresAt,
					clientPublicKey: identity.publicKey,
					privateKey: identity.privateKey,
				});
			}
			await options.onGrant?.(message);
		};
		client = new PrototypeClient(channels, peer, { ...options, onGrant });
		const timeout = Math.min(options.negotiationTimeoutMs ?? 20_000, 20_000);
		const deadline = setTimeout(() => client.close(new Error("negotiation_timeout")), timeout);
		try {
			peer.addEventListener("icecandidate", (event) => {
				if (event.candidate && event.candidate.type === "relay")
					client.close(new Error("relay_forbidden"));
			});
			await peer.setLocalDescription(await peer.createOffer());
			await waitEvent(
				peer,
				"icegatheringstatechange",
				() => peer.iceGatheringState === "complete",
				timeout,
				client.lifecycle.signal,
			);
			const offer = peer.localDescription?.sdp;
			if (!offer) throw new Error("missing_offer");
			assertDirectSdp(offer);
			const offerHash = await sha256Hex(offer);
			const targetId = options.grant?.grantId ?? invitation.pairId;
			const offerSignature = await sign(identity.privateKey, "offer", [
				invitation.instanceId,
				targetId,
				identity.publicKey,
				offerHash,
			]);
			const signal = (options.signalFactory ?? ((url) => new WebSocket(url)))(invitation.signalUrl);
			client.signal = signal;
			const answer = await client.exchange(
				signal,
				{
					type: "connect",
					instanceId: invitation.instanceId,
					discoveryCapability: invitation.discoveryCapability,
					clientPublicKey: identity.publicKey,
					offer,
					offerSignature,
				},
				timeout,
			);
			const ticket = object(answer.ticket) as unknown as SessionTicket;
			if (
				ticket.instanceId !== invitation.instanceId ||
				ticket.clientPublicKey !== identity.publicKey ||
				ticket.offerHash !== offerHash ||
				ticket.targetId !== targetId ||
				ticket.targetKind !== (options.grant ? "grant" : "invite") ||
				!opaque(ticket.sessionId) ||
				ticket.sessionId !== answer.sessionId ||
				!opaque(ticket.leaseEpoch) ||
				!Number.isSafeInteger(ticket.expiresAt) ||
				ticket.expiresAt <= Date.now() / 1000 ||
				ticket.expiresAt > Date.now() / 1000 + 65 ||
				typeof ticket.signature !== "string" ||
				!/^[0-9a-f]{128}$/.test(ticket.signature) ||
				typeof answer.answer !== "string" ||
				typeof answer.signature !== "string"
			)
				throw new Error("ticket_binding_mismatch");
			assertDirectSdp(answer.answer);
			const answerHash = await sha256Hex(answer.answer);
			// A ticket is checked by B. Only the pinned B signature establishes C's trust.
			if (
				!(await verify(invitation.publicKey, answer.signature, "answer", [
					invitation.instanceId,
					ticket.sessionId,
					identity.publicKey,
					offerHash,
					answerHash,
				]))
			)
				throw new Error("answer_signature_invalid");
			await peer.setRemoteDescription({ type: "answer", sdp: answer.answer });
			await Promise.all(
				Object.values(channels).map((channel) =>
					waitEvent(
						channel,
						"open",
						() => channel.readyState === "open",
						timeout,
						client.lifecycle.signal,
					),
				),
			);
			if (peer.sctp && peer.sctp.maxMessageSize > 0 && peer.sctp.maxMessageSize < LIMITS.frameBytes)
				throw new Error("sctp_message_size_unsupported");
			await client.candidateStats();
			const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
			const signature = await sign(identity.privateKey, "hello", [
				invitation.instanceId,
				ticket.sessionId,
				offerHash,
				answerHash,
				nonce,
				identity.publicKey,
			]);
			await client.sendControl({
				type: "hello",
				nonce,
				signature,
				...(options.grant ? {} : { pairingSecret: invitation.pairingSecret }),
			});
			await client.paired;
			clearTimeout(deadline);
			// Keep checking the actual selected pair; a later relay path is never tolerated.
			client.statsTimer = setInterval(() => {
				void client
					.candidateStats()
					.catch((error) =>
						client.close(error instanceof Error ? error : new Error("candidate_stats_failed")),
					);
			}, 5000);
			return client;
		} catch (error) {
			clearTimeout(deadline);
			client.close(error instanceof Error ? error : new Error("connect_failed"));
			throw error;
		}
	}

	private exchange(
		signal: WebSocket,
		connect: Record<string, unknown>,
		timeout: number,
	): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("message", message);
				signal.removeEventListener("error", failed);
				signal.removeEventListener("close", failed);
				signal.removeEventListener("open", open);
				this.lifecycle.signal.removeEventListener("abort", aborted);
			};
			const failed = () => {
				if (!settled) {
					settled = true;
					cleanup();
					reject(new Error("signaling_failed"));
				}
			};
			const aborted = () => {
				if (!settled) {
					settled = true;
					cleanup();
					reject(this.lifecycle.signal.reason);
				}
			};
			const open = () => {
				signal.send(JSON.stringify(connect));
			};
			const message = (event: MessageEvent) => {
				try {
					if (
						typeof event.data !== "string" ||
						encoder.encode(event.data).byteLength > LIMITS.signalBytes
					)
						throw new Error("invalid_signal_message");
					const data = object(JSON.parse(event.data));
					if (data.type === "error")
						throw new Error(
							`signal_${typeof data.code === "string" ? data.code.slice(0, 64) : "error"}`,
						);
					if (data.type === "candidate") throw new Error("trickle_unsupported");
					if (data.type !== "connected") throw new Error("unexpected_signal_message");
					settled = true;
					cleanup();
					resolve(data);
				} catch (error) {
					settled = true;
					cleanup();
					reject(error);
				}
			};
			const timer = setTimeout(failed, timeout);
			signal.addEventListener("message", message);
			signal.addEventListener("error", failed);
			signal.addEventListener("close", failed);
			signal.addEventListener("open", open);
			this.lifecycle.signal.addEventListener("abort", aborted, { once: true });
			if (this.lifecycle.signal.aborted) aborted();
			else if (signal.readyState === WebSocket.OPEN) open();
		});
	}

	/** Checks both candidate types, not only a local candidate or RTP byte counters. */
	async candidateStats(): Promise<CandidateStats> {
		const report = await this.peer.getStats();
		let pair: RTCStats | undefined;
		let selectedId: string | undefined;
		report.forEach((stat) => {
			if (stat.type === "transport" && typeof stat.selectedCandidatePairId === "string")
				selectedId = stat.selectedCandidatePairId;
		});
		if (selectedId) pair = report.get(selectedId);
		if (!pair)
			report.forEach((stat) => {
				if (
					stat.type === "candidate-pair" &&
					stat.state === "succeeded" &&
					(stat.selected || stat.nominated)
				)
					pair = stat;
			});
		if (!pair) throw new Error("selected_candidate_pair_missing");
		const fields = pair as RTCStats & {
			localCandidateId: string;
			remoteCandidateId: string;
			bytesSent?: number;
			bytesReceived?: number;
		};
		const local = report.get(fields.localCandidateId);
		const remote = report.get(fields.remoteCandidateId);
		if (
			!local ||
			!remote ||
			!["host", "srflx", "prflx"].includes(local.candidateType) ||
			!["host", "srflx", "prflx"].includes(remote.candidateType)
		) {
			this.close(new Error("relay_or_unknown_selected_pair"));
			throw new Error("relay_or_unknown_selected_pair");
		}
		return {
			selectedPairId: pair.id,
			localType: local.candidateType,
			remoteType: remote.candidateType,
			bytesSent: fields.bytesSent ?? 0,
			bytesReceived: fields.bytesReceived ?? 0,
		};
	}

	override close(reason: Error = new Error("client_closed")): void {
		super.close(reason);
		this.lifecycle.abort(reason);
		clearTimeout(this.disconnectTimer);
		clearInterval(this.statsTimer);
		this.signal?.close();
		if (this.peer.connectionState !== "closed") this.peer.close();
	}
}

function grantDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("narrafork-remote-prototype", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("grants");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(new Error("grant_storage_unavailable"));
	});
}
export async function saveGrant(grant: SavedGrant): Promise<void> {
	const database = await grantDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction("grants", "readwrite");
			transaction.objectStore("grants").put(grant, grant.instanceId);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(new Error("grant_storage_failed"));
			transaction.onabort = () => reject(new Error("grant_storage_failed"));
		});
	} finally {
		database.close();
	}
}
export async function loadGrant(id: string): Promise<SavedGrant | undefined> {
	const database = await grantDatabase();
	try {
		return await new Promise<SavedGrant | undefined>((resolve, reject) => {
			const request = database.transaction("grants", "readonly").objectStore("grants").get(id);
			request.onsuccess = () => resolve(request.result as SavedGrant | undefined);
			request.onerror = () => reject(new Error("grant_storage_failed"));
		});
	} finally {
		database.close();
	}
}
export async function forgetGrant(id: string): Promise<void> {
	const database = await grantDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction("grants", "readwrite");
			transaction.objectStore("grants").delete(id);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(new Error("grant_storage_failed"));
			transaction.onabort = () => reject(new Error("grant_storage_failed"));
		});
	} finally {
		database.close();
	}
}

/** Read once, remove fragment before parsing, and never send invitation to an HTTP endpoint. */
export function takeFragmentInvitation(
	location: Pick<Location, "hash" | "pathname" | "search"> = globalThis.location,
	history: Pick<History, "replaceState"> = globalThis.history,
): Invitation | undefined {
	const fragment = location.hash;
	if (!fragment) return;
	history.replaceState(null, "", location.pathname + location.search);
	const payload = fragment.slice(1);
	const decoded = decodeURIComponent(payload.startsWith("invite=") ? payload.slice(7) : payload);
	if (encoder.encode(decoded).byteLength > 8192) throw new Error("invitation_too_large");
	return object(JSON.parse(decoded)) as unknown as Invitation;
}

/** Small-resource adapter. Caller must revoke the URL after use; no SW/network fallback. */
export async function resourceBlob(
	client: PrototypeTransport,
	path: string,
	signal?: AbortSignal,
): Promise<{ url: string; blob: Blob; revoke: () => void }> {
	const response = await client.request(path, { signal });
	if (!response.ok || !response.body) throw new Error("resource_failed");
	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > LIMITS.fileBytes) throw new Error("resource_too_large");
			chunks.push(Uint8Array.from(value));
		}
	} catch (error) {
		await reader.cancel(error);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const blob = new Blob(chunks, {
		type: response.headers.get("content-type") ?? "application/octet-stream",
	});
	const url = URL.createObjectURL(blob);
	return { blob, url, revoke: () => URL.revokeObjectURL(url) };
}
