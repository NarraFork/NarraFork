import { isValidGitHubRepository } from "./github-repository";
import {
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	parseReleasePatchName,
} from "./release-patch";
import { compareReleaseVersions, isValidReleaseVersion } from "./release-version";
import {
	MAX_UPDATE_INDEX_BYTES,
	MAX_UPDATE_INDEX_RELEASE_BYTES,
	MAX_UPDATE_INDEX_RELEASES,
	MAX_UPDATE_NOTES_BYTES,
	UPDATE_INDEX_PLATFORMS,
	type UpdateIndexAsset,
	type UpdateIndexRelease,
	type UpdateIndexV1,
	type UpdateNotesV1,
} from "./update-index-types";

export * from "./update-index-types";

const encoder = new TextEncoder();
export function updateJsonBytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Invalid update index: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
	check(value && typeof value === "object" && !Array.isArray(value), "object required");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
	check(
		Object.keys(value).every((key) => allowed.includes(key)),
		"unknown field",
	);
}
function size(value: unknown, maximum: number): asserts value is number {
	check(
		typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum,
		"size limit",
	);
}
function date(value: unknown): asserts value is string {
	check(
		typeof value === "string" &&
			value.length <= 32 &&
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
			Number.isFinite(Date.parse(value)),
		"timestamp",
	);
	const canonical = value.replace(
		/(?:\.(\d{1,3}))?Z$/,
		(_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
	);
	check(new Date(value).toISOString() === canonical, "timestamp calendar date");
}
function sha256(value: unknown): asserts value is string {
	check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "SHA256");
}
function version(value: unknown): asserts value is string {
	check(typeof value === "string" && isValidReleaseVersion(value), "version");
}
function repository(value: unknown, expected: string): asserts value is string {
	check(
		isValidGitHubRepository(value) &&
			isValidGitHubRepository(expected) &&
			value.toLowerCase() === expected.toLowerCase(),
		"repository mismatch",
	);
}
function asset(value: unknown, name: string, maximum: number): UpdateIndexAsset {
	const a = object(value);
	keys(a, ["name", "size", "sha256"]);
	check(a.name === name, "canonical asset name");
	size(a.size, maximum);
	sha256(a.sha256);
	return { name, size: a.size, sha256: a.sha256 };
}
export function parseUpdateIndexRelease(value: unknown): UpdateIndexRelease {
	check(updateJsonBytes(value) <= MAX_UPDATE_INDEX_RELEASE_BYTES, "release byte limit");
	const r = object(value);
	keys(r, ["version", "tag", "commit", "prerelease", "publishedAt", "notes", "files"]);
	version(r.version);
	check(r.tag === `v${r.version}`, "tag");
	check(typeof r.commit === "string" && /^[a-f0-9]{40}$/.test(r.commit), "commit");
	check(typeof r.prerelease === "boolean", "prerelease");
	date(r.publishedAt);
	check(Array.isArray(r.files) && r.files.length > 0 && r.files.length <= 8, "platform count");
	const platforms = new Set<string>();
	let pairs = 0;
	const files = r.files
		.map((value) => {
			const f = object(value);
			keys(f, ["name", "size", "sha256", "platform", "sha512", "metadata", "patches"]);
			check(
				typeof f.platform === "string" && Object.hasOwn(UPDATE_INDEX_PLATFORMS, f.platform),
				"platform",
			);
			check(!platforms.has(f.platform), "duplicate platform");
			platforms.add(f.platform);
			const name = `narrafork-${r.version}-${UPDATE_INDEX_PLATFORMS[f.platform]}`;
			const binary = asset(
				{ name: f.name, size: f.size, sha256: f.sha256 },
				name,
				MAX_RELEASE_BINARY_BYTES,
			);
			check(
				typeof f.sha512 === "string" && /^[A-Za-z0-9+/]{85}[AQgw]==$/.test(f.sha512),
				"SHA512 base64",
			);
			check(Array.isArray(f.patches), "patch array");
			pairs += f.patches.length;
			check(pairs <= 64, "patch pair count");
			const names = new Set<string>();
			const patches = f.patches
				.map((value) => {
					const p = object(value);
					keys(p, ["name", "size", "sha256", "fromVersion", "metadata"]);
					version(p.fromVersion);
					check(compareReleaseVersions(p.fromVersion, r.version as string) < 0, "patch direction");
					check(typeof p.name === "string", "patch name");
					const parsed = parseReleasePatchName(name, p.name);
					check(
						parsed && (!parsed.fromVersion || parsed.fromVersion === p.fromVersion),
						"patch name/version",
					);
					check(!names.has(p.name), "duplicate patch");
					names.add(p.name);
					return {
						...asset(
							{ name: p.name, size: p.size, sha256: p.sha256 },
							p.name,
							MAX_RELEASE_PATCH_BYTES,
						),
						fromVersion: p.fromVersion,
						metadata: asset(p.metadata, `${p.name}.meta.json`, 64 * 1024),
					};
				})
				.sort((a, b) => a.name.localeCompare(b.name));
			return {
				...binary,
				platform: f.platform,
				sha512: f.sha512,
				metadata: asset(f.metadata, `${name}.metadata.json`, 64 * 1024),
				patches,
			};
		})
		.sort((a, b) => a.platform.localeCompare(b.platform));
	let notes: UpdateIndexRelease["notes"];
	if (r.notes !== undefined) {
		const n = object(r.notes);
		keys(n, ["path", "size", "sha256"]);
		sha256(n.sha256);
		size(n.size, MAX_UPDATE_NOTES_BYTES);
		check(n.path === `notes/${r.version}-${n.sha256}.json`, "notes path");
		notes = { path: n.path, size: n.size, sha256: n.sha256 };
	}
	return {
		version: r.version,
		tag: r.tag as string,
		commit: r.commit,
		prerelease: r.prerelease,
		publishedAt: r.publishedAt,
		...(notes ? { notes } : {}),
		files,
	};
}
function precedence(a: UpdateIndexRelease, b: UpdateIndexRelease) {
	return (
		compareReleaseVersions(b.version, a.version) ||
		(a.version < b.version ? 1 : a.version > b.version ? -1 : 0)
	);
}
function channels(releases: UpdateIndexRelease[]): UpdateIndexV1["channels"] {
	const sorted = [...releases].sort(precedence);
	return {
		stable: sorted.find((r) => !r.prerelease)?.version ?? null,
		beta: sorted[0]?.version ?? null,
	};
}
export function parseUpdateIndex(value: unknown, expectedRepository: string): UpdateIndexV1 {
	check(updateJsonBytes(value) <= MAX_UPDATE_INDEX_BYTES, "root byte limit");
	const root = object(value);
	keys(root, ["schemaVersion", "repository", "generation", "generatedAt", "channels", "releases"]);
	check(root.schemaVersion === 1, "schema version");
	repository(root.repository, expectedRepository);
	size(root.generation, Number.MAX_SAFE_INTEGER);
	date(root.generatedAt);
	check(
		Array.isArray(root.releases) &&
			root.releases.length > 0 &&
			root.releases.length <= MAX_UPDATE_INDEX_RELEASES,
		"release count",
	);
	const releases = root.releases.map(parseUpdateIndexRelease).sort(precedence);
	check(new Set(releases.map((r) => r.version)).size === releases.length, "duplicate version");
	const actual = object(root.channels);
	keys(actual, ["stable", "beta"]);
	const expected = channels(releases);
	check(actual.stable === expected.stable && actual.beta === expected.beta, "channel target");
	return {
		schemaVersion: 1,
		repository: root.repository.toLowerCase(),
		generation: root.generation,
		generatedAt: root.generatedAt,
		channels: expected,
		releases,
	};
}
export function mergeUpdateIndex(
	previous: UpdateIndexV1 | null,
	incoming: UpdateIndexRelease,
	repo: string,
	now = new Date().toISOString(),
): UpdateIndexV1 {
	repository(repo, repo);
	const before = previous && parseUpdateIndex(previous, repo);
	const next = parseUpdateIndexRelease(incoming);
	const existing = before?.releases.find((r) => r.version === next.version);
	if (existing) {
		check(
			existing.commit === next.commit && existing.files.length === next.files.length,
			"immutable release asset identity",
		);
		for (const file of existing.files) {
			const candidate = next.files.find((entry) => entry.platform === file.platform);
			check(candidate, "immutable release asset identity");
			// Bootstrap may advertise full-only. Add verified patches monotonically, never
			// replace a binary/sidecar or withdraw/change a patch already in an index.
			check(
				JSON.stringify({ ...file, patches: [] }) === JSON.stringify({ ...candidate, patches: [] }),
				"immutable release asset identity",
			);
			for (const patch of file.patches) {
				const retained = candidate.patches.find((entry) => entry.name === patch.name);
				check(
					retained && JSON.stringify(retained) === JSON.stringify(patch),
					"immutable release patch identity",
				);
			}
		}
		check(existing.prerelease || !next.prerelease, "stable release cannot be demoted");
		if (JSON.stringify(existing) === JSON.stringify(next)) return before as UpdateIndexV1;
	}
	const releases = [
		...(before?.releases.filter((r) => r.version !== next.version) ?? []),
		next,
	].sort(precedence);
	const targets = channels(releases);
	const mandatory = new Set([targets.stable, targets.beta]);
	const result: UpdateIndexV1 = {
		schemaVersion: 1,
		repository: repo.toLowerCase(),
		generation: (before?.generation ?? 0) + 1,
		generatedAt: now,
		channels: targets,
		releases,
	};
	while (
		releases.length > MAX_UPDATE_INDEX_RELEASES ||
		updateJsonBytes(result) > MAX_UPDATE_INDEX_BYTES
	) {
		const index = releases.findLastIndex((r) => !mandatory.has(r.version));
		check(index >= 0, "mandatory target byte limit");
		releases.splice(index, 1);
	}
	if (
		before &&
		JSON.stringify(before.releases) === JSON.stringify(result.releases) &&
		JSON.stringify(before.channels) === JSON.stringify(result.channels)
	)
		return before;
	return parseUpdateIndex(result, repo);
}
export function parseUpdateNotes(
	value: unknown,
	expectedRepository: string,
	expectedVersion: string,
): UpdateNotesV1 {
	check(updateJsonBytes(value) <= MAX_UPDATE_NOTES_BYTES, "notes byte limit");
	const n = object(value);
	keys(n, ["schemaVersion", "repository", "version", "notes"]);
	check(n.schemaVersion === 1, "notes schema");
	repository(n.repository, expectedRepository);
	version(n.version);
	check(n.version === expectedVersion, "notes version");
	if (typeof n.notes !== "string") {
		const notes = object(n.notes);
		keys(notes, ["en", "zh-CN"]);
		check(typeof notes.en === "string" && typeof notes["zh-CN"] === "string", "notes languages");
	}
	return {
		schemaVersion: 1,
		repository: n.repository.toLowerCase(),
		version: n.version,
		notes: n.notes as UpdateNotesV1["notes"],
	};
}
