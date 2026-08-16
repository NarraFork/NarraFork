/**
 * Remote executor release manifest construction.
 *
 * Pure functions only: callers supply the artifact bytes, so the manifest shape
 * and its validation rules stay testable without touching disk or the network.
 * Validation of an already published manifest lives in
 * shared/remote-executor-manifest.ts, which the server imports too.
 */
import { createHash } from "node:crypto";
import {
	EXECUTOR_PLATFORMS,
	type ExecutorManifest,
	type ExecutorPlatform,
	type ExecutorPlatformArtifact,
	executorPublishedFilename,
	isExecutorPlatform,
} from "../../shared/remote-executor";
import { EXECUTOR_VERSION_RE, ExecutorManifestError } from "../../shared/remote-executor-manifest";

export {
	ExecutorManifestError,
	parseExecutorManifest,
} from "../../shared/remote-executor-manifest";

export interface ExecutorArtifactInput {
	platform: ExecutorPlatform;
	/** Raw binary bytes; the digest is computed here so it can never drift. */
	bytes: Uint8Array;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export interface BuildExecutorManifestOptions {
	version: string;
	protocolVersion: number;
	releasedAt: string;
	artifacts: readonly ExecutorArtifactInput[];
}

/**
 * Build a manifest from the artifacts that were actually produced.
 *
 * A partial platform set is allowed (`--platform=` builds one target at a time),
 * but every entry must be a known platform, non-empty, and listed only once.
 */
export function buildExecutorManifest(options: BuildExecutorManifestOptions): ExecutorManifest {
	const { version, protocolVersion, releasedAt, artifacts } = options;
	if (!EXECUTOR_VERSION_RE.test(version)) {
		throw new ExecutorManifestError(`Invalid executor version: ${version}`);
	}
	if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
		throw new ExecutorManifestError(`Invalid protocol version: ${protocolVersion}`);
	}
	if (Number.isNaN(Date.parse(releasedAt))) {
		throw new ExecutorManifestError(`Invalid releasedAt timestamp: ${releasedAt}`);
	}
	if (artifacts.length === 0) {
		throw new ExecutorManifestError("At least one executor artifact is required");
	}

	const platforms: Partial<Record<ExecutorPlatform, ExecutorPlatformArtifact>> = {};
	for (const artifact of artifacts) {
		if (!isExecutorPlatform(artifact.platform)) {
			throw new ExecutorManifestError(`Unknown executor platform: ${artifact.platform}`);
		}
		if (platforms[artifact.platform]) {
			throw new ExecutorManifestError(`Duplicate executor artifact for ${artifact.platform}`);
		}
		if (artifact.bytes.byteLength === 0) {
			throw new ExecutorManifestError(`Executor artifact for ${artifact.platform} is empty`);
		}
		platforms[artifact.platform] = {
			filename: executorPublishedFilename(version, artifact.platform),
			size: artifact.bytes.byteLength,
			sha256: sha256Hex(artifact.bytes),
		};
	}

	// Emit platforms in the canonical order so repeated runs produce identical
	// JSON bytes for the same inputs.
	const ordered: Partial<Record<ExecutorPlatform, ExecutorPlatformArtifact>> = {};
	for (const platform of EXECUTOR_PLATFORMS) {
		const entry = platforms[platform];
		if (entry) ordered[platform] = entry;
	}

	return { version, protocolVersion, releasedAt, platforms: ordered };
}

/** Serialize a manifest for upload (stable key order, trailing newline). */
export function formatExecutorManifest(manifest: ExecutorManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}
