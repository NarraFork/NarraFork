import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { knowledgePackActivations, narratorWhitelistDirs } from "../db/schema";
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
import { isInsidePath } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import type { Principal } from "./knowledge-acl";
import { knowledgePackService, type Pack } from "./knowledge-pack-service";

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

/** Build the extraction command for a given archive format. */
function extractCmd(format: PackArchiveFormat, archive: string, destDir: string): string[] {
	if (format === "tar.gz") return ["tar", "-xzf", archive, "-C", destDir];
	// zip: -o overwrite without prompting, -q quiet, -d target dir.
	return ["unzip", "-o", "-q", archive, "-d", destDir];
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

/** Remove a whitelist row by id (best-effort). */
async function removeWhitelistRow(whitelistDirId: string | null): Promise<void> {
	if (!whitelistDirId) return;
	await db.delete(narratorWhitelistDirs).where(eq(narratorWhitelistDirs.id, whitelistDirId));
}

/** Find an active activation row for (narrator, pack), if any. */
async function findActiveActivation(narratorId: string, packId: string) {
	return db.query.knowledgePackActivations.findFirst({
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
): Promise<ActivationResult> {
	// ACL gate (throws NotFound if not accessible — never leaks existence).
	const pack: Pack = await knowledgePackService.loadAccessiblePack(packId, principal);

	const existing = await findActiveActivation(narratorId, packId);
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
		const res = await safeSpawn({
			cmd: extractCmd(pack.archiveFormat as PackArchiveFormat, archive, destDir),
			timeout: EXTRACT_TIMEOUT_MS,
			maxOutputBytes: EXTRACT_MAX_OUTPUT_BYTES,
		});
		if (res.exitCode !== 0) {
			throw new ValidationError(
				`Pack extraction failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`,
			);
		}
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

	// Register the extract dir as a narrator whitelist entry (readWrite). This is the
	// single mechanism that grants the agent access — file tools + safe bash commands
	// targeting this dir are auto-allowed by resolvePermissionDecision. Script execution
	// (./x.sh) still triggers user approval via isPathExecution (intentional).
	const whitelistDirId = generateId();
	const now = new Date().toISOString();
	const activationId = generateId();

	await db.transaction((tx) => {
		// Upsert-style: a unique (narratorId, path) index exists, so delete any prior row
		// for this exact path first (e.g. left over from an unclean release).
		tx.delete(narratorWhitelistDirs)
			.where(
				and(
					eq(narratorWhitelistDirs.narratorId, narratorId),
					eq(narratorWhitelistDirs.path, destDir),
				),
			)
			.run();
		tx.insert(narratorWhitelistDirs)
			.values({
				id: whitelistDirId,
				narratorId,
				path: destDir,
				accessLevel: "readWrite",
				enabled: true,
				createdAt: now,
			})
			.run();
		tx.insert(knowledgePackActivations)
			.values({
				id: activationId,
				packId,
				narratorId,
				extractDir: destDir,
				whitelistDirId,
				archiveHash: pack.archiveHash,
				status: "active",
				createdAt: now,
			})
			.run();
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

/** Release a single activation: remove whitelist row, delete dir, mark released. */
async function releaseActivation(
	activationId: string,
	whitelistDirId: string | null,
	extractDir: string,
): Promise<void> {
	await removeWhitelistRow(whitelistDirId);
	if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
	await db
		.update(knowledgePackActivations)
		.set({ status: "released", releasedAt: new Date().toISOString() })
		.where(eq(knowledgePackActivations.id, activationId));
}

/** Deactivate a pack for a narrator (idempotent): release the active activation if any. */
async function deactivate(narratorId: string, packId: string): Promise<{ released: boolean }> {
	const existing = await findActiveActivation(narratorId, packId);
	if (!existing) return { released: false };
	await releaseActivation(existing.id, existing.whitelistDirId, existing.extractDir);
	logger.info("Pack deactivated", { packId, narratorId });
	return { released: true };
}

/** List a narrator's active activations (with pack name for display). */
async function listActive(narratorId: string) {
	const rows = await db.query.knowledgePackActivations.findMany({
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
			.where(eq(knowledgePackActivations.status, "active"))
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
	deactivate,
	listActive,
	cleanupNarrator,
	cleanupStalePacks,
};
