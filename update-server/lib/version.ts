/**
 * Version comparison utilities.
 */

/**
 * Parse a semver-like version string into numeric parts.
 */
function parseParts(version: string): number[] {
	return version.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

/**
 * Returns true if version `a` is newer than version `b`.
 */
export function isNewerVersion(a: string, b: string): boolean {
	const partsA = parseParts(a);
	const partsB = parseParts(b);

	for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
		const numA = partsA[i] ?? 0;
		const numB = partsB[i] ?? 0;
		if (numA > numB) return true;
		if (numA < numB) return false;
	}
	return false;
}

/**
 * Compare two version strings.
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const partsA = parseParts(a);
	const partsB = parseParts(b);

	for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
		const numA = partsA[i] ?? 0;
		const numB = partsB[i] ?? 0;
		if (numA > numB) return 1;
		if (numA < numB) return -1;
	}
	return 0;
}
