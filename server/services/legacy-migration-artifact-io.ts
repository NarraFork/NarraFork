import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { AppError, ValidationError } from "../lib/errors";
import { safeSpawn } from "../lib/spawn";
import type { getAuthorizedLegacyArtifactDescriptor } from "./legacy-migration-artifact-claims";
import type { NarratorPrincipal } from "./narrator-acl";

export type LegacyArtifactDescriptor = NonNullable<
	Awaited<ReturnType<typeof getAuthorizedLegacyArtifactDescriptor>>
>;
export const LEGACY_ARTIFACT_IO_LIMITS = {
	bytes: 128 * 1024,
	textBytes: 64 * 1024,
	entries: 100,
	scan: 1024,
	milliseconds: 3000,
} as const;
interface Dependencies {
	authorize: (id: string, principal: NarratorPrincipal) => Promise<LegacyArtifactDescriptor | null>;
	authorizeWrite: (
		descriptor: LegacyArtifactDescriptor,
		principal: NarratorPrincipal,
	) => Promise<void>;
	spawn: typeof safeSpawn;
	authorizeSnapshot: (
		id: string,
		principal: NarratorPrincipal,
		sha: string,
		signal?: AbortSignal,
	) => Promise<boolean>;
}
const unavailable = () => new AppError("Artifact unavailable", 404, "NOT_FOUND");
const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;
const version = (stat: BigIntStats) =>
	`${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const fdPath = (handle: FileHandle) => `/proc/${process.pid}/fd/${handle.fd}`;

/** Client paths are always literal relative names, never Git revision/pathspec expressions. */
export function validateLegacyArtifactRelativePath(path: string, allowEmpty = false): string[] {
	if (allowEmpty && path === "") return [];
	if (
		!path ||
		path.length > 1024 ||
		/[\\:]/.test(path) ||
		[...path].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		path.split("/").some((part) => !part || part === "." || part === "..") ||
		path.split("/").length > 32
	)
		throw new ValidationError("Invalid artifact-relative path");
	return path.split("/");
}

const defaults: Dependencies = {
	authorize: async (id, principal) => {
		const claims = await import("./legacy-migration-artifact-claims");
		return claims.getAuthorizedLegacyArtifactDescriptor(id, principal);
	},
	authorizeWrite: async (descriptor, principal) => {
		if (!descriptor.narratorId) {
			if (
				!principal.isAdmin &&
				(!descriptor.ownerUserId || descriptor.ownerUserId !== principal.userId)
			)
				throw unavailable();
			return;
		}
		const { db } = await import("../db");
		const { narrators } = await import("../db/schema");
		const { eq } = await import("drizzle-orm");
		const { assertNarratorAccess, NARRATOR_ACL_COLUMNS } = await import("./narrator-acl");
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, descriptor.narratorId),
			columns: NARRATOR_ACL_COLUMNS,
		});
		if (!narrator) throw unavailable();
		await assertNarratorAccess(narrator, principal, "write");
	},
	spawn: safeSpawn,
	authorizeSnapshot: async (id, principal, sha, signal) => {
		const origin = await import("./legacy-retained-history-origin");
		return origin.isAuthorizedLegacyRetainedSnapshotCommit(id, principal, sha, signal);
	},
};

/** No archival JSON, absolute paths, owners, digests or raw file content in the public descriptor. */
function publicDescriptor(descriptor: LegacyArtifactDescriptor) {
	return {
		id: descriptor.id,
		narratorId: descriptor.narratorId,
		kind: descriptor.kind,
		state: descriptor.state,
		latestSnapshotCommitSha: descriptor.latestSnapshotCommitSha,
		capabilities: {
			read: process.platform === "linux" && ["shadow", "ignored_archive"].includes(descriptor.kind),
			restore: false,
		},
	};
}

export function createLegacyMigrationArtifactIo(overrides: Partial<Dependencies> = {}) {
	const deps = { ...defaults, ...overrides };
	async function authorize(id: string, principal: NarratorPrincipal) {
		if (!principal.userId || !id || id.length > 128) throw unavailable();
		const descriptor = await deps.authorize(id, principal).catch(() => {
			throw unavailable();
		});
		if (!descriptor || descriptor.state !== "claimed" || descriptor.deviceId !== "local")
			throw unavailable();
		return descriptor;
	}

	async function boundary<T>(
		id: string,
		principal: NarratorPrincipal,
		operation: (
			descriptor: LegacyArtifactDescriptor,
			root: FileHandle,
			check: () => Promise<void>,
			remaining: () => number,
		) => Promise<T>,
		signal?: AbortSignal,
	) {
		let root: FileHandle | undefined;
		const deadline = performance.now() + LEGACY_ARTIFACT_IO_LIMITS.milliseconds;
		const remaining = () => {
			if (signal?.aborted) throw new ValidationError("Artifact read cancelled");
			const budget = Math.ceil(deadline - performance.now());
			if (budget <= 0) throw new ValidationError("Artifact read deadline exceeded");
			return budget;
		};
		try {
			// proc-fd anchoring is required, not a best-effort path check followed by an unsafe open.
			if (process.platform !== "linux") throw unavailable();
			const descriptor = await authorize(id, principal);
			remaining();
			root = await open(
				descriptor.artifactPath,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			const rootIdentity = identity(await root.stat({ bigint: true }));
			const check = async () => {
				remaining();
				const current = await authorize(id, principal);
				if (
					JSON.stringify(current) !== JSON.stringify(descriptor) ||
					identity(await lstat(descriptor.artifactPath, { bigint: true })) !== rootIdentity
				)
					throw unavailable();
				remaining();
			};
			await check();
			const result = await operation(descriptor, root, check, remaining);
			await check();
			return result;
		} catch (error) {
			if (error instanceof AppError) throw error;
			throw unavailable();
		} finally {
			await root?.close();
		}
	}

	/** Each ancestor is a no-follow directory handle; leaf reads never resolve through live cwd. */
	async function scopedOpen(root: FileHandle, parts: string[], directory = false) {
		const handles: FileHandle[] = [];
		const links: Array<{ parent: FileHandle; name: string; handle: FileHandle }> = [];
		let parent = root;
		try {
			for (let i = 0; i < parts.length; i++) {
				const name = parts[i];
				const before = await lstat(`${fdPath(parent)}/${name}`, { bigint: true });
				if (
					before.isSymbolicLink() ||
					(i < parts.length - 1 || directory ? !before.isDirectory() : !before.isFile())
				)
					throw unavailable();
				const handle = await open(
					`${fdPath(parent)}/${name}`,
					constants.O_RDONLY |
						constants.O_NOFOLLOW |
						(i < parts.length - 1 || directory ? constants.O_DIRECTORY : constants.O_NONBLOCK),
				);
				handles.push(handle);
				const after = await handle.stat({ bigint: true });
				if (identity(before) !== identity(after)) throw unavailable();
				links.push({ parent, name, handle });
				parent = handle;
			}
			return {
				handle: parent,
				verify: async () => {
					for (const link of links) {
						const current = await lstat(`${fdPath(link.parent)}/${link.name}`, { bigint: true });
						if (
							current.isSymbolicLink() ||
							identity(current) !== identity(await link.handle.stat({ bigint: true }))
						)
							throw unavailable();
					}
				},
				close: async () => {
					for (const handle of handles.reverse()) await handle.close();
				},
			};
		} catch (error) {
			for (const handle of handles.reverse()) await handle.close();
			throw error;
		}
	}

	return {
		async descriptor(id: string, principal: NarratorPrincipal) {
			return publicDescriptor(await authorize(id, principal));
		},
		async file(id: string, principal: NarratorPrincipal, path: string, signal?: AbortSignal) {
			const parts = validateLegacyArtifactRelativePath(path);
			return boundary(
				id,
				principal,
				async (descriptor, root, check, remaining) => {
					if (descriptor.kind !== "ignored_archive") throw unavailable();
					const scoped = await scopedOpen(root, parts);
					try {
						await check();
						await scoped.verify();
						const before = await scoped.handle.stat({ bigint: true });
						if (!before.isFile()) throw unavailable();
						const buffer = Buffer.alloc(LEGACY_ARTIFACT_IO_LIMITS.bytes);
						const { bytesRead } = await scoped.handle.read(buffer, 0, buffer.length, 0);
						remaining();
						if (version(before) !== version(await scoped.handle.stat({ bigint: true })))
							throw unavailable();
						await scoped.verify();
						return {
							path,
							encoding: "base64",
							content: buffer.subarray(0, bytesRead).toString("base64"),
							bytesRead,
							truncated: before.size > BigInt(bytesRead),
						};
					} finally {
						await scoped.close();
					}
				},
				signal,
			);
		},
		async entries(
			id: string,
			principal: NarratorPrincipal,
			cursor = "0",
			limit = 50,
			signal?: AbortSignal,
		) {
			if (
				!/^\d{1,4}$/.test(cursor) ||
				Number(cursor) > LEGACY_ARTIFACT_IO_LIMITS.scan ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > LEGACY_ARTIFACT_IO_LIMITS.entries
			)
				throw new ValidationError("Invalid artifact page");
			return boundary(
				id,
				principal,
				async (descriptor, root, _check, remaining) => {
					if (descriptor.kind !== "ignored_archive") throw unavailable();
					const entries: Array<{ path: string; kind: string }> = [];
					let scanned = 0;
					let capped = false;
					const walk = async (parts: string[]) => {
						const scoped = await scopedOpen(root, parts, true);
						try {
							const directory = await opendir(fdPath(scoped.handle));
							for await (const entry of directory) {
								remaining();
								if (++scanned > LEGACY_ARTIFACT_IO_LIMITS.scan) {
									capped = true;
									break;
								}
								const child = [...parts, entry.name];
								const path = child.join("/");
								try {
									validateLegacyArtifactRelativePath(path);
								} catch {
									continue;
								}
								const stat = await lstat(`${fdPath(scoped.handle)}/${entry.name}`, {
									bigint: true,
								});
								entries.push({
									path,
									kind: stat.isSymbolicLink()
										? "symlink"
										: stat.isDirectory()
											? "directory"
											: stat.isFile()
												? "file"
												: "other",
								});
								if (stat.isDirectory() && child.length < 2) await walk(child);
								if (capped) break;
							}
							await scoped.verify();
						} finally {
							await scoped.close();
						}
					};
					await walk([]);
					entries.sort((a, b) => a.path.localeCompare(b.path));
					const offset = Number(cursor);
					const page = entries.slice(offset, offset + limit);
					const hasMore = offset + page.length < entries.length;
					return {
						entries: page,
						hasMore: hasMore || capped,
						nextCursor: hasMore ? String(offset + page.length) : null,
						truncated: capped,
						scanLimitReached: capped,
						depth: 2,
					};
				},
				signal,
			);
		},
		async tree(
			id: string,
			principal: NarratorPrincipal,
			sha: string,
			path = "",
			signal?: AbortSignal,
		) {
			if (!/^[a-f0-9]{40}$/.test(sha)) throw new ValidationError("Invalid snapshot SHA");
			validateLegacyArtifactRelativePath(path, true);
			return boundary(
				id,
				principal,
				async (descriptor, root, check, remaining) => {
					if (descriptor.kind !== "shadow") throw unavailable();
					// Git follows internal symlinks/alternates. Refuse such repositories instead of
					// allowing object resolution to escape the retained artifact's namespace.
					let scanned = 0;
					const verifyMetadata = async (parts: string[], depth: number) => {
						remaining();
						const scoped = await scopedOpen(root, parts, true);
						try {
							const directory = await opendir(fdPath(scoped.handle));
							for await (const entry of directory) {
								remaining();
								if (++scanned > LEGACY_ARTIFACT_IO_LIMITS.scan) throw unavailable();
								const child = [...parts, entry.name];
								const stat = await lstat(`${fdPath(scoped.handle)}/${entry.name}`, {
									bigint: true,
								});
								if (
									stat.isSymbolicLink() ||
									(!stat.isFile() && !stat.isDirectory()) ||
									child.join("/") === "objects/info/alternates" ||
									child.join("/") === "objects/info/http-alternates"
								)
									throw unavailable();
								if (stat.isDirectory()) {
									if (depth >= 6) throw unavailable();
									await verifyMetadata(child, depth + 1);
								}
							}
							await scoped.verify();
						} finally {
							await scoped.close();
						}
					};
					await verifyMetadata([], 0);
					const env: Record<string, string | undefined> = {};
					for (const [key, value] of Object.entries(process.env))
						if (!key.startsWith("GIT_")) env[key] = value;
					Object.assign(env, {
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_NO_REPLACE_OBJECTS: "1",
						GIT_TERMINAL_PROMPT: "0",
					});
					const git = async (
						args: string[],
						bytes = LEGACY_ARTIFACT_IO_LIMITS.textBytes,
						allowTruncated = false,
						allowNotAncestor = false,
					) => {
						await check();
						const result = await deps.spawn({
							cmd: ["git", "--no-replace-objects", "--git-dir", fdPath(root), ...args],
							env,
							timeout: remaining(),
							signal,
							maxOutputBytes: bytes,
						});
						remaining();
						await check();
						if (
							(result.exitCode !== 0 && !(allowNotAncestor && result.exitCode === 1)) ||
							result.stderrTruncated ||
							(!allowTruncated && result.stdoutTruncated)
						)
							throw unavailable();
						return result;
					};
					const head = (await git(["rev-parse", "--verify", "refs/nf/head"])).stdout.trim();
					if (
						!/^[a-f0-9]{40}$/.test(head) ||
						(descriptor.latestSnapshotCommitSha && head !== descriptor.latestSnapshotCommitSha)
					)
						throw unavailable();
					const ancestry = await git(
						["merge-base", "--is-ancestor", sha, head],
						LEGACY_ARTIFACT_IO_LIMITS.textBytes,
						false,
						true,
					);
					if (ancestry.exitCode !== 0) {
						remaining();
						if (!(await deps.authorizeSnapshot(id, principal, sha, signal))) throw unavailable();
						await check();
					}
					const object = path ? `${sha}:${path}` : `${sha}^{tree}`;
					const kind = (await git(["cat-file", "-t", object])).stdout.trim();
					if (kind !== "tree" && kind !== "blob") throw unavailable();
					const result = await git(
						kind === "tree" ? ["ls-tree", "-z", object] : ["cat-file", "blob", object],
						LEGACY_ARTIFACT_IO_LIMITS.textBytes,
						true,
					);
					// Symlink blobs are inert Git bytes; never dereferenced in the main filesystem.
					return {
						sha,
						path,
						kind,
						encoding: "utf8",
						content: result.stdout,
						truncated: result.stdoutTruncated === true,
					};
				},
				signal,
			);
		},
		async restorePreview(id: string, principal: NarratorPrincipal, signal?: AbortSignal) {
			return boundary(
				id,
				principal,
				async (descriptor, _root, check) => {
					await deps.authorizeWrite(descriptor, principal);
					await check();
					return {
						artifactId: id,
						available: false,
						readOnly: true,
						reason:
							"Safe transactional restore is not implemented; no destination or files were changed.",
					};
				},
				signal,
			);
		},
	};
}
export const legacyMigrationArtifactIo = createLegacyMigrationArtifactIo();
