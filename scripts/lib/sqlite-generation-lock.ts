import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

interface LockOptions {
	/** Failure injection only: no production caller overrides filesystem operations. */
	writeOwner?: typeof writeFileSync;
	removeDirectory?: typeof rmdirSync;
}
/** Atomic mkdir is the supported same-machine filesystem lock on Linux/macOS/Windows.
 * Resolve the existing meta directory, not a textual root alias. No native flock fallback,
 * PID probing, TTL, self-reported pending phase, or stale-owner takeover is allowed.
 * A crashed process leaves the lock for explicit operator repair AFTER checking all
 * producers have stopped. Network/distributed filesystems are not supported/tested. */
export function acquireSqliteGenerationLock(meta: string, options: LockOptions = {}): () => void {
	const path = join(realpathSync(meta), "_generation.lock");
	try {
		mkdirSync(path);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(
				"SQLite generation lock exists; another producer or interrupted owner requires explicit repair",
				{ cause },
			);
		throw cause;
	}
	const identity = lstatSync(path);
	const ownerPath = join(path, "owner.json");
	const owner = JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname() });
	const sameDirectory = () => {
		const current = lstatSync(path);
		return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino;
	};
	const sameOwner = () => {
		const file = lstatSync(ownerPath);
		// Never follow replacement symlinks or read an unbounded/foreign metadata file.
		return (
			file.isFile() &&
			file.size === Buffer.byteLength(owner) &&
			readFileSync(ownerPath, "utf8") === owner
		);
	};
	try {
		(options.writeOwner ?? writeFileSync)(ownerPath, owner, { flag: "wx" });
	} catch (cause) {
		// Only this newly created directory may be cleaned. Unexpected files or identity
		// changes retain it fail-closed rather than deleting another owner's evidence.
		if (sameDirectory()) {
			try {
				if (sameOwner()) unlinkSync(ownerPath);
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
			}
			(options.removeDirectory ?? rmdirSync)(path);
		}
		throw cause;
	}
	let released = false;
	return () => {
		if (released) return;
		if (!sameDirectory() || !sameOwner())
			throw new Error("SQLite generation lock owner changed; refusing release");
		unlinkSync(ownerPath);
		(options.removeDirectory ?? rmdirSync)(path);
		released = true;
	};
}
