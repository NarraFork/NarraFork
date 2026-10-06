/**
 * Pure helpers for aggregating electron-builder latest*.yml manifests.
 */

export interface LatestYmlFile {
	url: string;
	size: number;
	sha512: string;
}

export interface LatestYmlEntry {
	name: string;
	version: string;
	releaseDate: string;
	file: LatestYmlFile;
}

export interface LatestYmlManifest {
	version: string;
	releaseDate: string;
	files: LatestYmlFile[];
}

/** Group worker results by metadata filename while retaining every architecture. */
export function aggregateLatestYmlEntries(
	entries: ReadonlyArray<LatestYmlEntry>,
): Map<string, LatestYmlManifest> {
	const manifests = new Map<string, LatestYmlManifest>();
	for (const entry of entries) {
		const existing = manifests.get(entry.name);
		if (existing && existing.version !== entry.version) {
			throw new Error(
				`Ambiguous ${entry.name}: mixed versions ${existing.version} and ${entry.version}`,
			);
		}
		const manifest = existing ?? {
			version: entry.version,
			releaseDate: entry.releaseDate,
			files: [],
		};
		if (!manifest.files.some((file) => file.url === entry.file.url)) {
			manifest.files.push(entry.file);
		}
		manifests.set(entry.name, manifest);
	}
	return manifests;
}

/** Format one latest*.yml manifest with a trailing LF for release artifacts. */
export function formatLatestYmlManifest(manifest: LatestYmlManifest): string {
	const files = [...manifest.files].sort((a, b) => a.url.localeCompare(b.url));
	const single = files.length === 1 ? files[0] : undefined;
	const lines = [`version: ${manifest.version}`, `releaseDate: "${manifest.releaseDate}"`];
	if (single) {
		lines.push(`path: ${single.url}`, `sha512: ${single.sha512}`);
	}
	lines.push("files:");
	for (const file of files) {
		lines.push(`  - url: ${file.url}`, `    size: ${file.size}`, `    sha512: ${file.sha512}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Aggregate and format all latest*.yml files produced by post-processing workers. */
export function formatLatestYmlFiles(entries: ReadonlyArray<LatestYmlEntry>): Map<string, string> {
	return new Map(
		[...aggregateLatestYmlEntries(entries)].map(([name, manifest]) => [
			name,
			formatLatestYmlManifest(manifest),
		]),
	);
}
