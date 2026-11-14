import { isValidGitHubRepository } from "./github-repository";
import { isValidReleaseVersion } from "./release-version";
import {
	REMOTE_PEER_BINARY_MAX_BYTES,
	REMOTE_PEER_LICENSE_FILES,
	REMOTE_PEER_MANIFEST_MAX_BYTES,
	REMOTE_PEER_PLATFORMS,
	type RemotePeerDistribution,
	type RemotePeerManifest,
	type RemotePeerPlatform,
	type RemotePeerPlatformArtifact,
	type RemotePeerReleaseManifest,
	remotePeerPublishedFilename,
} from "./remote-peer";

export const REMOTE_PEER_VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
export class RemotePeerManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemotePeerManifestError";
	}
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new RemotePeerManifestError("Expected remote peer manifest object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key)))
		throw new RemotePeerManifestError("Unexpected remote peer manifest field");
	return record;
}
function bounded(value: unknown): void {
	const text = JSON.stringify(value);
	if (
		typeof text !== "string" ||
		new TextEncoder().encode(text).byteLength > REMOTE_PEER_MANIFEST_MAX_BYTES
	)
		throw new RemotePeerManifestError("Remote peer manifest exceeds size limit");
}
function version(value: unknown): string {
	if (
		typeof value !== "string" ||
		!REMOTE_PEER_VERSION_RE.test(value) ||
		!isValidReleaseVersion(value) ||
		value.length > 64
	)
		throw new RemotePeerManifestError("Invalid remote peer version");
	return value;
}
/** Shared by publication and mirror ingress; preserve case-sensitive prerelease identifiers. */
export function parseRemotePeerReleaseTag(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("remote-peer-v"))
		throw new RemotePeerManifestError("Invalid remote peer release tag");
	return version(value.slice("remote-peer-v".length));
}
function protocol(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2 ** 31 - 1)
		throw new RemotePeerManifestError("Invalid remote peer protocol version");
	return value as number;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
		throw new RemotePeerManifestError("Invalid remote peer SHA-256");
	return value;
}
function size(value: unknown, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max)
		throw new RemotePeerManifestError("Invalid remote peer asset size");
	return value as number;
}
export function parseRemotePeerDistribution(value: unknown): RemotePeerDistribution {
	const record = object(value, ["version", "protocolVersion", "tag"]);
	const v = version(record.version);
	if (record.tag !== `remote-peer-v${v}`)
		throw new RemotePeerManifestError("Remote peer tag does not match version");
	return { version: v, protocolVersion: protocol(record.protocolVersion), tag: record.tag };
}
/** Source-side builders can validate subsets; published envelopes require every platform. */
export function parseRemotePeerManifest(value: unknown): RemotePeerManifest {
	bounded(value);
	const record = object(value, ["version", "protocolVersion", "releasedAt", "platforms"]);
	const v = version(record.version);
	if (
		typeof record.releasedAt !== "string" ||
		record.releasedAt.length > 40 ||
		!Number.isFinite(Date.parse(record.releasedAt))
	)
		throw new RemotePeerManifestError("Invalid remote peer release timestamp");
	const entries = object(record.platforms, REMOTE_PEER_PLATFORMS);
	const platforms: Partial<Record<RemotePeerPlatform, RemotePeerPlatformArtifact>> = {};
	for (const platform of REMOTE_PEER_PLATFORMS) {
		if (!Object.hasOwn(entries, platform)) continue;
		const artifact = object(entries[platform], ["filename", "size", "sha256"]);
		if (artifact.filename !== remotePeerPublishedFilename(v, platform))
			throw new RemotePeerManifestError("Remote peer artifact filename mismatch");
		platforms[platform] = {
			filename: artifact.filename,
			size: size(artifact.size, REMOTE_PEER_BINARY_MAX_BYTES),
			sha256: digest(artifact.sha256),
		};
	}
	if (Object.keys(platforms).length === 0)
		throw new RemotePeerManifestError("Remote peer manifest has no platforms");
	return {
		version: v,
		protocolVersion: protocol(record.protocolVersion),
		releasedAt: record.releasedAt,
		platforms,
	};
}
export interface ExpectedRemotePeerRelease {
	repository: string;
	tag?: string;
	commit?: string;
	version: string;
	protocolVersion: number;
}
export function parseRemotePeerReleaseManifest(
	value: unknown,
	expected: ExpectedRemotePeerRelease,
): RemotePeerReleaseManifest {
	bounded(value);
	const record = object(value, [
		"schemaVersion",
		"repository",
		"tag",
		"commit",
		"manifest",
		"licenses",
	]);
	const manifest = parseRemotePeerManifest(record.manifest);
	if (
		record.schemaVersion !== 1 ||
		typeof record.repository !== "string" ||
		!isValidGitHubRepository(record.repository) ||
		!isValidGitHubRepository(expected.repository) ||
		record.repository.toLowerCase() !== expected.repository.toLowerCase() ||
		typeof record.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(record.commit) ||
		(expected.commit !== undefined && record.commit !== expected.commit) ||
		manifest.version !== expected.version ||
		manifest.protocolVersion !== expected.protocolVersion ||
		record.tag !== `remote-peer-v${manifest.version}` ||
		(expected.tag !== undefined && record.tag !== expected.tag)
	)
		throw new RemotePeerManifestError("Remote peer release identity mismatch");
	if (REMOTE_PEER_PLATFORMS.some((platform) => !manifest.platforms[platform]))
		throw new RemotePeerManifestError("Remote peer release requires all platforms");
	if (
		!Array.isArray(record.licenses) ||
		record.licenses.length !== REMOTE_PEER_LICENSE_FILES.length
	)
		throw new RemotePeerManifestError("Incomplete remote peer license materials");
	const seen = new Set<string>();
	const licenses = record.licenses.map((value) => {
		const item = object(value, ["name", "size", "sha256"]);
		if (
			typeof item.name !== "string" ||
			!(REMOTE_PEER_LICENSE_FILES as readonly string[]).includes(item.name) ||
			seen.has(item.name)
		)
			throw new RemotePeerManifestError("Unexpected or duplicate remote peer license");
		seen.add(item.name);
		return {
			name: item.name,
			size: size(item.size, REMOTE_PEER_MANIFEST_MAX_BYTES),
			sha256: digest(item.sha256),
		};
	});
	return {
		schemaVersion: 1,
		repository: record.repository,
		tag: record.tag,
		commit: record.commit,
		manifest,
		licenses,
	};
}
