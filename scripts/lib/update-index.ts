import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { isValidGitHubRepository } from "../../shared/github-repository";
import {
	MAX_RELEASE_PATCH_BYTES,
	parseReleasePatchName,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import {
	MAX_UPDATE_NOTES_BYTES,
	parseUpdateIndexRelease,
	parseUpdateNotes,
	UPDATE_INDEX_PLATFORMS,
	type UpdateIndexRelease,
} from "../../shared/update-index";
import { hashReleaseFile, readReleaseText } from "./ci-release-io";
import { releaseChannel } from "./github-release";

export { mergeUpdateIndex } from "../../shared/update-index";

export interface PrepareUpdateIndexOptions {
	distDir: string;
	repository: string;
	version: string;
	commit: string;
	changelog?: string | Record<string, string>;
	platformSuffixes: ReadonlyMap<string, string>;
	publishedAt?: string;
}
export interface PreparedUpdateNotes {
	path: string;
	content: string;
	size: number;
	sha256: string;
}
export function textIdentity(content: string) {
	return {
		size: Buffer.byteLength(content),
		sha256: createHash("sha256").update(content).digest("hex"),
	};
}
async function readSidecar(path: string): Promise<string> {
	const raw = await readReleaseText(path, 64 * 1024);
	const identity = await hashReleaseFile(path, 64 * 1024);
	const encoded = textIdentity(raw);
	if (identity.size !== encoded.size || identity.sha256 !== encoded.sha256)
		throw new Error("Sidecar changed while reading or contains invalid UTF-8");
	return raw;
}
export function prepareUpdateNotes(
	options: Pick<PrepareUpdateIndexOptions, "repository" | "version" | "changelog">,
): PreparedUpdateNotes {
	const notesValue = parseUpdateNotes(
		{
			schemaVersion: 1,
			repository: options.repository,
			version: options.version,
			notes:
				typeof options.changelog === "string"
					? options.changelog
					: { en: options.changelog?.en ?? "", "zh-CN": options.changelog?.["zh-CN"] ?? "" },
		},
		options.repository,
		options.version,
	);
	const content = JSON.stringify(notesValue);
	const identity = textIdentity(content);
	if (identity.size > MAX_UPDATE_NOTES_BYTES) throw new Error("Notes exceed byte limit");
	return { path: `notes/${options.version}-${identity.sha256}.json`, content, ...identity };
}
/** Recheck the actual bytes; build-only previews never make network calls or mutate dist. */
export async function prepareUpdateIndexRelease(
	options: PrepareUpdateIndexOptions,
): Promise<{ release: UpdateIndexRelease; notes: PreparedUpdateNotes }> {
	if (!isValidGitHubRepository(options.repository) || !/^[a-f0-9]{40}$/.test(options.commit))
		throw new Error("Invalid release repository/commit");
	if (options.platformSuffixes.size < 1 || options.platformSuffixes.size > 8)
		throw new Error("Invalid platform count");
	const notes = prepareUpdateNotes(options);
	const binaries = [...options.platformSuffixes].map(([platform, suffix]) => {
		if (
			!Object.hasOwn(UPDATE_INDEX_PLATFORMS, platform) ||
			UPDATE_INDEX_PLATFORMS[platform] !== suffix
		)
			throw new Error("Noncanonical platform suffix");
		return { platform, suffix, name: `narrafork-${options.version}-${suffix}` };
	});
	const related = new Set<string>();
	let scanned = 0;
	for await (const entry of await opendir(options.distDir)) {
		if (++scanned > 4096) throw new Error("Release dist entry limit exceeded");
		if (
			binaries.some(
				(b) =>
					entry.name.startsWith(`${b.name}.from-`) || entry.name.startsWith(`${b.name}.zstd-patch`),
			)
		) {
			if (!entry.name.endsWith(".zstd-patch") && !entry.name.endsWith(".zstd-patch.meta.json"))
				continue;
			related.add(entry.name);
			if (related.size > 128) throw new Error("Patch pair limit exceeded");
		}
	}
	const files: UpdateIndexRelease["files"] = [];
	for (const { platform, suffix, name } of binaries) {
		const metadataName = `${name}.metadata.json`;
		const raw = await readSidecar(join(options.distDir, metadataName));
		const meta = JSON.parse(raw);
		const binary = await hashReleaseFile(join(options.distDir, name));
		if (
			meta.name !== name ||
			meta.platform !== platform ||
			meta.version !== options.version ||
			meta.target !== `bun-${platform.replace(/^win-/, "windows-")}` ||
			typeof meta.commit !== "string" ||
			!/^[a-f0-9]{7,40}$/.test(meta.commit) ||
			!options.commit.startsWith(meta.commit) ||
			meta.size !== binary.size ||
			meta.sha256 !== binary.sha256 ||
			meta.sha512 !== binary.sha512 ||
			(meta.repository !== undefined &&
				(typeof meta.repository !== "string" ||
					meta.repository.toLowerCase() !== options.repository.toLowerCase()))
		)
			throw new Error(`Binary metadata identity mismatch: ${name}`);
		const patches: UpdateIndexRelease["files"][number]["patches"] = [];
		const names = new Set(
			[...related]
				.filter((entry) => entry.startsWith(`${name}.`))
				.map((entry) => (entry.endsWith(".meta.json") ? entry.slice(0, -10) : entry)),
		);
		for (const patchName of [...names].sort()) {
			const parsed = parseReleasePatchName(name, patchName);
			if (!parsed || !related.has(patchName) || !related.has(`${patchName}.meta.json`))
				throw new Error(`Invalid/unpaired patch: ${patchName}`);
			const patchRaw = await readSidecar(join(options.distDir, `${patchName}.meta.json`));
			const patchIdentity = await hashReleaseFile(
				join(options.distDir, patchName),
				MAX_RELEASE_PATCH_BYTES,
			);
			const patch = validateReleasePatchMetadata(JSON.parse(patchRaw), {
				...parsed,
				toVersion: options.version,
				patchSize: patchIdentity.size,
				newFileSize: binary.size,
				newFileSha512: binary.sha512,
			});
			const basePath = join(options.distDir, `narrafork-${patch.fromVersion}-${suffix}`);
			try {
				await lstat(basePath);
				const base = await hashReleaseFile(basePath);
				if (base.size !== patch.oldFileSize || base.sha512 !== patch.oldFileSha512)
					throw new Error("Patch base identity mismatch");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			patches.push({
				name: patchName,
				fromVersion: patch.fromVersion,
				size: patchIdentity.size,
				sha256: patchIdentity.sha256,
				metadata: { name: `${patchName}.meta.json`, ...textIdentity(patchRaw) },
			});
		}
		files.push({
			name,
			platform,
			...binary,
			metadata: { name: metadataName, ...textIdentity(raw) },
			patches,
		});
	}
	const release = parseUpdateIndexRelease({
		version: options.version,
		tag: `v${options.version}`,
		commit: options.commit,
		prerelease: releaseChannel(options.version) !== "stable",
		publishedAt: options.publishedAt ?? new Date().toISOString(),
		notes: { path: notes.path, size: notes.size, sha256: notes.sha256 },
		files,
	});
	return { release, notes };
}
