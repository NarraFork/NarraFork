import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ChangelogEntry {
	version: string;
	date: string;
	en: string;
	"zh-CN": string;
}

const CHANGELOGS_DIR = resolve(import.meta.dir, "../../changelogs");

/** Compare two semver strings, descending (newest first). */
function semverCompareDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
	}
	return 0;
}

/**
 * Load all changelogs, sorted by version descending.
 *
 * - Dev mode: reads from `changelogs/` directory on disk.
 * - Compiled binary: `changelogs/` won't exist, falls back to embedded data.
 */
export async function getChangelogs(): Promise<ChangelogEntry[]> {
	// Try filesystem first (dev mode)
	if (existsSync(CHANGELOGS_DIR)) {
		const entries: ChangelogEntry[] = [];
		for (const name of readdirSync(CHANGELOGS_DIR)) {
			if (!name.endsWith(".json")) continue;
			try {
				const raw = readFileSync(join(CHANGELOGS_DIR, name), "utf-8");
				const parsed = JSON.parse(raw) as ChangelogEntry;
				if (parsed.version && parsed.date) {
					entries.push(parsed);
				}
			} catch {
				// skip malformed files
			}
		}
		entries.sort((a, b) => semverCompareDesc(a.version, b.version));
		return entries;
	}

	// Compiled binary: use embedded data
	try {
		const { embeddedChangelogs } = await import("@server/generated/embedded-changelog");
		const entries = [...embeddedChangelogs];
		entries.sort((a, b) => semverCompareDesc(a.version, b.version));
		return entries;
	} catch {
		return [];
	}
}
