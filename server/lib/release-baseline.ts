import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9._-]+))?$/;

export interface PreviousVersionBinary {
	path: string;
	version: string;
}

export interface FileIdentity {
	size: number;
	sha512: string;
}

export interface PublishedFileIdentity extends FileIdentity {
	filename: string;
}

export interface PublishedBaselineCandidate {
	version: string;
	file: PublishedFileIdentity;
	channel?: "stable" | "beta";
}

export class PublishedBaselineError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PublishedBaselineError";
	}
}

interface ParsedReleaseVersion {
	core: [number, number, number];
	prerelease?: string[];
}

function parseReleaseVersion(version: string): ParsedReleaseVersion | null {
	const match = RELEASE_VERSION_RE.exec(version);
	if (!match) return null;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4]?.split("."),
	};
}

function comparePrerelease(left: string[] | undefined, right: string[] | undefined): number {
	if (!left && !right) return 0;
	if (!left) return 1;
	if (!right) return -1;
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const leftPart = left[index];
		const rightPart = right[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;
		const leftNumeric = /^\d+$/.test(leftPart);
		const rightNumeric = /^\d+$/.test(rightPart);
		if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return leftPart.localeCompare(rightPart);
	}
	return 0;
}

export function compareReleaseVersions(left: string, right: string): number {
	const parsedLeft = parseReleaseVersion(left);
	const parsedRight = parseReleaseVersion(right);
	if (!parsedLeft || !parsedRight) {
		throw new PublishedBaselineError(`Cannot compare invalid release versions: ${left}, ${right}`);
	}
	for (let index = 0; index < 3; index += 1) {
		const difference = parsedLeft.core[index] - parsedRight.core[index];
		if (difference !== 0) return difference;
	}
	return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function isValidPublishedCandidate(candidate: PublishedBaselineCandidate): boolean {
	return (
		parseReleaseVersion(candidate.version) !== null &&
		typeof candidate.file.filename === "string" &&
		candidate.file.filename.length > 0 &&
		Number.isSafeInteger(candidate.file.size) &&
		candidate.file.size > 0 &&
		typeof candidate.file.sha512 === "string" &&
		candidate.file.sha512.length > 0
	);
}

/** Selects the highest valid published platform release strictly below the target. */
export function selectPublishedBaseline(
	targetVersion: string,
	candidates: readonly PublishedBaselineCandidate[],
): PublishedBaselineCandidate | null {
	if (!parseReleaseVersion(targetVersion)) {
		throw new PublishedBaselineError(`Invalid target release version: ${targetVersion}`);
	}
	return (
		candidates
			.filter(isValidPublishedCandidate)
			.filter((candidate) => compareReleaseVersions(candidate.version, targetVersion) < 0)
			.sort((left, right) => compareReleaseVersions(right.version, left.version))[0] ?? null
	);
}

/**
 * Resolves the exact local file required by the published baseline. This helper is
 * pure: callers provide the dist filenames discovered from their checkout.
 */
export function requirePublishedBaseline(
	targetVersion: string,
	currentFilename: string,
	candidates: readonly PublishedBaselineCandidate[],
	availableFilenames: readonly string[],
): PublishedBaselineCandidate | null {
	const baseline = selectPublishedBaseline(targetVersion, candidates);
	if (!baseline) return null;
	const currentPrefix = `narrafork-${targetVersion}-`;
	if (!currentFilename.startsWith(currentPrefix)) {
		throw new PublishedBaselineError(
			`Current artifact filename does not match target v${targetVersion}: ${currentFilename}`,
		);
	}
	const suffix = currentFilename.slice(currentPrefix.length);
	const requiredFilename = `narrafork-${baseline.version}-${suffix}`;
	if (baseline.file.filename !== requiredFilename) {
		throw new PublishedBaselineError(
			`Published baseline filename mismatch for v${baseline.version}: expected ${requiredFilename}, received ${baseline.file.filename}`,
		);
	}
	if (!availableFilenames.includes(requiredFilename)) {
		throw new PublishedBaselineError(
			`Published baseline v${baseline.version} requires ${requiredFilename}, but that exact file is missing from dist`,
		);
	}
	return baseline;
}

/** Legacy local candidate helper retained for callers outside the release gate. */
export function findPreviousVersionBinary(
	distDir: string,
	currentName: string,
	currentVersion: string,
): PreviousVersionBinary | null {
	const versionedPrefix = `narrafork-${currentVersion}-`;
	if (!currentName.startsWith(versionedPrefix)) return null;
	const platformSuffix = currentName.slice(versionedPrefix.length);
	const escapedSuffix = platformSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^narrafork-(\\d+\\.\\d+\\.\\d+)-${escapedSuffix}$`);
	const candidates: PreviousVersionBinary[] = [];

	let names: string[];
	try {
		names = readdirSync(distDir);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return null;
		}
		throw error;
	}

	for (const name of names) {
		const match = name.match(pattern);
		if (!match || match[1] === currentVersion) continue;
		if (compareReleaseVersions(match[1], currentVersion) >= 0) continue;
		candidates.push({ version: match[1], path: join(distDir, name) });
	}

	candidates.sort((left, right) => compareReleaseVersions(right.version, left.version));
	return candidates[0] ?? null;
}

export function computeFileIdentity(filePath: string): FileIdentity {
	const buffer = readFileSync(filePath);
	return {
		size: statSync(filePath).size,
		sha512: createHash("sha512").update(buffer).digest("base64"),
	};
}

export function getBaselineMismatch(
	actual: FileIdentity,
	expected: PublishedFileIdentity,
): string | null {
	if (actual.size === expected.size && actual.sha512 === expected.sha512) return null;
	return [
		`published file: ${expected.filename}`,
		`expected size: ${expected.size}`,
		`actual size: ${actual.size}`,
		`expected sha512: ${expected.sha512}`,
		`actual sha512: ${actual.sha512}`,
	].join("\n");
}
