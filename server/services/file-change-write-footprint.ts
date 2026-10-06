import { dirname } from "node:path";
import { LocalFileValidationError, localDirectoryIdentity } from "./file-change-local-io";

/** Identity anchor is not the modification range. A missing parent reserves only
 * its first missing subtree, never the existing ancestor (which may be `/`). */
export interface LocalWriteFootprint {
	readonly anchor: string;
	readonly anchorIdentity: string;
	readonly ranges: readonly {
		readonly kind: "file" | "subtree";
		readonly canonicalPath: string;
	}[];
}

export async function captureLocalWriteFootprint(
	canonicalPath: string,
	signal: AbortSignal,
): Promise<LocalWriteFootprint> {
	let anchor = dirname(canonicalPath);
	let missingRoot: string | undefined;
	for (let depth = 0; depth <= 128; depth++) {
		signal.throwIfAborted();
		try {
			const anchorIdentity = await localDirectoryIdentity(anchor);
			signal.throwIfAborted();
			return Object.freeze({
				anchor,
				anchorIdentity,
				ranges: Object.freeze([
					Object.freeze({
						kind: missingRoot ? ("subtree" as const) : ("file" as const),
						canonicalPath: missingRoot ?? canonicalPath,
					}),
				]),
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(anchor);
			if (parent === anchor) throw error;
			missingRoot = anchor;
			anchor = parent;
		}
	}
	throw new LocalFileValidationError("Write parent depth exceeds the admission budget");
}

/** Losing/replacing the anchor must not broaden a granted file reservation into
 * mkdir work outside that reservation. Recheck before every mutating phase. */
export async function assertLocalWriteFootprint(footprint: LocalWriteFootprint): Promise<void> {
	if ((await localDirectoryIdentity(footprint.anchor)) !== footprint.anchorIdentity)
		throw new LocalFileValidationError("Write parent identity changed after range admission");
}
