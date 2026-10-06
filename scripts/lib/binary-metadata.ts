/**
 * Binary metadata helpers for the release/build pipeline.
 *
 * Produces verifiable sidecar metadata (per-binary JSON) and aggregate
 * checksum files (SHA256SUMS + human-readable report). Publishing verifiable
 * hashes and clear provenance for each platform binary helps users confirm a
 * download is authentic and reduces the chance an unknown-origin executable is
 * treated as suspicious by antivirus / SmartScreen heuristics.
 *
 * Pure functions only (aside from the single readFileSync in
 * `computeBinaryMetadata`) so the formatting logic is unit-testable.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface BinaryMetadata {
	/** Binary filename (basename), e.g. "narrafork-0.5.0-linux-x64". */
	name: string;
	/** Update-server platform id, e.g. "linux-x64", "win-x64-baseline". */
	platform: string;
	/** Bun compile target, e.g. "bun-linux-x64". */
	target: string;
	/** Release version, e.g. "0.5.0". */
	version: string;
	/** Short git commit hash, or empty string when unavailable. */
	commit: string;
	/** ISO-8601 build timestamp. */
	buildDate: string;
	/** File size in bytes. */
	size: number;
	/** SHA-256 digest, lowercase hex (pairs with SHA256SUMS / `sha256sum -c`). */
	sha256: string;
	/** SHA-512 digest, base64 (matches the format used in latest*.yml). */
	sha512: string;
}

export interface ComputeMetadataInput {
	version: string;
	platformId: string;
	target: string;
	commit: string;
	buildDate: string;
}

/**
 * Compute verifiable metadata for a single binary. Reads the file once and
 * derives both digests from the same buffer.
 */
export function computeBinaryMetadata(
	filePath: string,
	input: ComputeMetadataInput,
): BinaryMetadata {
	const buf = readFileSync(filePath);
	return computeBinaryMetadataFromBuffer(basename(filePath), buf, input);
}

/**
 * Buffer-based variant of {@link computeBinaryMetadata}, useful for testing
 * without touching the filesystem.
 */
export function computeBinaryMetadataFromBuffer(
	name: string,
	buf: Uint8Array,
	input: ComputeMetadataInput,
): BinaryMetadata {
	const sha256 = createHash("sha256").update(buf).digest("hex");
	const sha512 = createHash("sha512").update(buf).digest("base64");
	return {
		name,
		platform: input.platformId,
		target: input.target,
		version: input.version,
		commit: input.commit,
		buildDate: input.buildDate,
		size: buf.length,
		sha256,
		sha512,
	};
}

/** Serialize metadata to the sidecar `<name>.metadata.json` content. */
export function formatMetadataJson(meta: BinaryMetadata): string {
	return `${JSON.stringify(meta, null, 2)}\n`;
}

/**
 * Produce a standard `SHA256SUMS` file body compatible with `sha256sum -c`.
 * Format: `<hex>␠␠<filename>` per line, sorted by filename for stable output.
 * The double space marks the file as binary (GNU coreutils convention).
 */
export function formatSha256Sums(entries: ReadonlyArray<BinaryMetadata>): string {
	return `${[...entries]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((e) => `${e.sha256}  ${e.name}`)
		.join("\n")}\n`;
}

/**
 * Produce a human-readable checksums report listing provenance and both
 * digests for every platform binary.
 */
export function formatChecksumsReport(
	version: string,
	entries: ReadonlyArray<BinaryMetadata>,
): string {
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const commit = sorted.find((e) => e.commit)?.commit ?? "";
	const buildDate = sorted[0]?.buildDate ?? "";
	const lines: string[] = [];
	lines.push(`NarraFork v${version} — binary checksums`);
	if (commit) lines.push(`Commit:     ${commit}`);
	if (buildDate) lines.push(`Build date: ${buildDate}`);
	lines.push("");
	lines.push(`Verify a download with:  sha256sum -c narrafork-${version}-SHA256SUMS`);
	lines.push("");
	for (const e of sorted) {
		lines.push(e.name);
		lines.push(`  platform : ${e.platform}`);
		lines.push(`  size     : ${e.size} bytes`);
		lines.push(`  sha256   : ${e.sha256}`);
		lines.push(`  sha512   : ${e.sha512}`);
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
