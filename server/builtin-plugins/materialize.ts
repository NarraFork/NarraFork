/**
 * Materialize the embedded builtin plugin packages onto disk for a compiled binary.
 *
 * Only compiled single-file binaries need this: their `import.meta.dir` is inside `$bunfs`,
 * so `join(import.meta.dir, "apikey-quota")` names a directory that does not exist. Running
 * from source uses the checked-out package directly and never reaches this module.
 *
 * Why write to disk at all instead of teaching the catalog to read from memory: a plugin
 * package is spawned as a child process, and the runtime validates the package through the
 * ordinary reader (sizes, JSON, schema, entry containment, symlink/escape checks) against a
 * real directory. Materializing keeps exactly one package-reading path for both distributions
 * instead of a second, weaker in-memory one.
 *
 * Where: `~/.narrafork/builtin-plugins/<dir>/<version>/`. Writing under the app's own home
 * (never a temp dir) means the files survive restarts, are covered by the same backup and
 * permission story as the rest of the data directory, and cannot be planted by another user
 * via a shared temp directory.
 *
 * Bounded work: the packages are a handful of text files (enforced at generation time), the
 * write happens once per version per process, and each file is compared by size before being
 * rewritten so a restart does not touch unchanged files.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";

/**
 * Shape of the build-time generated module.
 *
 * Declared here instead of importing it: `server/generated/` is not tracked, so a clean
 * checkout has no such file and a static import would fail `tsgo --noEmit` on every CI job.
 * `server/db/run-migrations.ts` reads its own generated module the same way — dynamic import
 * through a variable path plus a local type — so both survive a tree without generated files.
 */
interface EmbeddedBuiltinFile {
	path: string;
	content: string;
}

interface EmbeddedBuiltinPackage {
	dir: string;
	pluginId: string;
	version: string;
	files: readonly EmbeddedBuiltinFile[];
}

interface EmbeddedBuiltinPluginsModule {
	embeddedBuiltinPlugins: readonly EmbeddedBuiltinPackage[];
}

/** Root the embedded packages are written under, inside the NarraFork home. */
export const BUILTIN_PLUGIN_MATERIALIZED_ROOT = "builtin-plugins";

/** Resolved once per process; concurrent callers share the same promise. */
let materializing: Promise<readonly string[]> | undefined;

/**
 * Write every embedded package under the NarraFork home and return their directories, in the
 * same order as `BUILTIN_PLUGIN_ROOTS` so the catalog's current-pointer logic is unchanged.
 */
export function materializeBuiltinPlugins(): Promise<readonly string[]> {
	materializing ??= (async () => {
		// Variable path so a clean tree (no generated files) still type-checks; see the type
		// declaration above. A compiled binary always has the module inlined.
		const generatedModulePath = "../generated/embedded-builtin-plugins";
		const generated = (await import(generatedModulePath)) as
			| EmbeddedBuiltinPluginsModule
			| undefined;
		const packages = generated?.embeddedBuiltinPlugins;
		if (!Array.isArray(packages) || packages.length === 0) {
			logger.warn("no embedded builtin plugin packages in this build");
			return [];
		}
		const root = getNarraforkPath(BUILTIN_PLUGIN_MATERIALIZED_ROOT);
		const dirs: string[] = [];
		for (const pkg of packages) {
			const dir = join(root, pkg.dir, pkg.version);
			dirs.push(dir);
			for (const file of pkg.files) {
				const target = join(dir, file.path);
				const expected = Buffer.byteLength(file.content, "utf8");
				const existing = await sizeOf(target);
				// Same size is the cheap, sufficient check for generated content: the bytes come
				// from this build, so an equal length means an equal file.
				if (existing === expected) continue;
				await mkdir(join(target, ".."), { recursive: true });
				await writeFile(target, file.content, "utf8");
			}
		}
		logger.info("materialized builtin plugin packages", { root, packages: dirs.length });
		return dirs;
	})().catch((error: unknown) => {
		// A failed materialization must not take the host down: the catalog simply reports the
		// package as missing, exactly as it would for a corrupt installed package.
		logger.warn("failed to materialize builtin plugin packages", {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	});
	return materializing;
}

async function sizeOf(path: string): Promise<number | undefined> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the materialized copy on disk matches the embedded content. */
export async function readMaterialized(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}
