import { isValidGitHubRepository } from "../github-repository";
import { isValidReleaseVersion } from "../release-version";
import declaration from "./frontend-capability.json";

/** Pure build/handshake contracts. No environment, storage or network reads. */
export interface RemoteFrontendCapability {
	schemaVersion: 1;
	buildMode: "remote";
	bootstrapAbi: 1;
	apiEpoch: 1;
	wireVersion: 2;
	compatibility: "exact-release";
}

export const REMOTE_CAPABILITY_NAMES = [
	"projects",
	"narrators",
	"approvals",
	"sse",
	"small-attachments",
	"binary-socket",
] as const;
export type RemoteCapabilityName = (typeof REMOTE_CAPABILITY_NAMES)[number];

/** NF's identity, not the independently released Go component's version. */
export interface RemoteBackendIdentity {
	nfVersion: string;
	sourceCommit: string;
	repository: string;
	bootstrapAbi: number;
	apiEpoch: number;
	wireVersion: number;
	capabilities: RemoteCapabilityName[];
}

export const REMOTE_PRODUCTION_LIMITS = Object.freeze({
	loginTimeoutMs: 10 * 60_000,
	requestTimeoutMs: 30_000,
	headerTimeoutMs: 30_000,
	stallTimeoutMs: 30_000,
	idleTimeoutMs: 60_000,
	streamLifetimeMs: 2 * 60 * 60_000,
	streamBytes: 64 * 1024 * 1024,
	jsonBytes: 1024 * 1024,
	fileBytes: 8 * 1024 * 1024,
	socketMessageBytes: 2 * 1024 * 1024,
	socketAssemblyTimeoutMs: 30_000,
	queueBytes: 4 * 1024 * 1024,
	globalQueueBytes: 32 * 1024 * 1024,
	policyRules: 128,
});

export function remoteContractObject(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("REMOTE_CONTRACT_OBJECT_INVALID");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key)))
		throw new Error("REMOTE_CONTRACT_FIELD_UNKNOWN");
	return record;
}

export function parseRemoteFrontendCapability(value: unknown): RemoteFrontendCapability {
	const record = remoteContractObject(value, [
		"schemaVersion",
		"buildMode",
		"bootstrapAbi",
		"apiEpoch",
		"wireVersion",
		"compatibility",
	]);
	if (
		record.schemaVersion !== 1 ||
		record.buildMode !== "remote" ||
		record.bootstrapAbi !== 1 ||
		record.apiEpoch !== 1 ||
		record.wireVersion !== 2 ||
		record.compatibility !== "exact-release"
	)
		throw new Error("REMOTE_FRONTEND_CAPABILITY_UNSUPPORTED");
	return {
		schemaVersion: 1,
		buildMode: "remote",
		bootstrapAbi: 1,
		apiEpoch: 1,
		wireVersion: 2,
		compatibility: "exact-release",
	};
}

export const REMOTE_FRONTEND_CAPABILITY = Object.freeze(parseRemoteFrontendCapability(declaration));

export function parseRemoteBackendIdentity(value: unknown): RemoteBackendIdentity {
	const record = remoteContractObject(value, [
		"nfVersion",
		"sourceCommit",
		"repository",
		"bootstrapAbi",
		"apiEpoch",
		"wireVersion",
		"capabilities",
	]);
	if (
		typeof record.nfVersion !== "string" ||
		record.nfVersion.length > 64 ||
		!isValidReleaseVersion(record.nfVersion) ||
		typeof record.sourceCommit !== "string" ||
		!/^[a-f0-9]{7,40}$/.test(record.sourceCommit) ||
		typeof record.repository !== "string" ||
		!isValidGitHubRepository(record.repository) ||
		record.bootstrapAbi !== REMOTE_FRONTEND_CAPABILITY.bootstrapAbi ||
		record.apiEpoch !== REMOTE_FRONTEND_CAPABILITY.apiEpoch ||
		record.wireVersion !== REMOTE_FRONTEND_CAPABILITY.wireVersion ||
		!Array.isArray(record.capabilities) ||
		record.capabilities.length > REMOTE_CAPABILITY_NAMES.length ||
		record.capabilities.some(
			(name) => !(REMOTE_CAPABILITY_NAMES as readonly unknown[]).includes(name),
		) ||
		new Set(record.capabilities).size !== record.capabilities.length
	)
		throw new Error("REMOTE_BACKEND_IDENTITY_UNSUPPORTED");
	return {
		nfVersion: record.nfVersion,
		sourceCommit: record.sourceCommit,
		repository: record.repository,
		bootstrapAbi: record.bootstrapAbi,
		apiEpoch: record.apiEpoch,
		wireVersion: record.wireVersion,
		capabilities: [...record.capabilities] as RemoteCapabilityName[],
	};
}

/** Exact-release lookup; origin, peer pin and semver ordering never participate. */
export function remoteFrontendCompatibilityKey(identity: RemoteBackendIdentity): string {
	const parsed = parseRemoteBackendIdentity(identity);
	return `${parsed.repository}:${parsed.nfVersion}:${parsed.bootstrapAbi}:${parsed.apiEpoch}:${parsed.wireVersion}`;
}

/** A reconnect may not silently change the backend under the mounted application. */
export function sameRemoteBackendIdentity(
	left: RemoteBackendIdentity,
	right: RemoteBackendIdentity,
): boolean {
	return (
		remoteFrontendCompatibilityKey(left) === remoteFrontendCompatibilityKey(right) &&
		left.sourceCommit === right.sourceCommit &&
		[...left.capabilities].sort().join(",") === [...right.capabilities].sort().join(",")
	);
}

export type RemoteRequestPhase = "paired" | "ready";
export type RemoteRequestProfile = "request" | "sse";
/** Anchored RE2-compatible patterns, supplied by NF over the trusted initialization pipe. */
export interface RemoteRequestRule {
	id: string;
	methods: string[];
	path: string;
	phase: RemoteRequestPhase;
	profile: RemoteRequestProfile;
	requestBytes: number;
	responseBytes: number;
}
