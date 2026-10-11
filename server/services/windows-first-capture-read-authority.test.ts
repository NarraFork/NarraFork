import { afterEach, beforeEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
	WINDOWS_FIRST_CAPTURE_FEATURE,
	type WindowsFirstCaptureOriginSeed,
} from "@shared/windows-first-capture";
import golden from "@shared/windows-first-capture.golden.json";
import {
	canonicalWindowsIoJson,
	type WindowsIoTicketPayload,
	windowsIoTicketSignedBytes,
} from "@shared/windows-io-authority";
import {
	encodeWindowsMetadataCallback,
	type WindowsMetadataCallback,
	windowsMetadataHelperChallengeSignedBytes,
} from "@shared/windows-metadata-callback";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { aclGrants, narratorBlacklistDirs, narrators, remoteDevices, users } from "../db/schema";
import { setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { DEVICE_PROTOCOL_VERSION, type RpcRequestFrame } from "../lib/agent/execution/rpc-types";
import { createToken } from "../lib/auth";
import { generateId } from "../lib/id";
import type { WindowsIoAuthoritySigner } from "../lib/windows-io-authority-broker-client";
import { verifyWindowsIoSignedTicket } from "../lib/windows-io-authority-crypto";
import { invalidateUserCache, requireAuth } from "../middleware/auth";
import { remoteEditorSessionProvenance } from "../middleware/remote-recovery-provenance";
import { getDeviceMetadataSession, handleDeviceWS, sendRpc } from "./device-connection-service";
import { createRemoteBackend } from "./device-remote-backend";
import { hashDeviceToken } from "./device-service";
import { ExecutionPolicyEngine } from "./execution-policy/engine";
import {
	currentRemoteEditorSessionOrigin,
	type RemoteEditorSessionOrigin,
	requireRemoteEditorSessionOrigin,
} from "./remote-history-recovery-auth";
import {
	bindWindowsFirstCaptureReadAuthority,
	type WindowsFirstCaptureReadStamp,
} from "./windows-first-capture-read-authority";
import {
	createWindowsIoAuthorityForUnitTests,
	type WindowsIoAuthorizationRequest,
} from "./windows-io-authority";
import {
	registerAdmission,
	type WindowsMetadataAdmission,
	type WindowsMetadataOriginalOperation,
} from "./windows-metadata-admission";

// Real JWT/opaque HTTP ref, real DB ACL/policy, sendRpc/WS pending and production fresh
// boundary. ONLY the explicitly unit-test authority signer is synthetic Ed25519;
// no production provider/custody bool/native capture/OS isolation is replaced or claimed.
type Socket = Parameters<typeof handleDeviceWS.message>[0];
let userId: string, ownerId: string, narratorId: string, deviceId: string, token: string;
let socket: Socket;
let frames: RpcRequestFrame[];
let onMetadataTicket: ((ticket: unknown) => void) | undefined;
const marker = new AsyncLocalStorage<string>();
const originalCompile = ExecutionPolicyEngine.prototype.compile;
beforeEach(async () => {
	userId = generateId();
	ownerId = generateId();
	narratorId = generateId();
	deviceId = generateId();
	frames = [];
	const now = new Date().toISOString();
	await db.insert(users).values(
		[userId, ownerId].map((id) => ({
			id,
			username: id,
			passwordHash: "not-a-credential",
			role: "admin" as const,
			createdAt: now,
		})),
	);
	await db.insert(narrators).values({
		id: narratorId,
		title: "fresh boundary fixture",
		ownerUserId: ownerId,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "fresh boundary fixture",
		slug: deviceId,
		tokenHash: hashDeviceToken("fresh-boundary-unit"),
		tokenPrefix: "test",
		connectionMode: "reverse",
		status: "offline",
		scope: "global",
		createdBy: userId,
		createdAt: now,
		updatedAt: now,
	});
	socket = {
		readyState: 1,
		data: {
			channel: "device",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			authenticated: false,
		},
		send(data: string) {
			const frame = JSON.parse(data) as RpcRequestFrame;
			frames.push(frame);
			if ((frame as unknown as { type: string }).type === "windows_metadata_callback_result")
				onMetadataTicket?.((frame as unknown as { ticket: unknown }).ticket);
			// Ordinary canonical-path data-plane fixture only; no metadata/native capture.
			if (frame.method === "fs.stat")
				queueMicrotask(() => {
					void handleDeviceWS.message(socket, {
						type: "rpc_result",
						id: frame.id,
						ok: true,
						result: {
							exists: true,
							resolvedPath: frame.params.path,
							isFile: true,
							isDir: false,
							size: 0,
							mode: 420,
							mtimeMs: 1,
						},
					});
				});
			return data.length;
		},
		close() {},
	} as unknown as Socket;
	await handleDeviceWS.message(socket, {
		type: "hello",
		protocolVersion: DEVICE_PROTOCOL_VERSION,
		deviceRef: deviceId,
		token: "fresh-boundary-unit",
		agentVersion: "unit_not_native",
		platform: { os: "windows", arch: "amd64" },
		capabilities: { features: [WINDOWS_FIRST_CAPTURE_FEATURE] },
	});
	setRemoteBackendResolver((id) => {
		const session = getDeviceMetadataSession(id);
		return session
			? createRemoteBackend(id, {
					connectionGeneration: session.runtimeGeneration,
					platform: { os: "windows", arch: "amd64" },
				})
			: null;
	});
	token = await createToken(userId, "admin", 0);
});
afterEach(async () => {
	ExecutionPolicyEngine.prototype.compile = originalCompile;
	onMetadataTicket = undefined;
	handleDeviceWS.close(socket);
	setRemoteBackendResolver(null);
	invalidateUserCache(userId);
	invalidateUserCache(ownerId);
	await db.delete(aclGrants).where(eq(aclGrants.scopeId, narratorId));
	await db.delete(narrators).where(eq(narrators.id, narratorId));
	await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
	await db.delete(users).where(inArray(users.id, [userId, ownerId]));
});

async function scenario(
	change: () => Promise<void>,
	endEarly = false,
	afterTrailingCompile?: () => Promise<void>,
	throughMetadata = false,
	duringIssuedProbe?: () => Promise<void>,
	differentHttpOrigin = false,
) {
	const entered = Promise.withResolvers<void>(),
		probe = Promise.withResolvers<void>(),
		allocated = Promise.withResolvers<void>();
	let origin: RemoteEditorSessionOrigin | undefined;
	let fresh: ((signal: AbortSignal) => Promise<WindowsFirstCaptureReadStamp>) | undefined;
	let rpc: Promise<unknown> | undefined;
	let signatures = 0;
	let callbackActive = false;
	let callbackProbed = false;
	let originalOperation: WindowsMetadataOriginalOperation | undefined;
	let helperKeys: { publicKey: KeyObject; privateKey: KeyObject } | undefined;
	const receivedTicket = Promise.withResolvers<unknown>();
	let delivered = 0;
	onMetadataTicket = (ticket) => {
		delivered++;
		receivedTicket.resolve(ticket);
	};
	let trailing = false;
	let changedAfterCompile = false;
	const contexts: Array<{
		origin: RemoteEditorSessionOrigin | undefined;
		marker: string | undefined;
	}> = [];
	ExecutionPolicyEngine.prototype.compile = function (...args) {
		contexts.push({ origin: currentRemoteEditorSessionOrigin(userId), marker: marker.getStore() });
		return originalCompile.apply(this, args).then(async (result) => {
			if (trailing && afterTrailingCompile && !changedAfterCompile) {
				changedAfterCompile = true;
				await afterTrailingCompile();
			}
			return result;
		});
	};
	const app = new Hono();
	app.onError((error, c) => {
		allocated.reject(error);
		return c.json({ unproven: true }, 500);
	});
	app.use("*", requireAuth);
	app.use("*", (c, next) => marker.run(`http:${c.req.path}`, next));
	app.use("*", remoteEditorSessionProvenance);
	let foreignFrame: unknown;
	let foreignOrigin: RemoteEditorSessionOrigin | undefined;
	app.post("/deliver", async (c) => {
		foreignOrigin = requireRemoteEditorSessionOrigin(ownerId);
		await handleDeviceWS.message(socket, foreignFrame);
		return c.json({ delivered: true });
	});
	app.post("/capture", async (c) => {
		const originalOrigin = requireRemoteEditorSessionOrigin(userId);
		origin = originalOrigin;
		const session = getDeviceMetadataSession(deviceId);
		if (!session) throw new Error("missing actual connection");
		const actor = { userId, narratorId, projectId: null, kind: "human" as const };
		fresh = bindWindowsFirstCaptureReadAuthority({
			registry: { options: { db } },
			origin,
			userId,
			actor,
			target: () => ({
				deviceId,
				cwd: "C:\\工作区",
				lexicalPath: "C:\\工作区\\original.txt",
				canonicalPath: "C:\\工作区\\original.txt",
				runtimeGeneration: session.runtimeGeneration,
			}),
		});
		const keys = generateKeyPairSync("ed25519");
		const signer: WindowsIoAuthoritySigner = {
			kind: "unit_test_only_not_native",
			pin: {
				issuer: "unit-control",
				serviceId: "unit-authority",
				keyEpoch: 1,
				publicKey: keys.publicKey
					.export({ type: "spki", format: "der" })
					.subarray(-32)
					.toString("base64url"),
			},
			async readiness() {
				return { ready: true, reason: "unit_test_only_not_native" };
			},
			async signAuthorizedPayload(payload) {
				signatures++;
				return sign(null, windowsIoTicketSignedBytes(payload), keys.privateKey);
			},
		};
		const authority = createWindowsIoAuthorityForUnitTests({
			signer,
			async readCurrentActorOrigin() {
				await fresh?.(c.req.raw.signal);
				return {
					source: "http",
					userId,
					actorSubjectKey: `human:${userId}`,
					narratorId,
					projectId: null,
					originRefHash: "a".repeat(64),
					credentialRef: originalOrigin,
				};
			},
			async revalidateActor() {
				const stamp = await fresh?.(c.req.raw.signal);
				if (!stamp) throw new Error("missing registered fresh read stamp");
				return canonicalWindowsIoJson([stamp.policyRevision, stamp.aclDigest, stamp.targetDigest]);
			},
			async authorizeOperation(_actor, request, signal) {
				await fresh?.(signal);
				return request;
			},
		});
		const trusted = await authority.captureTrustedActor(c.req.raw.signal);
		const full = JSON.parse(
			Buffer.from(golden.issuedTicket.payload, "base64url").toString(),
		) as WindowsIoTicketPayload;
		const {
			version: _v,
			issuer: _i,
			serviceId: _s,
			keyEpoch: _k,
			actorSubjectKey: _a,
			narratorId: _n,
			projectId: _p,
			originRefHash: _o,
			issuedAt: _iat,
			expiresAt: _exp,
			nonce: _nonce,
			...base
		} = full;
		const request: WindowsIoAuthorizationRequest = {
			...base,
			deviceId,
			connectionId: session.connectionId,
			sessionId: session.sessionId,
			runtimeGeneration: session.runtimeGeneration,
			scopeId: "unit-real-policy",
			operationId: "unit-current-request",
			leaseId: "unit-correlation-only-not-native",
		};
		let admission: WindowsMetadataAdmission | undefined;
		if (throughMetadata) {
			const { action: _action, challengeNonce: _challenge, ...original } = request;
			originalOperation = original;
			helperKeys = generateKeyPairSync("ed25519");
			admission = await registerAdmission({
				authority,
				actor: trusted,
				credentialRef: originalOrigin,
				phase: "capture_readonly",
				original,
				signal: c.req.raw.signal,
				scopeProof: {
					version: 2,
					matrix: "ordinary-file-v2",
					deviceId,
					executorSourceId: original.executorSourceId,
					scopeId: original.scopeId,
					root: original.root,
					helperInstanceId: original.helperInstanceId,
					helperKeyEpoch: 1,
					helperPublicKey: helperKeys.publicKey
						.export({ type: "spki", format: "der" })
						.subarray(-32)
						.toString("base64url"),
				},
				async freshAuthorize(_context, signal) {
					await fresh?.(signal);
					if (callbackActive && !callbackProbed) {
						callbackProbed = true;
						entered.resolve();
						await probe.promise;
					}
					const stamp = await fresh?.(signal);
					if (!stamp) throw new Error("missing original fresh stamp");
					return canonicalWindowsIoJson([
						stamp.policyRevision,
						stamp.aclDigest,
						stamp.targetDigest,
					]);
				},
				async onTicketIssued(ticket, _callback, signal) {
					if (duringIssuedProbe) await duringIssuedProbe();
					await fresh?.(signal);
					verifyWindowsIoSignedTicket(ticket, [signer.pin], Date.now());
				},
			});
		}
		const { outerRpcId: _outer, ...seed } = JSON.parse(golden.capture.canonicalPayload).origin;
		const originSeed: WindowsFirstCaptureOriginSeed = {
			...seed,
			deviceId,
			connectionId: session.connectionId,
			sessionId: session.sessionId,
			runtimeGeneration: session.runtimeGeneration,
			scopeId: request.scopeId,
			operationId: request.operationId,
			leaseId: request.leaseId,
			helperKeyEpoch: 1,
			phase: "capture",
			version: 1,
		};
		rpc = sendRpc(
			deviceId,
			"history.metadataCapture",
			{
				version: 1,
				token: golden.token,
				preauthRpcId: "unit_preauth",
				preauthNonce: "A".repeat(32),
				captureNonce: "B".repeat(32),
			},
			{
				signal: c.req.raw.signal,
				windowsMetadataAdmission: admission,
				windowsFirstCapture: {
					origin: originSeed,
					onAllocated() {
						allocated.resolve();
					},
					async verifyResult(_value, pending) {
						await fresh?.(pending.signal);
						if (throughMetadata)
							throw new Error("unit metadata callback ticket only, no captured native completion");
						entered.resolve();
						await probe.promise;
						await fresh?.(pending.signal);
						const ticket = await authority.issueTicket(trusted, request, pending.signal);
						verifyWindowsIoSignedTicket(ticket, [signer.pin], Date.now());
						throw new Error("unit signed ticket only; no native completion fixture");
					},
				},
			},
		);
		void rpc.catch((error) => allocated.reject(error));
		if (endEarly) return c.json({ ended: true });
		try {
			await rpc;
			return c.json({ unexpected: true });
		} catch {
			return c.json({ unproven: true });
		}
	});
	try {
		const response = Promise.resolve(
			app.request("/capture", {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		void response.then((result) => {
			if (!rpc)
				allocated.reject(
					new Error(`HTTP setup returned ${result.status}, compiler checks=${contexts.length}`),
				);
		});
		const setupTimeout = setTimeout(
			() =>
				allocated.reject(
					new Error(
						`setup awaiting RPC compiler=${contexts.length}: ${frames
							.filter((frame) => frame.type === "rpc")
							.map((frame) => frame.method)
							.join(",")}`,
					),
				),
			1000,
		);
		try {
			await allocated.promise;
		} finally {
			clearTimeout(setupTimeout);
		}
		if (endEarly) await response;
		const frame = frames.filter((f) => f.type === "rpc").at(-1);
		if (!frame) throw new Error("missing RPC");
		if (throughMetadata) {
			if (!originalOperation || !helperKeys || !rpc)
				throw new Error("missing registered actual admission");
			const o = originalOperation;
			const callback: WindowsMetadataCallback = {
				type: "windows_metadata_callback",
				version: 1,
				outerRpcId: frame.id,
				stepId: generateId(),
				nonce: "D".repeat(32),
				action: "capture_exact",
				helperChallenge: {
					helperInstanceId: o.helperInstanceId,
					keyEpoch: 1,
					challengeNonce: "A".repeat(32),
					connectionId: o.connectionId,
					sessionId: o.sessionId,
					runtimeGeneration: o.runtimeGeneration,
					signature: "A".repeat(86),
				},
				descriptors: { root: o.root, parent: o.parent, target: o.target },
				proofIds: { captureProofId: null, preparedObjectId: null },
				expectedCurrent: { metadataHash: null, contentHash: null },
			};
			callback.helperChallenge.signature = sign(
				null,
				windowsMetadataHelperChallengeSignedBytes(callback, o),
				helperKeys.privateKey,
			).toString("base64url");
			callbackActive = true;
			await marker.run("foreign:websocket", () =>
				handleDeviceWS.message(
					socket,
					callback,
					Buffer.from(encodeWindowsMetadataCallback(callback)).toString("utf8"),
				),
			);
			await Promise.race([entered.promise, rpc]);
			await change();
			trailing = true;
			probe.resolve();
			await Promise.race([receivedTicket.promise, rpc]);
		}
		if (differentHttpOrigin) {
			foreignFrame = {
				type: "rpc_result",
				id: frame.id,
				ok: true,
				result: { untrusted: "not native completion" },
			};
			await app.request("/deliver", {
				method: "POST",
				headers: { authorization: `Bearer ${await createToken(ownerId, "admin", 0)}` },
			});
		} else
			await marker.run("foreign:websocket", () =>
				handleDeviceWS.message(socket, {
					type: "rpc_result",
					id: frame.id,
					ok: true,
					result: { untrusted: "not native completion" },
				}),
			);
		if (!endEarly && !throughMetadata) {
			await entered.promise;
			await change();
			trailing = true;
			probe.resolve();
			await response;
		} else probe.resolve();
		await rpc;
		throw new Error("lifecycle result unexpectedly accepted");
	} catch (error) {
		// Expected rejection from genuine pending verifier, not a captured result.
		if (!(error instanceof Error) || !/unproven|requires reconciliation/.test(error.message))
			throw error;
		return { signatures, delivered, contexts, origin, foreignOrigin, fresh };
	} finally {
		probe.resolve();
		ExecutionPolicyEngine.prototype.compile = originalCompile;
	}
}

test("actual HTTP -> foreign WS -> fresh read boundary restores original opaque ref and unrelated ALS", async () => {
	const result = await scenario(async () => {});
	expect(result.signatures).toBe(1);
	expect(result.contexts.length).toBeGreaterThan(4);
	for (const context of result.contexts) {
		expect(context.origin).toBe(result.origin);
		expect(context.marker).toBe("http:/capture");
	}
	await expect(result.fresh?.(new AbortController().signal)).rejects.toThrow("INVALID");
});

test("another live authenticated user HTTP scope cannot replace original RPC origin", async () => {
	const result = await scenario(async () => {}, false, undefined, false, undefined, true);
	expect(result.signatures).toBe(1);
	expect(result.foreignOrigin).toBeDefined();
	expect(result.foreignOrigin).not.toBe(result.origin);
	for (const context of result.contexts) {
		expect(context.origin).toBe(result.origin);
		expect(context.marker).toBe("http:/capture");
	}
});

for (const mode of ["token-version", "role", "device-revoke", "delete-user"] as const) {
	test(`revocation during probe (${mode}) fails trailing fresh boundary before actual unit signer`, async () => {
		const result = await scenario(async () => {
			if (mode === "token-version")
				await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, userId));
			if (mode === "role") await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
			if (mode === "device-revoke")
				await db
					.update(remoteDevices)
					.set({ revokedAt: new Date().toISOString() })
					.where(eq(remoteDevices.id, deviceId));
			if (mode === "delete-user") await db.delete(users).where(eq(users.id, userId));
		});
		expect(result.signatures).toBe(0);
	});
}

test("real HTTP + actual signed helper WS metadata callback delivers only its original unit ticket", async () => {
	const result = await scenario(async () => {}, false, undefined, true);
	expect(result.signatures).toBe(1);
	for (const context of result.contexts) {
		expect(context.origin).toBe(result.origin);
		expect(context.marker).toBe("http:/capture");
	}
});

test("actual metadata callback final probe revocation returns no ticket and rejects original pending", async () => {
	const result = await scenario(
		async () => {
			await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, userId));
		},
		false,
		undefined,
		true,
	);
	expect(result.signatures).toBe(0);
});

test("actual issued-ticket observer awaiting final probe cannot deliver after token revocation", async () => {
	const result = await scenario(
		async () => {},
		false,
		undefined,
		true,
		async () => {
			await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, userId));
		},
	);
	expect(result.signatures).toBe(1);
	expect(result.delivered).toBe(0);
});

test("actual issued-ticket observer awaiting final probe cannot deliver after policy revocation", async () => {
	const result = await scenario(
		async () => {},
		false,
		undefined,
		true,
		denyTargetWithoutCacheInvalidation,
	);
	expect(result.signatures).toBe(1);
	expect(result.delivered).toBe(0);
});

test("ended HTTP cannot sign from late actual signed helper metadata callback", async () => {
	const result = await scenario(async () => {}, true, undefined, true);
	expect(result.signatures).toBe(0);
});

test("ended original HTTP request cannot survive as restored WS request currency", async () => {
	const result = await scenario(async () => {}, true);
	expect(result.signatures).toBe(0);
});

async function denyTargetWithoutCacheInvalidation() {
	await db.insert(narratorBlacklistDirs).values({
		id: generateId(),
		narratorId,
		path: "C:\\工作区\\original.txt",
		pathFlavor: "windows",
		denyLevel: "denyAll",
		enabled: true,
		createdAt: new Date().toISOString(),
	});
}

test("policy changed in final probe bypasses old compile cache and produces no ticket", async () => {
	const result = await scenario(denyTargetWithoutCacheInvalidation);
	expect(result.signatures).toBe(0);
});

test("real narrator ACL grant revoked in final probe cannot borrow earlier read approval", async () => {
	await db.update(users).set({ role: "user" }).where(eq(users.id, userId));
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: narratorId,
		principalType: "user",
		principalId: userId,
		capability: "read",
		grantedBy: ownerId,
		createdAt: new Date().toISOString(),
	});
	const result = await scenario(async () => {
		await db.delete(aclGrants).where(eq(aclGrants.scopeId, narratorId));
	});
	expect(result.signatures).toBe(0);
});

test("original JWT expiry during final probe cannot use a renewed request timestamp", async () => {
	const actualNow = Date.now;
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
		const result = await scenario(async () => {
			Date.now = () => payload.exp * 1000 + 1;
		});
		expect(result.signatures).toBe(0);
	} finally {
		Date.now = actualNow;
	}
});

for (const late of ["token-version", "policy"] as const) {
	test(`last policy compilation await changes ${late}: synchronous tail rejects before signer`, async () => {
		const result = await scenario(
			async () => {},
			false,
			async () => {
				if (late === "policy") await denyTargetWithoutCacheInvalidation();
				else await db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, userId));
			},
		);
		expect(result.signatures).toBe(0);
	});
}
