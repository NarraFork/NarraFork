/**
 * Where a team coordinator's saved tool outputs live (Project Teams P2): one directory per
 * coordinator narrator under the NarraFork data directory,
 * `~/.narrafork/coordinator-outputs/<narratorId>/`.
 *
 * Path helpers only (no database, no fs writes), so the Read tool and the permission gate can
 * ask "is this the calling narrator's own saved output?" without importing services. Reading
 * one's own saved outputs is auto-allowed and returned whole by Read; another narrator's
 * directory gets no such treatment.
 */
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getNarraforkPath } from "./narrafork-home";

export const COORDINATOR_OUTPUTS_DIRNAME = "coordinator-outputs";

/** Narrator ids are generated (nanoid); anything else never names a directory. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function coordinatorOutputsRoot(): string {
	return getNarraforkPath(COORDINATOR_OUTPUTS_DIRNAME);
}

/** The narrator's own directory, or null for an id that cannot name one. */
export function coordinatorOutputsDir(narratorId: string): string | null {
	return SAFE_ID.test(narratorId) ? join(coordinatorOutputsRoot(), narratorId) : null;
}

function within(parent: string, child: string): boolean {
	return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Whether an absolute local path is a file inside the narrator's own saved-output directory. */
export function isOwnCoordinatorOutputPath(
	narratorId: string | undefined | null,
	absolutePath: string,
): boolean {
	if (!narratorId) return false;
	const dir = coordinatorOutputsDir(narratorId);
	if (!dir) return false;
	const path = resolve(absolutePath);
	if (within(dir, path)) return true;
	// A data directory reached through a symlink: compare the real paths too.
	try {
		const realDir = realpathSync(dir);
		return realDir !== dir && within(realDir, path);
	} catch {
		return false;
	}
}
