import { existsSync, opendirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	collectPostgresMigrationData,
	renderPostgresMigrationData,
} from "../../server/db/run-migrations";
import { buildLicenseManifestFromDisk } from "../../server/lib/licenses/manifest";
import type { HelperDistributionDependencies } from "../../shared/helper-distribution";
import type { LocalizedValue } from "../../shared/i18n-locales";

/** Shared by release and local builds; these functions never write into the checkout. */
function collectAssetFiles(directory: string): string[] {
	const files: string[] = [];
	const pending = [directory];
	let entries = 0;
	for (let current = pending.pop(); current; current = pending.pop()) {
		const dir = opendirSync(current);
		try {
			for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
				if (++entries > 20_000) throw new Error("Build asset tree exceeds 20000 entries");
				const path = join(current, entry.name);
				if (entry.isDirectory()) pending.push(path);
				else if (entry.isFile()) files.push(path);
				else throw new Error(`Build assets must be regular files/directories: ${path}`);
			}
		} finally {
			dir.closeSync();
		}
	}
	return files.sort();
}

function renderEmbeddedAssets(files: ReadonlyMap<string, string>): string {
	const imports: string[] = [];
	const entries: string[] = [];
	for (const [url, path] of files) {
		const name = `_f${imports.length}`;
		imports.push(`import ${name} from ${JSON.stringify(path)} with { type: "file" };`);
		entries.push(`${JSON.stringify(url)}: ${name}`);
	}
	return `${imports.join("\n")}\nexport const embeddedAssets: Record<string, string> = {${entries.join(",\n")}};\n`;
}

export function assetsUnder(directory: string): Map<string, string> {
	return new Map(
		collectAssetFiles(directory).map((path) => [
			`/${relative(directory, path).replaceAll("\\", "/")}`,
			path,
		]),
	);
}

export interface BuildInfo {
	version: string;
	commit: string;
	platform: string;
	repository: string;
	helperDistribution: HelperDistributionDependencies;
}

export function renderBuildInfo(info: BuildInfo): string {
	return `export const buildVersion = ${JSON.stringify(info.version)};
export const buildCommit = ${JSON.stringify(info.commit)};
export const buildPlatform = ${JSON.stringify(info.platform)};
export const buildRepository = ${JSON.stringify(info.repository)};
export const buildHelperDistribution = ${JSON.stringify(info.helperDistribution)};
`;
}

function renderSqliteMigrations(root: string): string {
	const directory = join(root, "drizzle");
	const journalPath = join(directory, "meta/_journal.json");
	const journalJson = readFileSync(journalPath, "utf8");
	const journal = JSON.parse(journalJson) as { entries: Array<{ tag: string }> };
	const sql = journal.entries.map(({ tag }) => {
		if (!/^[A-Za-z0-9_-]+$/.test(tag)) throw new Error(`Invalid migration tag: ${tag}`);
		const name = `${tag}.sql`;
		return { name, content: readFileSync(join(directory, name), "utf8") };
	});
	return `export const embeddedMigrationJournalJson = ${JSON.stringify(journalJson)};
export const embeddedMigrationSqlFiles: ReadonlyArray<{ name: string; content: string }> = ${JSON.stringify(sql)};
`;
}

function renderChangelogs(root: string): string {
	const directory = join(root, "changelogs");
	type Entry = { version: string; date: string } & LocalizedValue<string>;
	const entries: Entry[] = [];
	if (existsSync(directory)) {
		for (const name of readdirSync(directory)) {
			if (!name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(readFileSync(join(directory, name), "utf8"));
				if (
					typeof parsed.version === "string" &&
					typeof parsed.date === "string" &&
					typeof parsed.en === "string"
				) {
					entries.push(parsed);
				}
			} catch {
				// Preserve release behavior: malformed optional changelogs are omitted.
			}
		}
	}
	entries.sort((a, b) => {
		const pa = a.version.split(".").map(Number);
		const pb = b.version.split(".").map(Number);
		for (let i = 0; i < 3; i++) {
			if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
		}
		return 0;
	});
	return `export const embeddedChangelogs = ${JSON.stringify(entries)} as const;\n`;
}

function renderLicenses(root: string): string {
	const manifest = buildLicenseManifestFromDisk(root);
	const errors = manifest.problems.filter((problem) => problem.severity === "error");
	for (const warning of manifest.problems.filter((problem) => problem.severity === "warn")) {
		console.warn(`license: ${warning.name ?? ""}: ${warning.message}`);
	}
	if (errors.length) {
		throw new Error(
			`License manifest has ${errors.length} blocking problem(s):\n${errors
				.slice(0, 20)
				.map((error) => `${error.name ?? ""}: ${error.message}`)
				.join("\n")}\nFix these or declare the component in licenses/extra/entries.json.`,
		);
	}
	// JSON.parse prevents TypeScript from inferring a huge union for all license texts.
	return `import type { LicenseEntry, LicenseProblem } from "@server/lib/licenses/types";
export const embeddedLicenseEntries: readonly LicenseEntry[] = JSON.parse(${JSON.stringify(JSON.stringify(manifest.entries))});
export const embeddedLicenseTexts: Record<string, string> = JSON.parse(${JSON.stringify(JSON.stringify(manifest.texts))});
export const embeddedLicenseProblems: readonly LicenseProblem[] = JSON.parse(${JSON.stringify(JSON.stringify(manifest.problems))});
export const embeddedLicenseGeneratedAt = ${manifest.generatedAt};
`;
}

/** Paths are logical server/generated basenames, suitable for disk output or an in-memory plugin. */
export function collectBuildModules(
	root: string,
	assets: ReadonlyMap<string, string>,
	info: BuildInfo,
): Map<string, string> {
	// Account for assets before handing them to Bun, not after reading them into memory.
	let bytes = 0;
	if (assets.size > 20_000) throw new Error("Build assets exceed 20000 files");
	for (const path of assets.values()) {
		const stat = statSync(path);
		bytes += stat.size;
		if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024) {
			throw new Error(`Build asset budget exceeded: ${path}`);
		}
	}
	return new Map([
		["embedded-frontend.ts", renderEmbeddedAssets(assets)],
		["embedded-migrations-data.ts", renderSqliteMigrations(root)],
		[
			"embedded-postgres-migrations-data.ts",
			renderPostgresMigrationData(collectPostgresMigrationData(join(root, "drizzle-postgres"))),
		],
		["build-info.ts", renderBuildInfo(info)],
		["embedded-changelog.ts", renderChangelogs(root)],
		["embedded-licenses.ts", renderLicenses(root)],
	]);
}
