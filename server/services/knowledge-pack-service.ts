import { eq } from "drizzle-orm";
import { db } from "../db";
import { knowledgeCollections, knowledgeEntries, knowledgePacks, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { deletePackArchive, type PackArchiveFormat, savePackArchive } from "../lib/pack-archives";
import {
	type AclCollection,
	type AclEntry,
	canRead,
	type Principal,
	resolvePrincipalCaps,
} from "./knowledge-acl";

type Pack = typeof knowledgePacks.$inferSelect;

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

function nowIso(): string {
	return new Date().toISOString();
}

/** Slugify a name into a URL-safe slug (lowercase alnum + hyphens, CJK kept). */
function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 200);
	return slug || generateId(8);
}

// Columns returned by list views — never selects manifestJson (could be large).
const PACK_LIST_COLUMNS = {
	id: true,
	name: true,
	slug: true,
	description: true,
	projectId: true,
	entryId: true,
	classificationLevel: true,
	controlledTagsJson: true,
	ownerUserId: true,
	archiveFormat: true,
	archiveSize: true,
	archiveHash: true,
	uncompressedSize: true,
	status: true,
	createdAt: true,
	updatedAt: true,
} as const;

/**
 * Resolve the dual-axis ACL attributes that gate access to a pack:
 *   - linked to an entry → inherit that entry's classificationLevel + controlledTags
 *     (and the entry's collection default level)
 *   - standalone → use the pack's own fields, no collection (public default)
 * Returns an (AclEntry, AclCollection) pair usable with knowledge-acl.canRead.
 */
async function resolvePackAcl(
	pack: Pick<Pack, "id" | "entryId" | "classificationLevel" | "controlledTagsJson" | "ownerUserId">,
): Promise<{ aclEntry: AclEntry; aclCollection: AclCollection }> {
	if (pack.entryId) {
		const entry = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, pack.entryId),
		});
		if (entry) {
			const collection = await db.query.knowledgeCollections.findFirst({
				where: eq(knowledgeCollections.id, entry.collectionId),
			});
			return {
				aclEntry: {
					id: entry.id,
					collectionId: entry.collectionId,
					ownerUserId: entry.ownerUserId,
					classificationLevel: entry.classificationLevel,
					controlledTagsJson: entry.controlledTagsJson,
					reviewTagsJson: entry.reviewTagsJson,
				},
				aclCollection: {
					id: entry.collectionId,
					defaultLevel: collection?.defaultLevel ?? "public",
					// Carry the collection gate fields so a pack linked to an entry in a
					// restricted collection inherits that collection's access boundary.
					classificationLevel: collection?.classificationLevel ?? null,
					controlledTagsJson: collection?.controlledTagsJson ?? null,
					ownerUserId: collection?.ownerUserId ?? null,
				},
			};
		}
		// Linked entry vanished (set null on delete is on the column, but be defensive):
		// fall through to the pack's own fields.
	}
	// Standalone pack: synthesize an AclEntry from the pack's own ACL fields.
	return {
		aclEntry: {
			id: pack.id,
			collectionId: `pack:${pack.id}`,
			ownerUserId: pack.ownerUserId,
			classificationLevel: pack.classificationLevel,
			controlledTagsJson: pack.controlledTagsJson,
			reviewTagsJson: null,
		},
		aclCollection: { id: `pack:${pack.id}`, defaultLevel: "public" },
	};
}

/** Whether the principal may read/activate this pack (dual-axis canRead). */
async function canAccessPack(principal: Principal, pack: Pack): Promise<boolean> {
	const caps = await resolvePrincipalCaps(principal);
	const { aclEntry, aclCollection } = await resolvePackAcl(pack);
	return canRead(caps, aclEntry, aclCollection);
}

/**
 * Load a pack and assert the principal may access it. Throws NotFoundError on
 * miss OR no-access (never leak existence of packs the caller can't see).
 */
async function loadAccessiblePack(packId: string, principal: Principal): Promise<Pack> {
	const pack = await db.query.knowledgePacks.findFirst({
		where: eq(knowledgePacks.id, packId),
	});
	if (!pack) throw new NotFoundError("Knowledge pack", packId);
	if (!(await canAccessPack(principal, pack))) {
		throw new NotFoundError("Knowledge pack", packId);
	}
	return pack;
}

/**
 * Load a pack and assert the principal may MANAGE it (edit metadata / ACL, replace the
 * archive, delete). Mirrors knowledge-service.assertCanManageEntry: read-gate first, then
 * admin OR the pack's own owner. Reading a pack (canRead via clearance/tags or because it is
 * public) is NOT enough to mutate it — otherwise any user who can merely see a pack could
 * rewrite its access control, swap its archive bytes (which an agent later extracts), or
 * delete it. Unreadable → NotFound (don't leak); readable-but-not-owner → ValidationError.
 */
async function assertCanManagePack(packId: string, principal: Principal): Promise<Pack> {
	// loadAccessiblePack already throws NotFound on miss/unreadable (no existence leak).
	const pack = await loadAccessiblePack(packId, principal);
	const caps = await resolvePrincipalCaps(principal);
	if (!caps.isAdmin && pack.ownerUserId !== principal.userId) {
		throw new ValidationError("You do not have permission to manage this pack");
	}
	return pack;
}

/** List packs (project + global), then filter to those the principal may access. */
async function listPacks(
	principal: Principal,
	opts: { projectId?: string; entryId?: string; limit?: number } = {},
) {
	const limit = Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
	const rows = await db.query.knowledgePacks.findMany({
		where: (p, { and: a, eq: e, or, isNull }) => {
			const conds = [e(p.status, "active" as const)];
			if (opts.entryId) conds.push(e(p.entryId, opts.entryId));
			// Project isolation: this project's packs + global (projectId null) ones.
			if (opts.projectId) {
				const scope = or(e(p.projectId, opts.projectId), isNull(p.projectId));
				if (scope) conds.push(scope);
			}
			return a(...conds);
		},
		columns: PACK_LIST_COLUMNS,
		orderBy: (p, { desc: d }) => [d(p.updatedAt)],
		limit,
	});
	// ACL post-filter (canRead) — unreadable packs never surface or count.
	const out: typeof rows = [];
	for (const r of rows) {
		if (await canAccessPack(principal, r as Pack)) out.push(r);
	}
	return out;
}

async function getPack(packId: string, principal: Principal): Promise<Pack> {
	return loadAccessiblePack(packId, principal);
}

interface CreatePackInput {
	name: string;
	slug?: string;
	description?: string;
	projectId?: string | null;
	entryId?: string | null;
	classificationLevel?: string | null;
	controlledTags?: string[];
	manifest?: Record<string, unknown> | null;
	ownerUserId?: string | null;
	archive: File;
}

async function createPack(input: CreatePackInput): Promise<Pack> {
	if (input.projectId) {
		const proj = await db.query.projects.findFirst({
			where: eq(projects.id, input.projectId),
		});
		if (!proj) throw new ValidationError(`Project not found: ${input.projectId}`);
	}
	if (input.entryId) {
		const entry = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, input.entryId),
		});
		if (!entry) throw new ValidationError(`Knowledge entry not found: ${input.entryId}`);
	}

	const id = generateId();
	const slug = input.slug?.trim() || slugify(input.name);

	// Slug uniqueness within scope (a specific project, or the global projectId-null
	// scope). Mirrors the (project_id, slug) unique index on the table.
	const dup = await db.query.knowledgePacks.findFirst({
		where: (p, { and: a, eq: e, isNull }) =>
			a(e(p.slug, slug), input.projectId ? e(p.projectId, input.projectId) : isNull(p.projectId)),
		columns: { id: true },
	});
	if (dup) {
		throw new ValidationError(`Pack slug already exists in this scope: ${slug}`);
	}

	// Persist the archive first (validates type + size, computes hash).
	const saved = await savePackArchive(id, input.archive);

	const now = nowIso();
	try {
		const [pack] = await db
			.insert(knowledgePacks)
			.values({
				id,
				name: input.name,
				slug,
				description: input.description ?? null,
				projectId: input.projectId ?? null,
				entryId: input.entryId ?? null,
				classificationLevel: input.classificationLevel ?? null,
				controlledTagsJson: input.controlledTags ?? null,
				ownerUserId: input.ownerUserId ?? null,
				archiveFormat: saved.format,
				archiveSize: saved.size,
				archiveHash: saved.hash,
				uncompressedSize: null,
				manifestJson: input.manifest ?? null,
				status: "active",
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return pack;
	} catch (err) {
		// Roll back the on-disk archive if the row insert failed.
		deletePackArchive(id, saved.format);
		throw err;
	}
}

interface UpdatePackInput {
	name?: string;
	description?: string | null;
	entryId?: string | null;
	classificationLevel?: string | null;
	controlledTags?: string[] | null;
	manifest?: Record<string, unknown> | null;
}

async function updatePackMeta(
	packId: string,
	input: UpdatePackInput,
	principal: Principal,
): Promise<Pack> {
	const pack = await assertCanManagePack(packId, principal);
	if (input.entryId !== undefined && input.entryId !== null) {
		const entry = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, input.entryId),
		});
		if (!entry) throw new ValidationError(`Knowledge entry not found: ${input.entryId}`);
	}
	const patch: Partial<Pack> = { updatedAt: nowIso() };
	if (input.name !== undefined) patch.name = input.name;
	if (input.description !== undefined) patch.description = input.description;
	if (input.entryId !== undefined) patch.entryId = input.entryId;
	if (input.classificationLevel !== undefined)
		patch.classificationLevel = input.classificationLevel;
	if (input.controlledTags !== undefined) patch.controlledTagsJson = input.controlledTags ?? null;
	if (input.manifest !== undefined) patch.manifestJson = input.manifest;

	const [updated] = await db
		.update(knowledgePacks)
		.set(patch)
		.where(eq(knowledgePacks.id, pack.id))
		.returning();
	return updated;
}

/** Replace the archive bytes; bumps the hash so stale activations can be detected. */
async function replaceArchive(packId: string, archive: File, principal: Principal): Promise<Pack> {
	const pack = await assertCanManagePack(packId, principal);
	const oldFormat = pack.archiveFormat as PackArchiveFormat;
	const saved = await savePackArchive(pack.id, archive);
	// If the format changed (e.g. zip → tar.gz), remove the old archive file.
	if (saved.format !== oldFormat) deletePackArchive(pack.id, oldFormat);
	const [updated] = await db
		.update(knowledgePacks)
		.set({
			archiveFormat: saved.format,
			archiveSize: saved.size,
			archiveHash: saved.hash,
			uncompressedSize: null,
			updatedAt: nowIso(),
		})
		.where(eq(knowledgePacks.id, pack.id))
		.returning();
	return updated;
}

async function deletePack(packId: string, principal: Principal): Promise<{ deleted: true }> {
	const pack = await assertCanManagePack(packId, principal);
	// Activations cascade-delete via FK; the on-disk extract dirs are cleaned by the
	// activation service / startup sweep. Remove the persistent archive here.
	await db.delete(knowledgePacks).where(eq(knowledgePacks.id, pack.id));
	deletePackArchive(pack.id, pack.archiveFormat as PackArchiveFormat);
	return { deleted: true };
}

export const knowledgePackService = {
	listPacks,
	getPack,
	createPack,
	updatePackMeta,
	replaceArchive,
	deletePack,
	canAccessPack,
	loadAccessiblePack,
	assertCanManagePack,
	resolvePackAcl,
};

export type { Pack };
