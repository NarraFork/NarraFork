import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { normalizePathForComparison } from "@server/lib/platform-path";
import { NARRATOR_BACKUP_LIMITS as LIMITS } from "@shared/narrator-backup";
import type { ArchiveRow } from "../project-archive/main-store";
import type { BackupManifest, BackupObject, BackupState } from "./contract";

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const gitOid = (kind: string, bytes: Uint8Array) =>
	createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
export function treeEntries(bytes: Buffer): { mode: string; name: string; oid: string }[] {
	const entries: { mode: string; name: string; oid: string }[] = [];
	for (let offset = 0; offset < bytes.length; ) {
		const space = bytes.indexOf(32, offset);
		const zero = bytes.indexOf(0, space + 1);
		if (space <= offset || zero < space || zero + 21 > bytes.length)
			throw new Error("Invalid Git tree");
		const mode = bytes.subarray(offset, space).toString("ascii");
		const rawName = bytes.subarray(space + 1, zero);
		const name = rawName.toString("utf8");
		if (
			!Buffer.from(name).equals(rawName) ||
			!name ||
			name === "." ||
			name === ".." ||
			name === ".git" ||
			/[\\/\0]/.test(name)
		)
			throw new Error("Unsafe Git tree name");
		if (!["40000", "100644", "100755", "120000"].includes(mode))
			throw new Error("Unsupported Git tree mode (gitlinks excluded)");
		entries.push({ mode, name, oid: bytes.subarray(zero + 1, zero + 21).toString("hex") });
		offset = zero + 21;
	}
	return entries;
}
export function gitDependencies(kind: string, bytes: Buffer): string[] {
	if (kind === "git-tree") return treeEntries(bytes).map((entry) => `git:${entry.oid}`);
	if (kind === "git-commit") {
		const header = bytes
			.subarray(0, bytes.indexOf("\n\n") < 0 ? bytes.length : bytes.indexOf("\n\n"))
			.toString("utf8");
		const links = header.split("\n").filter((line) => /^(tree|parent) /.test(line));
		if (!links.some((line) => line.startsWith("tree "))) throw new Error("Commit has no tree");
		return links.map((line) => {
			const oid = line.split(" ")[1];
			if (!oid || !/^[a-f0-9]{40}$/.test(oid)) throw new Error("Invalid commit dependency");
			return `git:${oid}`;
		});
	}
	return [];
}
/** Output limited WHILE reading, child timeout/cancellation kill only this helper. */
export async function boundedBackupGit(
	args: string[],
	signal: AbortSignal,
	maxBytes = LIMITS.objectBytes,
): Promise<Buffer> {
	signal.throwIfAborted();
	const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
	const stop = () => child.kill();
	const timer = setTimeout(stop, LIMITS.childMs);
	signal.addEventListener("abort", stop, { once: true });
	async function consume(stream: ReadableStream<Uint8Array>, limit: number) {
		const reader = stream.getReader();
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				size += next.value.length;
				if (size > limit) {
					stop();
					throw new Error("Git object output budget exceeded");
				}
				chunks.push(Buffer.from(next.value));
			}
			return Buffer.concat(chunks, size);
		} finally {
			reader.releaseLock();
		}
	}
	try {
		const [bytes, , status] = await Promise.all([
			consume(child.stdout, maxBytes),
			consume(child.stderr, 16 * 1024),
			child.exited,
		]);
		signal.throwIfAborted();
		if (status !== 0) throw new Error("Missing Git object dependency or child timeout");
		return bytes;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		stop();
		await child.exited;
	}
}
export async function readBackupObjectFile(
	path: string,
	check: () => void,
	maxBytes = LIMITS.objectBytes,
): Promise<Buffer> {
	check();
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes)
			throw new Error("Unsafe or oversized object dependency");
		const bytes = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			check();
			const result = await file.read(
				bytes,
				offset,
				Math.min(1024 * 1024, bytes.length - offset),
				offset,
			);
			if (!result.bytesRead) throw new Error("Object changed while reading");
			offset += result.bytesRead;
		}
		const final = await file.stat();
		if (
			final.size !== stat.size ||
			final.mtimeMs !== stat.mtimeMs ||
			final.ctimeMs !== stat.ctimeMs
		)
			throw new Error("Object changed while reading");
		return bytes;
	} finally {
		await file.close();
	}
}
export interface BackupObjectSource {
	shadowRoot: string;
	uploadsRoot: string;
	blobRoot: string;
	journalRoot: string;
	/** Only source evidence queries in the same read snapshot, with fixed SQL scopes. */
	fileBlobDigests(operationId: string): Promise<string[]>;
}
export async function collectBackupObjects(
	state: BackupState,
	manifest: BackupManifest,
	source: BackupObjectSource,
	put: (object: BackupObject, bytes: Buffer) => void,
	signal: AbortSignal,
	check: () => void,
): Promise<void> {
	const known = new Set<string>();
	let total = 0;
	const narrators = new Map((state.rows.narrators ?? []).map((r) => [String(r.id), r]));
	const authority = new Set(narrators.keys());
	const add = (
		key: string,
		kind: BackupObject["kind"],
		bytes: Buffer,
		dependencies: string[] = [],
	) => {
		check();
		if (known.has(key)) return;
		total += bytes.length;
		if (
			bytes.length > LIMITS.objectBytes ||
			total > LIMITS.totalObjectBytes ||
			known.size >= LIMITS.objects
		)
			throw new Error("Backup object budget exceeded");
		const object = { key, kind, digest: sha256(bytes), size: bytes.length, dependencies };
		put(object, bytes);
		manifest.objects.push(object);
		known.add(key);
	};
	const repos = new Map<string, string>();
	function repo(row: ArchiveRow) {
		const narrator = narrators.get(String(row.narrator_id ?? row.id));
		const device = row.execution_device_id ?? narrator?.default_device_id ?? "local";
		const cwd = row.execution_cwd ?? narrator?.cwd;
		if (device !== "local" || typeof cwd !== "string")
			throw new Error("Snapshot bytes require a supported local source workspace");
		const digest = createHash("sha256")
			.update(`local\0${normalizePathForComparison(cwd)}`)
			.digest("hex");
		return join(source.shadowRoot, digest.slice(0, 32));
	}
	async function gitObject(oid: string, directory: string, depth = 0): Promise<void> {
		check();
		const key = `git:${oid}`;
		if (known.has(key)) return;
		if (!/^[a-f0-9]{40}$/.test(oid) || depth > 1024)
			throw new Error("Invalid or excessive Git object DAG");
		const kind = (
			await boundedBackupGit([`--git-dir=${directory}`, "cat-file", "-t", oid], signal, 32)
		)
			.toString()
			.trim();
		if (!["tree", "blob", "commit"].includes(kind)) throw new Error("Unsupported Git object");
		const size = Number(
			(
				await boundedBackupGit([`--git-dir=${directory}`, "cat-file", "-s", oid], signal, 32)
			).toString(),
		);
		if (!Number.isSafeInteger(size) || size > LIMITS.objectBytes)
			throw new Error("Git object size exceeds budget");
		const bytes = await boundedBackupGit([`--git-dir=${directory}`, "cat-file", kind, oid], signal);
		if (bytes.length !== size || gitOid(kind, bytes) !== oid)
			throw new Error("Git object hash mismatch");
		const type = `git-${kind}` as BackupObject["kind"];
		const dependencies = gitDependencies(type, bytes);
		add(key, type, bytes, dependencies);
		for (const dependency of dependencies)
			await gitObject(dependency.slice(4), directory, depth + 1);
	}
	for (const row of [
		...(state.rows.narrator_messages ?? []),
		...(state.rows.narrator_tool_calls ?? []),
	]) {
		for (const column of ["tree_hash_before", "tree_hash_after", "snapshot_commit_sha"]) {
			const oid = row[column];
			if (typeof oid === "string") repos.set(oid, repo(row));
		}
	}
	for (const [oid, directory] of repos) {
		manifest.roots.push(`git:${oid}`);
		await gitObject(oid, directory);
	}
	// Historical image owners must already be in the individually-authorized closure.
	for (const message of state.rows.narrator_messages ?? []) {
		for (const field of ["content_json", "original_content_json"]) {
			const value = message[field];
			if (typeof value !== "string") continue;
			const blocks = JSON.parse(value);
			if (!Array.isArray(blocks)) continue;
			for (const block of blocks) {
				if (block?.type !== "image" || typeof block.imageId !== "string") continue;
				const owner = block.uploadNarratorId ?? message.narrator_id;
				if (
					!authority.has(owner) ||
					!/^[A-Za-z0-9_-]+$/.test(block.imageId) ||
					!/^[A-Za-z0-9_-]+$/.test(owner)
				)
					throw new Error("Unauthorized upload dependency");
				const key = `upload:${owner}:${block.imageId}`;
				if (known.has(key)) continue;
				let matching: string | undefined;
				let count = 0;
				for await (const file of await opendir(join(source.uploadsRoot, owner))) {
					check();
					if (++count > LIMITS.objects) throw new Error("Upload directory budget exceeded");
					if (file.name.startsWith(block.imageId) && file.isFile()) {
						if (matching) throw new Error("Ambiguous upload dependency");
						matching = file.name;
					}
				}
				if (!matching) throw new Error("Missing historical image dependency");
				add(
					key,
					"upload",
					await readBackupObjectFile(join(source.uploadsRoot, owner, matching), check),
				);
				manifest.roots.push(key);
			}
		}
	}
	for (const tool of state.rows.narrator_tool_calls ?? []) {
		const operation = tool.file_change_operation_id;
		if (typeof operation !== "string") continue;
		for (const digest of await source.fileBlobDigests(operation)) {
			if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid file blob dependency");
			const bytes = await readBackupObjectFile(
				join(source.blobRoot, "sha256", digest.slice(0, 2), digest),
				check,
			);
			if (sha256(bytes) !== digest) throw new Error("File blob digest mismatch");
			add(`file-blob:${digest}`, "file-blob", bytes);
			manifest.roots.push(`file-blob:${digest}`);
		}
	}
	for (const resource of state.rows.narrator_worktree_resources ?? []) {
		const key = createHash("sha256")
			.update(JSON.stringify([resource.owner_narrator_id, resource.create_request_id]))
			.digest("hex");
		const path = join(source.journalRoot, `${key}.json`);
		if (!(await lstat(path).catch(() => null)))
			throw new Error("Missing worktree creation journal");
		const bytes = await readBackupObjectFile(path, check);
		const record = JSON.parse(bytes.toString());
		// Audit only: never republish past request IDs as consumable creation receipts.
		delete record.actorKey;
		add(
			`journal:${resource.id}`,
			"worktree-journal",
			Buffer.from(JSON.stringify({ auditOnly: true, record })),
		);
		manifest.roots.push(`journal:${resource.id}`);
	}
	manifest.roots = [...new Set(manifest.roots)];
}
