import { pathToFileURL } from "node:url";

/**
 * Plugin runtime worker mode — self-hosted plugin runtime.
 *
 * A compiled NarraFork binary embeds the Bun runtime, so instead of requiring
 * users to install a system Bun to spawn `local-process` plugins (which fails
 * silently on Windows when no Bun is found and previously fell back to
 * spawning the host binary itself → instance lock conflict → QUARANTINED),
 * the host spawns *itself* with this flag:
 *
 *   <narrafork-exe> --plugin-runtime-worker <absolute-entry-path> [plugin args...]
 *
 * The entry point branches here BEFORE importing ./main, so this mode never
 * opens the database, never takes the instance lock, and never starts the
 * HTTP server. The plugin entry module is loaded in-process; because plugin
 * transport is stdio RPC (`narrafork.rpc/1`), the plugin simply owns the
 * stdin/stdout channel it was spawned with — plugin code does not need to
 * know how it is hosted, and `import.meta.url` still points at the real
 * entry file (relative sibling imports like `../manifest.json` keep working).
 *
 * Dev mode is unaffected: when the host runs under Bun directly, the manager
 * keeps spawning `bun <entry>` as before.
 */
export const PLUGIN_RUNTIME_WORKER_FLAG = "--plugin-runtime-worker";

export async function runPluginRuntimeWorker(): Promise<never> {
	const flagIndex = process.argv.indexOf(PLUGIN_RUNTIME_WORKER_FLAG);
	const entryPath = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
	if (!entryPath) {
		console.error(`[${PLUGIN_RUNTIME_WORKER_FLAG}] missing plugin entry path`);
		process.exit(2);
	}
	try {
		await import(pathToFileURL(entryPath).href);
	} catch (error) {
		console.error(`[${PLUGIN_RUNTIME_WORKER_FLAG}] failed to load plugin entry: ${entryPath}`);
		console.error(error);
		process.exit(1);
	}
	// The plugin entry owns the stdio RPC loop and keeps the process alive.
	// If the entry returns without setting up a server loop, exit cleanly.
	process.exit(0);
}
