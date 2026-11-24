/** Owner-only copies of the files a credential migration reads or changes. */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

export const CREDENTIAL_BACKUPS_DIR = "credential-backups";

export function chmodPrivate(path: string, mode: number): void {
	if (process.platform === "win32") return;
	try {
		chmodSync(path, mode);
	} catch {
		/* Network filesystems can reject chmod. */
	}
}

/** Copy `files` (relative to `home`) into a fresh `<label>-<time>` directory. */
export function backUpCredentialFiles(
	home: string,
	label: string,
	files: readonly string[],
): string {
	const root = resolve(home, CREDENTIAL_BACKUPS_DIR);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	// A retry after a failed attempt never writes into an earlier backup.
	let dir = resolve(root, `${label}-${stamp}`);
	for (let n = 2; existsSync(dir); n++) dir = resolve(root, `${label}-${stamp}-${n}`);
	mkdirSync(dir, { mode: 0o700 });
	for (const path of [root, dir]) chmodPrivate(path, 0o700);
	for (const name of files) {
		const source = resolve(home, name);
		if (!existsSync(source)) continue;
		const target = resolve(dir, basename(name));
		copyFileSync(source, target);
		chmodPrivate(target, 0o600);
	}
	return dir;
}
