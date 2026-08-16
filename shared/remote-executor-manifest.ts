/**
 * Remote executor manifest validation.
 *
 * Lives in shared/ because both the publisher (release script) and every
 * consumer (server, and by extension the settings UI) must agree on the exact
 * shape and the rules for trusting it. Deliberately free of node built-ins so it
 * can be imported from any runtime.
 */
import {
	EXECUTOR_PLATFORMS,
	type ExecutorManifest,
	type ExecutorPlatform,
	type ExecutorPlatformArtifact,
	executorPublishedFilename,
} from "./remote-executor";

/** Semver with an optional prerelease/build suffix, matching the release script. */
export const EXECUTOR_VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/;

export class ExecutorManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutorManifestError";
	}
}

/**
 * Parse and validate a manifest fetched from the update server.
 *
 * Every field is checked because the payload arrives over the network: the
 * filename must be exactly what this version would have published (so a stale or
 * attacker-chosen artifact cannot be fetched under a trusted version), and the
 * digest must be lowercase hex so comparisons never fail on case alone.
 */
export function parseExecutorManifest(raw: unknown): ExecutorManifest {
	if (typeof raw !== "object" || raw === null) {
		throw new ExecutorManifestError("Manifest is not an object");
	}
	const candidate = raw as Record<string, unknown>;
	const version = candidate.version;
	const protocolVersion = candidate.protocolVersion;
	const releasedAt = candidate.releasedAt;
	const platformsValue = candidate.platforms;
	if (typeof version !== "string" || !EXECUTOR_VERSION_RE.test(version)) {
		throw new ExecutorManifestError(`Manifest has an invalid version: ${String(version)}`);
	}
	if (!Number.isInteger(protocolVersion) || (protocolVersion as number) < 1) {
		throw new ExecutorManifestError(
			`Manifest has an invalid protocolVersion: ${String(protocolVersion)}`,
		);
	}
	if (typeof releasedAt !== "string" || Number.isNaN(Date.parse(releasedAt))) {
		throw new ExecutorManifestError(`Manifest has an invalid releasedAt: ${String(releasedAt)}`);
	}
	if (typeof platformsValue !== "object" || platformsValue === null) {
		throw new ExecutorManifestError("Manifest platforms is not an object");
	}

	const platforms: Partial<Record<ExecutorPlatform, ExecutorPlatformArtifact>> = {};
	for (const platform of EXECUTOR_PLATFORMS) {
		const entry = (platformsValue as Record<string, unknown>)[platform];
		if (entry === undefined) continue;
		if (typeof entry !== "object" || entry === null) {
			throw new ExecutorManifestError(`Manifest entry for ${platform} is not an object`);
		}
		const record = entry as Record<string, unknown>;
		const filename = record.filename;
		const size = record.size;
		const sha256 = record.sha256;
		if (typeof filename !== "string" || filename !== executorPublishedFilename(version, platform)) {
			throw new ExecutorManifestError(
				`Manifest entry for ${platform} has an unexpected filename: ${String(filename)}`,
			);
		}
		if (!Number.isInteger(size) || (size as number) <= 0) {
			throw new ExecutorManifestError(
				`Manifest entry for ${platform} has an invalid size: ${String(size)}`,
			);
		}
		if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
			throw new ExecutorManifestError(
				`Manifest entry for ${platform} has an invalid sha256: ${String(sha256)}`,
			);
		}
		platforms[platform] = { filename, size: size as number, sha256 };
	}

	if (Object.keys(platforms).length === 0) {
		throw new ExecutorManifestError("Manifest lists no usable platforms");
	}

	return {
		version,
		protocolVersion: protocolVersion as number,
		releasedAt,
		platforms,
	};
}
