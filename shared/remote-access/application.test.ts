import { describe, expect, test } from "bun:test";
import {
	parseRemoteBackendIdentity,
	parseRemoteFrontendCapability,
	REMOTE_FRONTEND_CAPABILITY,
	type RemoteBackendIdentity,
	remoteFrontendCompatibilityKey,
	sameRemoteBackendIdentity,
} from "./application";
import {
	encodeRemoteIpcEnvelope,
	parseRemoteIpcEnvelope,
	parseRemoteIpcLine,
	parseRemoteSessionProjection,
	REMOTE_IPC_MAX_LINE_BYTES,
	type RemoteIpcEnvelope,
} from "./ipc";

const identity: RemoteBackendIdentity = {
	nfVersion: "0.9.12",
	sourceCommit: "6007ca13581cd1f3db8756f28fa5e53f22bd148c",
	repository: "NarraFork/NarraFork",
	bootstrapAbi: 1,
	apiEpoch: 1,
	wireVersion: 2,
	capabilities: ["projects", "narrators", "approvals"],
};

describe("production remote application identity", () => {
	test("the checked-in declaration is an exact-release remote target", () => {
		expect(parseRemoteFrontendCapability(REMOTE_FRONTEND_CAPABILITY)).toEqual({
			schemaVersion: 1,
			buildMode: "remote",
			bootstrapAbi: 1,
			apiEpoch: 1,
			wireVersion: 2,
			compatibility: "exact-release",
		});
	});

	test("rejects deployment identity, incomplete and unknown declarations", () => {
		for (const value of [
			null,
			{},
			{ ...REMOTE_FRONTEND_CAPABILITY, host: "https://elsewhere.invalid" },
			{ ...REMOTE_FRONTEND_CAPABILITY, compatibility: "latest" },
			{ ...REMOTE_FRONTEND_CAPABILITY, wireVersion: 1 },
			{ ...REMOTE_FRONTEND_CAPABILITY, bootstrapAbi: 2 },
		])
			expect(() => parseRemoteFrontendCapability(value)).toThrow();
	});

	test("never substitutes the peer version or semver-nearest frontend", () => {
		const key = remoteFrontendCompatibilityKey(identity);
		expect(key).toBe("NarraFork/NarraFork:0.9.12:1:1:2");
		expect(remoteFrontendCompatibilityKey({ ...identity, nfVersion: "0.9.13" })).not.toBe(key);
		expect(remoteFrontendCompatibilityKey({ ...identity, repository: "fork/nf" })).not.toBe(key);
		expect(() =>
			parseRemoteBackendIdentity({ ...identity, peerVersion: "0.2.0-alpha.1" }),
		).toThrow();
	});

	test("rejects fixture identity, unsupported wire, unsafe fields and duplicate capabilities", () => {
		for (const value of [
			{ ...identity, nfVersion: "prototype-1" },
			{ ...identity, sourceCommit: "main" },
			{ ...identity, repository: "../../other" },
			{ ...identity, wireVersion: 1 },
			{ ...identity, apiEpoch: 2 },
			{ ...identity, capabilities: ["projects", "projects"] },
			{ ...identity, capabilities: ["arbitrary-proxy"] },
		])
			expect(() => parseRemoteBackendIdentity(value)).toThrow();
	});

	test("clones capabilities and binds reconnects to the original backend", () => {
		const parsed = parseRemoteBackendIdentity(identity);
		parsed.capabilities.push("sse");
		expect(identity.capabilities).not.toContain("sse");
		expect(
			sameRemoteBackendIdentity(identity, {
				...identity,
				capabilities: [...identity.capabilities].reverse(),
			}),
		).toBe(true);
		expect(sameRemoteBackendIdentity(identity, { ...identity, sourceCommit: "abcdef0" })).toBe(
			false,
		);
		expect(sameRemoteBackendIdentity(identity, parsed)).toBe(false);
	});
});

describe("private remote IPC contract", () => {
	const message: RemoteIpcEnvelope = {
		ipcVersion: 2,
		epoch: "runtime_epoch_1",
		requestId: "request_1",
		type: "pair.create",
		payload: {},
	};

	test("round-trips an explicitly versioned and correlated envelope", () => {
		const encoded = encodeRemoteIpcEnvelope(message);
		expect(encoded.endsWith("\n")).toBe(true);
		expect(parseRemoteIpcLine(encoded)).toEqual(message);
	});

	test("rejects wrong versions, missing identity and unrecognised commands", () => {
		for (const value of [
			{ ...message, ipcVersion: 1 },
			{ ...message, epoch: "" },
			{ ...message, requestId: "bad\nrequest" },
			{ ...message, type: "exec" },
			{ ...message, payload: [] },
			{ ...message, token: "not-an-envelope-field" },
		])
			expect(() => parseRemoteIpcEnvelope(value)).toThrow();
	});

	test("bounds both decoded lines and encoded output", () => {
		expect(() => parseRemoteIpcLine("x".repeat(REMOTE_IPC_MAX_LINE_BYTES + 1))).toThrow(
			"TOO_LARGE",
		);
		expect(() =>
			encodeRemoteIpcEnvelope({
				...message,
				payload: { value: "x".repeat(REMOTE_IPC_MAX_LINE_BYTES) },
			}),
		).toThrow("TOO_LARGE");
	});

	test("session projection contains no token and only authorises administrators", () => {
		const session = {
			sessionId: "session1",
			userId: "user1",
			role: "admin" as const,
			expiresAt: 1_800_000_000,
			authRevision: 0,
		};
		expect(parseRemoteSessionProjection(session)).toEqual(session);
		for (const value of [
			{ ...session, role: "user" },
			{ ...session, expiresAt: 0 },
			{ ...session, authRevision: -1 },
			{ ...session, token: "nfs_secret" },
		])
			expect(() => parseRemoteSessionProjection(value)).toThrow();
	});
});
