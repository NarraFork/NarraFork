const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

/** Publisher and updater must agree on valid tags; numeric prereleases cannot have leading zeros. */
export function isValidReleaseVersion(version: string): boolean {
	// Public release JSON is untrusted. Bound numeric parsing and asset filename growth.
	if (typeof version !== "string" || version.length > 128) return false;
	const match = SEMVER_RE.exec(version);
	return !!match && !(match[4]?.split(".").some((part) => /^0\d+$/.test(part)) ?? false);
}

/** SemVer precedence without floating-point loss or locale-dependent identifier ordering. */
export function compareReleaseVersions(a: string, b: string): number {
	const left = SEMVER_RE.exec(a);
	const right = SEMVER_RE.exec(b);
	if (!left || !right || !isValidReleaseVersion(a) || !isValidReleaseVersion(b)) {
		throw new Error("Invalid release version");
	}
	for (let i = 1; i <= 3; i++) {
		const x = BigInt(left[i] ?? "0");
		const y = BigInt(right[i] ?? "0");
		if (x !== y) return x > y ? 1 : -1;
	}
	if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0;
	const x = left[4].split(".");
	const y = right[4].split(".");
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if (x[i] === undefined) return -1;
		if (y[i] === undefined) return 1;
		const p = x[i] ?? "";
		const q = y[i] ?? "";
		if (p === q) continue;
		const pNumeric = /^\d+$/.test(p);
		const qNumeric = /^\d+$/.test(q);
		if (pNumeric && qNumeric) return BigInt(p) > BigInt(q) ? 1 : -1;
		if (pNumeric !== qNumeric) return pNumeric ? -1 : 1;
		return p > q ? 1 : -1;
	}
	return 0;
}
