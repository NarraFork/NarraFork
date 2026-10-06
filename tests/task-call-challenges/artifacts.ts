import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

const MAX_ARTIFACT_BYTES = 20_000_000;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** New manifests contain portable references, never paths into the author's checkout. */
export function artifactReference(manifestPath: string, artifactPath: string): string {
	const reference = relative(dirname(resolve(manifestPath)), resolve(artifactPath));
	if (!reference || isAbsolute(reference) || reference.split(sep).includes("..")) {
		throw new Error("Experiment artifacts must be inside the manifest directory");
	}
	return reference.split(sep).join("/");
}

/**
 * Old manifests stored absolute paths. Their artifacts were siblings of the manifest;
 * relocate by filename, even if the old checkout still exists. Never fall back to it.
 */
export function resolveArtifactPath(manifestPath: string, reference: string): string {
	if (typeof reference !== "string" || !reference || reference.includes("\0")) {
		throw new Error("Invalid experiment artifact reference");
	}
	const portable = reference.replaceAll("\\", "/");
	const local =
		isAbsolute(reference) || win32.isAbsolute(reference) ? posix.basename(portable) : portable;
	if (!local || local.split("/").some((part) => part === ".." || part === "")) {
		throw new Error("Experiment artifact reference must not escape the manifest directory");
	}
	const directory = dirname(resolve(manifestPath));
	const target = resolve(directory, local);
	artifactReference(manifestPath, target);
	return target;
}

export async function readArtifactJson<T>(path: string): Promise<T> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error(`Experiment artifact is missing: ${path}`);
	if (file.size > MAX_ARTIFACT_BYTES) throw new Error("Experiment artifact exceeds size limit");
	return file.json() as Promise<T>;
}

/** Regrading must never replace a historical analysis or raw result. */
export async function writeNewArtifact(path: string, value: unknown): Promise<void> {
	const json = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(json) > MAX_ARTIFACT_BYTES) {
		throw new Error("Experiment artifact exceeds size limit");
	}
	await writeFile(path, json, { flag: "wx" });
}

export interface FrozenChallengeInput {
	id: string;
	file: string;
	text: string;
	fixtureHash: string;
}

interface FrozenManifest {
	graderHash: string;
	sourceSnapshot: string;
	inputSnapshot: string;
	files: string[];
}

/** A corrected grader may change; the frozen evidence and experimental inputs may not. */
export async function verifyFrozenBaseline(
	manifestPath: string,
	current: readonly FrozenChallengeInput[],
): Promise<{ originalGraderHash: string }> {
	const manifest = await readArtifactJson<FrozenManifest>(manifestPath);
	const source = await readArtifactJson<{ sources: Record<string, string> }>(
		resolveArtifactPath(manifestPath, manifest.sourceSnapshot),
	);
	assert.equal(
		sha256(source.sources["fixtures.ts"]),
		manifest.graderHash,
		"Frozen grader snapshot is corrupt",
	);
	const input = await readArtifactJson<{ challenges: Record<string, string> }>(
		resolveArtifactPath(manifestPath, manifest.inputSnapshot),
	);
	assert(
		Array.isArray(manifest.files) && manifest.files.length <= 256,
		"Invalid frozen result list",
	);
	const fixtureHashes = new Map<string, string>();
	for (const reference of manifest.files) {
		const record = await readArtifactJson<{ challengeId: string; fixtureHash: string }>(
			resolveArtifactPath(manifestPath, reference),
		);
		const previous = fixtureHashes.get(record.challengeId);
		assert(!previous || previous === record.fixtureHash, "Frozen fixture hashes disagree");
		fixtureHashes.set(record.challengeId, record.fixtureHash);
	}
	for (const challenge of current) {
		assert.equal(challenge.text, input.challenges[challenge.file], "Public challenge changed");
		assert.equal(
			challenge.fixtureHash,
			fixtureHashes.get(challenge.id),
			`Initial fixture changed for challenge ${challenge.id}`,
		);
	}
	return { originalGraderHash: manifest.graderHash };
}
