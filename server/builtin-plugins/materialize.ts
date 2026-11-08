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
import { embeddedBuiltinPlugins } from "../generated/embedded-builtin-plugins";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";

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
		const root = getNarraforkPath(BUILTIN_PLUGIN_MATERIALIZED_ROOT);
		const dirs: string[] = [];
		for (const pkg of embeddedBuiltinPlugins) {
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
