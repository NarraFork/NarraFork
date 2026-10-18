import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Shared by the two worker entry points without importing either entry's message handler. */
export async function rejectEditorSymlinks(path: string): Promise<void> {
	for (let cursor = resolve(path), depth = 0; ; cursor = dirname(cursor)) {
		if (++depth > 128) throw new Error("File path exceeds its ancestor budget");
		try {
			if ((await lstat(cursor)).isSymbolicLink())
				throw new Error("Symbolic links cannot be edited");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(cursor) === cursor) break;
	}
}
