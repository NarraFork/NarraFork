import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Resolve NarraFork's canonical data directory.
 *
 * NARRAFORK_HOME is read lazily so test preloads and embedded runtimes can set
 * the override before application modules are imported.
 */
export function getNarraforkHome(): string {
	return resolve(process.env.NARRAFORK_HOME?.trim() || resolve(homedir(), ".narrafork"));
}

export function getNarraforkPath(...segments: string[]): string {
	return resolve(getNarraforkHome(), ...segments);
}
