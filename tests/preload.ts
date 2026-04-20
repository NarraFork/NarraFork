/**
 * Global test preload — ensures the settings singleton is always in a valid
 * state before each test, even when a previous test mutated or destroyed
 * sub-objects (e.g. `settings.agent = undefined`).
 *
 * Loaded via `bunfig.toml` → `[test].preload`.
 */
import { afterEach, beforeEach } from "bun:test";
import { getDefaults, settings } from "@server/lib/settings";

// Capture the live settings at preload time. This is the authoritative state
// that other modules (e.g. auth.ts) will have already read from.
const snapshot = structuredClone(settings);

beforeEach(() => {
	// Restore any sub-objects that may have been wiped by a previous test.
	const defaults = getDefaults();
	for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
		if (settings[key] === undefined || settings[key] === null) {
			// Use snapshot value (preserves runtime-generated secrets like jwtSecret)
			// biome-ignore lint/suspicious/noExplicitAny: restoring dynamic settings keys
			(settings as any)[key] = structuredClone((snapshot as any)[key]);
		}
	}
});

afterEach(() => {
	// Full restore from the original snapshot taken at module load time.
	for (const key of Object.keys(snapshot) as Array<keyof typeof snapshot>) {
		// biome-ignore lint/suspicious/noExplicitAny: restoring dynamic settings keys
		(settings as any)[key] = structuredClone((snapshot as any)[key]);
	}
});
