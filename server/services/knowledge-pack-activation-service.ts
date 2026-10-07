import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { lstat, mkdir, opendir, realpath, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { knowledgePackActivations } from "../db/schema";
import { localBackend } from "../lib/agent/execution/registry";
import type { ToolContext } from "../lib/agent/types";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	getPacksExtractRoot,
	maxPackUncompressedBytes,
	type PackArchiveFormat,
	packArchivePath,
	packExtractDir,
} from "../lib/pack-archives";
import type { WorkspaceFileAccess } from "../lib/plan-file-path";
import { isInsidePath } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { extractZipArchive } from "../lib/zip-archive";
import { executionPolicyEngine } from "./execution-policy/engine";
import { knowledgeWriteStore } from "./knowledge/store";
import type { Principal } from "./knowledge-acl";
import { knowledgeAcl } from "./knowledge-acl";
import { knowledgePackService, type Pack } from "./knowledge-pack-service";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";

/** Hard timeout for an extraction subprocess. */
const EXTRACT_TIMEOUT_MS = 60_000;
/** Output cap for extraction stdout/stderr (we only need error text). */
const EXTRACT_MAX_OUTPUT_BYTES = 256 * 1024;
/** Max files listed back to the agent on activation (keeps the tool output bounded). */
const MAX_LISTED_FILES = 200;

export interface ActivationResult {
	packId: string;
	extractDir: string;
	files: string[];
	manifest: unknown;
	reused: boolean;
}

/** Published pack Read is independent from the selected workspace's approved Write. */
export async function createPublishedPackSourceAccess(
	ctx: ToolContext,
	pack: Pack,
	stagingRoot?: string,
): Promise<WorkspaceFileAccess> {
	if (!ctx.userId || !ctx.recheckAuthorization)
		throw new ValidationError("Pack source needs its real actor and live authorization fence");
	const archive = packArchivePath(pack.id, pack.archiveFormat as PackArchiveFormat);
	if (stagingRoot && !isInsidePath(getPacksExtractRoot(), stagingRoot))
		throw new ValidationError("Pack staging root is not a published server resource");
	const generation = localBackend.runtimeGeneration;
	const check = async () => {
		ctx.signal.throwIfAborted();
		await ctx.recheckAuthorization?.();
		ctx.assertWorkspaceCurrent?.();
		const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
		const current = await knowledgePackService.loadAccessiblePack(pack.id, {
			userId: caps.userId,
			role: caps.role,
		});
		if (current.archiveHash !== pack.archiveHash || current.archiveFormat !== pack.archiveFormat)
			throw new ValidationError("Published pack version changed before source Read");
		const oauth = await resolveOAuthNarratorRuntimePolicy(ctx.narratorId, ctx.userId);
		if (
			oauth &&
			(!oauth.allowedTools.has("Read") ||
				!oauth.allowLocalExecution ||
				!["readOnly", "readWrite"].includes(oauth.policy.deviceAccess.host))
		)
			throw new ValidationError("Published pack exceeds live OAuth host Read authority");
		if (localBackend.runtimeGeneration !== generation)
			throw new ValidationError("Pack source generation changed");
	};
	await check();
	return {
		backend: localBackend,
		runtimeGeneration: generation,
		signal: ctx.signal,
		async authorizeRead(canonicalPath, backend, signal) {
			if (
				backend !== localBackend ||
				(!backend.paths.equals(canonicalPath, archive) &&
					(!stagingRoot || !backend.paths.contains(stagingRoot, canonicalPath)))
			)
				return false;
			await check();
			signal?.throwIfAborted();
			const identity = await backend.resolvePathIdentity(canonicalPath, {
				signal: signal ?? ctx.signal,
				timeoutMs: 5_000,
			});
			if (
				!backend.paths.equals(identity.canonicalPath, canonicalPath) ||
				identity.runtimeGeneration !== generation
			)
				return false;
			const policy = await executionPolicyEngine.compile(
				ctx.narratorId,
				{
					backend,
					paths: backend.paths,
					deviceClass: "host",
					target: {
						deviceId: "local",
						backendKind: "local",
						cwd: stagingRoot ?? backend.paths.dirname(archive),
						lexicalPath: canonicalPath,
						canonicalPath,
						pathFlavor: backend.pathFlavor,
						runtimeGeneration: generation,
						selectionSource: "explicit",
					},
				},
				[],
				signal ?? ctx.signal,
			);
			if (policy.evaluatePath({ path: canonicalPath, operation: "read" }).decision === "deny")
				return false;
			await check();
			return true;
		},
	};
}

/** Build the extraction command for tar.gz archives (zip is handled in-process). */
function tarExtractCmd(archive: string, destDir: string): string[] {
	return ["tar", "-xzf", archive, "-C", destDir];
}

/**
 * Extract a pack archive into destDir.
 *
 * zip goes through the in-process reader (`node:zlib`) because Windows has no
 * `unzip` binary; tar.gz still shells out to `tar`, which ships with Windows 10+
 * as well as every supported unix.
 */
async function extractArchive(
	format: PackArchiveFormat,
	archive: string,
	destDir: string,
): Promise<void> {
	if (format === "zip") {
		const limits = { maxTotalBytes: maxPackUncompressedBytes() };
		// Symlinks are rejected here for the same reason inspectExtraction rejects
		// them: they can point outside the sandbox at use time.
		await extractZipArchive(archive, destDir, { limits, rejectSymlinks: true });
		return;
	}
	const res = await safeSpawn({
		cmd: tarExtractCmd(archive, destDir),
		timeout: EXTRACT_TIMEOUT_MS,
		maxOutputBytes: EXTRACT_MAX_OUTPUT_BYTES,
	});
	if (res.exitCode !== 0) {
		throw new ValidationError(
			`Pack extraction failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`,
		);
	}
}

/**
 * Walk the extracted tree and (a) enforce zip-slip containment (every path stays
 * inside destDir), (b) sum uncompressed size against the cap, (c) collect a bounded
 * list of relative file paths for the agent. Throws on containment/size violation.
 */
function inspectExtraction(destDir: string): { files: string[]; totalBytes: number } {
	const files: string[] = [];
	let totalBytes = 0;
	const cap = maxPackUncompressedBytes();

	const walk = (dir: string, depth: number) => {
		if (depth > 12) return; // defensive recursion bound
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = resolve(dir, entry.name);
			// zip-slip / symlink-escape guard: the resolved real path must stay in destDir.
			if (!isInsidePath(destDir, full)) {
				throw new ValidationError(
					"Pack archive contains a path that escapes the extraction directory (zip-slip).",
				);
			}
			if (entry.isSymbolicLink()) {
				// Reject symlinks outright — they can point outside the sandbox at use time.
				throw new ValidationError("Pack archive contains a symlink, which is not allowed.");
			}
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (entry.isFile()) {
				try {
					totalBytes += statSync(full).size;
				} catch {
					// ignore stat failures on individual files
				}
				if (totalBytes > cap) {
					throw new ValidationError(
						`Pack uncompressed size exceeds the limit (${(cap / 1024 / 1024).toFixed(0)}MB).`,
					);
				}
				if (files.length < MAX_LISTED_FILES) {
					files.push(relative(destDir, full).split(sep).join("/"));
				}
			}
		}
	};

	walk(destDir, 0);
	return { files, totalBytes };
}

/** Controlled server staging only; never grants a host whitelist or mutates the workspace. */
export async function stagePublishedPack(context: ToolContext, pack: Pack) {
	const ctx = {
		...context,
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]),
	};
	const root = resolve(getPacksExtractRoot(), ".materialize-stage", generateId());
	const access = await createPublishedPackSourceAccess(ctx, pack, root);
	const archive = packArchivePath(pack.id, pack.archiveFormat as PackArchiveFormat);
	if ((await access.authorizeRead?.(archive, localBackend, ctx.signal)) !== true)
		throw new ValidationError("Published pack archive Read is denied");
	await mkdir(root, { recursive: true });
	try {
		await extractArchive(pack.archiveFormat as PackArchiveFormat, archive, root);
		const canonicalRoot = await realpath(root);
		if (canonicalRoot !== root) throw new ValidationError("Pack staging root changed");
		const files: Array<{ relativePath: string; path: string; sizeBytes: number }> = [];
		let bytes = 0;
		let entries = 0;
		const cap = Math.min(maxPackUncompressedBytes(), 64 * 1024 * 1024);
		const walk = async (directory: string, depth: number): Promise<void> => {
			ctx.signal.throwIfAborted();
			if (depth > 12) throw new ValidationError("Pack staging depth exceeds its budget");
			for await (const entryName of await opendir(directory)) {
				if (++entries > 1000) throw new ValidationError("Pack staging entry budget exceeded");
				const path = resolve(directory, entryName.name);
				if (!isInsidePath(root, path)) throw new ValidationError("Pack resource escaped staging");
				const entry = await lstat(path);
				if (entry.isSymbolicLink()) throw new ValidationError("Pack symlink is not materializable");
				if (entry.isDirectory()) await walk(path, depth + 1);
				else if (entry.isFile()) {
					if ((await access.authorizeRead?.(path, localBackend, ctx.signal)) !== true)
						throw new ValidationError("Pack resource source Read is denied");
					bytes += entry.size;
					if (bytes > cap || files.length >= 80)
						throw new ValidationError("Pack data/proof metadata budget exceeded");
					files.push({
						path,
						relativePath: relative(root, path).split(sep).join("/"),
						sizeBytes: entry.size,
					});
				} else throw new ValidationError("Pack contains an unsupported resource kind");
			}
		};
		await walk(root, 0);
		return {
			root,
			files,
			access,
			async dispose() {
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

/** Explicit native installation; partial evidence is never a ready activation or whitelist. */
async function materialize(
	ctx: ToolContext,
	packId: string,
	principal: Principal,
): Promise<ActivationResult> {
	if (!ctx.userId || !ctx.workspaceContext || !/^[A-Za-z0-9_-]{1,128}$/.test(packId))
		throw new ValidationError(
			"Pack materialization needs its actual actor, frozen workspace and opaque id",
		);
	const { createApprovedWorkspaceArtifactAccess } = await import("./workspace-artifact-access");
	const { withWorkspaceAttachmentTarget } = await import("./workspace-attachment-runtime");
	const { createWorkspaceAttachmentFromStagedFile } = await import(
		"../lib/workspace-attachment-io"
	);
	const access = createApprovedWorkspaceArtifactAccess(ctx);
	const workspace = Object.freeze({ ...ctx.workspaceContext });
	const backend = access.backend;
	const generation = backend.runtimeGeneration;
	const lexicalRoot = backend.paths.resolve(workspace.cwd, `.narrafork/packs/${packId}`);
	const root = await backend.resolvePathIdentity(lexicalRoot, {
		signal: ctx.signal,
		timeoutMs: 5_000,
	});
	const approved = ctx.executionPlan?.endpoints.some(
		(endpoint) =>
			endpoint.operation === "write" &&
			endpoint.target.deviceId === backend.deviceId &&
			endpoint.target.runtimeGeneration === generation &&
			endpoint.target.canonicalPath &&
			backend.paths.equals(endpoint.target.canonicalPath, root.canonicalPath),
	);
	if (!approved || (await access.authorizeWrite(root.canonicalPath, backend, ctx.signal)) !== true)
		throw new ValidationError("Pack installation is outside its exact frozen Write root");
	const pack = await knowledgePackService.loadAccessiblePack(packId, principal);
	const staged = await stagePublishedPack(ctx, pack);
	const activationId = generateId();
	const evidenceIds: string[] = [];
	const files: NonNullable<
		import("./knowledge/write-store").RecordPackActivationWrite["targetBindingJson"]
	>["files"] = [];
	const makeBinding = (state: "complete" | "partial", retainedFiles = files) => ({
		version: 1 as const,
		materializationState: state,
		workspace,
		extractDir: root.canonicalPath,
		runtimeGeneration: generation,
		actorUserId: ctx.userId ?? null,
		files: retainedFiles,
	});
	const persistPartial = async (retainedFiles: typeof files, id = generateId()) => {
		await knowledgeWriteStore.recordPartialPackMaterialization({
			activationId: id,
			packId,
			narratorId: ctx.narratorId,
			extractDir: root.canonicalPath,
			archiveHash: pack.archiveHash,
			targetBindingJson: makeBinding("partial", retainedFiles),
			now: new Date().toISOString(),
		});
		evidenceIds.push(id);
	};
	try {
		await persistPartial([], activationId);
		for (const [index, file] of staged.files.entries()) {
			const lexicalPath = backend.paths.resolve(root.canonicalPath, file.relativePath);
			const identity = await backend.resolvePathIdentity(lexicalPath, {
				signal: ctx.signal,
				timeoutMs: 5_000,
			});
			if (!backend.paths.contains(root.canonicalPath, identity.canonicalPath))
				throw new ValidationError("Pack resource escaped its approved installation root");
			const operationId = `pack_${activationId}_${index}`;
			const authorize = async () => {
				ctx.signal.throwIfAborted();
				if (
					backend.runtimeGeneration !== generation ||
					(await access.authorizeWrite(identity.canonicalPath, backend, ctx.signal)) !== true ||
					(await staged.access.authorizeRead?.(file.path, staged.access.backend, ctx.signal)) !==
						true
				)
					throw new ValidationError(
						"Pack source Read or exact destination Write authority changed",
					);
			};
			const receipt = await withWorkspaceAttachmentTarget({
				narratorId: ctx.narratorId,
				userId: ctx.userId,
				access,
				admitted: { lexicalPath, canonicalPath: identity.canonicalPath, operationId },
				signal: ctx.signal,
				body: async (target) =>
					createWorkspaceAttachmentFromStagedFile({
						target,
						operationId,
						path: backend.paths
							.relative(target.binding.root, identity.canonicalPath)
							.split("\\")
							.join("/"),
						stagedFilePath: file.path,
						sizeBytes: file.sizeBytes,
						signal: ctx.signal,
						authorize,
					}),
			});
			const recorded = { relativePath: file.relativePath, receipt };
			files.push(recorded);
			await persistPartial([recorded]);
		}
		await knowledgeWriteStore.recordPackActivation({
			activationId: generateId(),
			whitelistDirId: generateId(),
			narratorId: ctx.narratorId,
			packId,
			extractDir: root.canonicalPath,
			archiveHash: pack.archiveHash,
			targetKind: backend.kind === "local" ? "host" : "device",
			targetValue: backend.deviceId,
			pathFlavor: workspace.pathFlavor,
			targetBindingJson: makeBinding("complete"),
			now: new Date().toISOString(),
		});
		for (const id of evidenceIds)
			await knowledgeWriteStore.releasePackActivation({
				activationId: id,
				whitelistDirId: null,
				now: new Date().toISOString(),
			});
		return {
			packId,
			extractDir: root.canonicalPath,
			files: staged.files.map((file) => file.relativePath),
			manifest: pack.manifestJson ?? null,
			reused: false,
		};
	} finally {
		await staged.dispose();
	}
}

/** Find an active activation row for (narrator, pack), if any. */
async function findActiveActivation(narratorId: string, packId: string) {
	return db.query.knowledgePackActivations.findFirst({
		columns: {
			id: true,
			packId: true,
			narratorId: true,
			extractDir: true,
			whitelistDirId: true,
			archiveHash: true,
			status: true,
			createdAt: true,
		},
		extras: {
			hasTargetBinding: sql<boolean>`${knowledgePackActivations.targetBindingJson} IS NOT NULL`.as(
				"has_target_binding",
			),
		},
		where: and(
			eq(knowledgePackActivations.narratorId, narratorId),
			eq(knowledgePackActivations.packId, packId),
			eq(knowledgePackActivations.status, "active"),
		),
	});
}

/**
 * Activate a pack for a narrator: ACL-check → extract into an isolated dir →
 * register that dir as a narrator whitelist entry (readWrite) → record the activation.
 *
 * Idempotent: an existing active activation whose archiveHash matches the current
 * pack is reused (no re-extraction). A stale activation (archive replaced) is
 * released and re-created.
 */
async function activate(
	narratorId: string,
	packId: string,
	principal: Principal,
	ctx?: ToolContext,
): Promise<ActivationResult> {
	// ACL gate (throws NotFound if not accessible — never leaks existence).
	const pack: Pack = await knowledgePackService.loadAccessiblePack(packId, principal);
	if (ctx) {
		const source = await createPublishedPackSourceAccess(ctx, pack);
		if (
			(await source.authorizeRead?.(
				packArchivePath(pack.id, pack.archiveFormat as PackArchiveFormat),
				source.backend,
				ctx.signal,
			)) !== true
		)
			throw new ValidationError("Pack source host Read is denied");
	}

	const existing = await findActiveActivation(narratorId, packId);
	if (existing?.hasTargetBinding)
		throw new ValidationError(
			"Existing pack activation belongs to its original workspace source; it cannot be reused as a host extraction",
		);
	const destDir = packExtractDir(narratorId, packId);

	// Reuse path: same archive hash + extract dir still present → return as-is.
	if (existing && existing.archiveHash === pack.archiveHash && existsSync(destDir)) {
		const { files } = inspectExtraction(destDir);
		return {
			packId,
			extractDir: destDir,
			files,
			manifest: pack.manifestJson ?? null,
			reused: true,
		};
	}

	// Stale activation (archive changed or dir missing): release it first.
	if (existing) {
		await releaseActivation(existing.id, existing.whitelistDirId, destDir);
	}

	// Fresh extraction: clean any leftover dir, then re-create.
	if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
	mkdirSync(destDir, { recursive: true });

	const archive = packArchivePath(pack.id, pack.archiveFormat as PackArchiveFormat);
	if (!existsSync(archive)) {
		rmSync(destDir, { recursive: true, force: true });
		throw new ValidationError("Pack archive file is missing on disk; re-upload the pack.");
	}

	try {
		await extractArchive(pack.archiveFormat as PackArchiveFormat, archive, destDir);
	} catch (err) {
		rmSync(destDir, { recursive: true, force: true });
		if (err instanceof ValidationError) throw err;
		throw new ValidationError(
			`Pack extraction error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Post-extraction safety: zip-slip containment + size cap + file listing.
	let files: string[];
	try {
		files = inspectExtraction(destDir).files;
	} catch (err) {
		// Any containment/size violation → wipe the extraction, refuse.
		rmSync(destDir, { recursive: true, force: true });
		throw err;
	}

	// Register the extract dir as a narrator whitelist entry (readWrite) AND record the
	// activation as ONE store operation: the agent must never hold a whitelist entry
	// whose activation record is missing (or vice versa). This is the single mechanism
	// that grants the agent access — file tools + safe bash commands targeting this dir
	// are auto-allowed by resolvePermissionDecision. Script execution (./x.sh) still
	// triggers user approval via isPathExecution (intentional).
	const whitelistDirId = generateId();
	const now = new Date().toISOString();
	const activationId = generateId();

	await knowledgeWriteStore.recordPackActivation({
		activationId,
		whitelistDirId,
		packId,
		narratorId,
		extractDir: destDir,
		archiveHash: pack.archiveHash,
		now,
	});

	logger.info("Pack activated", { packId, narratorId, files: files.length });
	return {
		packId,
		extractDir: destDir,
		files,
		manifest: pack.manifestJson ?? null,
		reused: false,
	};
}

/** Release a single activation: delete dir, then drop whitelist row + mark released atomically. */
async function releaseActivation(
	activationId: string,
	whitelistDirId: string | null,
	extractDir: string,
	ctx?: ToolContext,
): Promise<void> {
	const origin = await db
		.select({
			hasTargetBinding: sql<boolean>`${knowledgePackActivations.targetBindingJson} IS NOT NULL`,
		})
		.from(knowledgePackActivations)
		.where(eq(knowledgePackActivations.id, activationId))
		.limit(1);
	if (origin[0]?.hasTargetBinding) {
		if (
			!ctx?.userId ||
			!ctx.recheckAuthorization ||
			ctx.runtimePolicy?.tools.readOnly ||
			ctx.planFileBinding ||
			ctx.planFileId
		)
			throw new ValidationError("Pack cleanup original source authority is unavailable; retained");
		const raw = await db
			.select({
				binding: sql<
					string | null
				>`case when length(cast(${knowledgePackActivations.targetBindingJson} as text)) <= ${128 * 1024} then ${knowledgePackActivations.targetBindingJson} else null end`,
			})
			.from(knowledgePackActivations)
			.where(eq(knowledgePackActivations.id, activationId))
			.limit(1);
		const binding =
			typeof raw[0]?.binding === "string"
				? (JSON.parse(raw[0].binding) as NonNullable<
						import("./knowledge/write-store").RecordPackActivationWrite["targetBindingJson"]
					>)
				: null;
		const { isWorkspaceAttachmentProof, cleanupWorkspaceAttachmentByProof } = await import(
			"../lib/workspace-attachment-io"
		);
		if (
			!binding ||
			binding.actorUserId !== ctx.userId ||
			binding.extractDir !== extractDir ||
			binding.files.length > 1000 ||
			binding.files.some((file) => !isWorkspaceAttachmentProof(file.receipt))
		)
			throw new ValidationError("Pack cleanup proof/original creator is unavailable; retained");
		const { createNarratorWorkspaceAttachmentAccess } = await import("./workspace-artifact-access");
		const { withWorkspaceAttachmentTarget } = await import("./workspace-attachment-runtime");
		const access = createNarratorWorkspaceAttachmentAccess(ctx.narratorId, binding.workspace, {
			userId: ctx.userId,
			signal: ctx.signal,
			authorizationGuard: ctx.recheckAuthorization,
		});
		if (access.backend.runtimeGeneration !== binding.runtimeGeneration)
			throw new ValidationError(
				"Pack source generation changed; retained without borrowing current cwd",
			);
		for (const file of binding.files) {
			const canonicalPath = access.backend.paths.resolve(
				file.receipt.binding.root,
				file.receipt.path,
			);
			if (
				!access.backend.paths.contains(extractDir, canonicalPath) ||
				!access.backend.paths.equals(
					canonicalPath,
					access.backend.paths.resolve(extractDir, file.relativePath),
				)
			)
				throw new ValidationError("Pack proof path does not match original installation");
			const operationId = `pack_cleanup_${generateId()}`;
			const result = await withWorkspaceAttachmentTarget({
				narratorId: ctx.narratorId,
				userId: ctx.userId,
				access,
				admitted: { canonicalPath, lexicalPath: canonicalPath, operationId },
				signal: ctx.signal,
				body: (target) =>
					cleanupWorkspaceAttachmentByProof({
						target,
						proof: file.receipt,
						operationId,
						signal: ctx.signal,
						authorize: async () => {
							await ctx.recheckAuthorization?.();
							if ((await access.authorizeWrite(canonicalPath, access.backend, ctx.signal)) !== true)
								throw new ValidationError("Original pack cleanup Write denied");
						},
					}),
			});
			if (result.outcome !== "deleted" && result.outcome !== "already_deleted")
				throw new ValidationError(
					"Pack resource changed or cleanup is unknown; retained with original evidence",
				);
		}
		await knowledgeWriteStore.releasePackActivation({
			activationId,
			whitelistDirId,
			now: new Date().toISOString(),
		});
		return;
	}
	// The directory goes first: if removing it fails, nothing has changed and the
	// activation is still intact. The two database writes are one store operation, so
	// the whitelist row and the released marker can never disagree.
	if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
	await knowledgeWriteStore.releasePackActivation({
		activationId,
		whitelistDirId,
		now: new Date().toISOString(),
	});
}

/** Deactivate a pack for a narrator (idempotent): release the active activation if any. */
async function deactivate(
	narratorId: string,
	packId: string,
	ctx?: ToolContext,
): Promise<{ released: boolean }> {
	const existing = await findActiveActivation(narratorId, packId);
	if (!existing) return { released: false };
	await releaseActivation(existing.id, existing.whitelistDirId, existing.extractDir, ctx);
	logger.info("Pack deactivated", { packId, narratorId });
	return { released: true };
}

/** List a narrator's active activations (with pack name for display). */
async function listActive(narratorId: string) {
	const rows = await db.query.knowledgePackActivations.findMany({
		columns: { id: true, packId: true, extractDir: true, whitelistDirId: true, createdAt: true },
		limit: 201,
		where: and(
			eq(knowledgePackActivations.narratorId, narratorId),
			eq(knowledgePackActivations.status, "active"),
		),
		orderBy: (a, { desc: d }) => [d(a.createdAt)],
	});
	if (rows.length === 0) return [];
	const packIds = [...new Set(rows.map((r) => r.packId))];
	const packs = await db.query.knowledgePacks.findMany({
		where: (p, { inArray }) => inArray(p.id, packIds),
		columns: { id: true, name: true, slug: true },
	});
	const byId = new Map(packs.map((p) => [p.id, p]));
	return rows.map((r) => ({
		id: r.id,
		packId: r.packId,
		packName: byId.get(r.packId)?.name ?? r.packId,
		extractDir: r.extractDir,
		createdAt: r.createdAt,
	}));
}

/** Release ALL active activations for a narrator (called when the narrator is removed). */
async function cleanupNarrator(narratorId: string): Promise<void> {
	const rows = await db.query.knowledgePackActivations.findMany({
		columns: { id: true, packId: true, extractDir: true, whitelistDirId: true, createdAt: true },
		limit: 201,
		where: and(
			eq(knowledgePackActivations.narratorId, narratorId),
			eq(knowledgePackActivations.status, "active"),
		),
	});
	for (const r of rows) {
		await releaseActivation(r.id, r.whitelistDirId, r.extractDir);
	}
	// Also remove the narrator's extraction subtree wholesale (belt-and-suspenders).
	const narratorRoot = resolve(getPacksExtractRoot(), narratorId);
	if (existsSync(narratorRoot)) rmSync(narratorRoot, { recursive: true, force: true });
}

/**
 * Startup sweep: clear all on-disk extractions and mark every active activation as
 * released. Extracted dirs are transient (don't survive a restart); the persistent
 * pack-archives dir is left untouched. Mirrors shares.cleanupStaleShares.
 */
function cleanupStalePacks(): void {
	try {
		const root = getPacksExtractRoot();
		const entries = readdirSync(root, { withFileTypes: true });
		let cleaned = 0;
		for (const entry of entries) {
			if (entry.isDirectory()) {
				rmSync(resolve(root, entry.name), { recursive: true, force: true });
				cleaned++;
			}
		}
		// Mark all still-"active" activation rows as released (their dirs are now gone).
		db.update(knowledgePackActivations)
			.set({ status: "released", releasedAt: new Date().toISOString() })
			.where(
				and(
					eq(knowledgePackActivations.status, "active"),
					isNull(knowledgePackActivations.targetBindingJson),
				),
			)
			.run();
		if (cleaned > 0) {
			logger.info("Cleaned up stale pack extractions from previous run", { count: cleaned });
		}
	} catch {
		// Non-fatal — dir may not exist yet.
	}
}

export const packActivationService = {
	activate,
	materialize,
	deactivate,
	listActive,
	cleanupNarrator,
	cleanupStalePacks,
};
