import { z } from "zod/v4";
import {
	createKnowledgeCollectionSchema,
	createKnowledgeGrantSchema,
	createKnowledgeLevelSchema,
	createKnowledgeTagSchema,
	createKnowledgeTagTypeSchema,
	setUserAclSchema,
	updateKnowledgeCollectionAclSchema,
	updateKnowledgeCollectionSchema,
	updateKnowledgeEntryAclSchema,
	updateKnowledgeTagSchema,
	updateKnowledgeTagTypeSchema,
} from "../../../lib/validators";
import { knowledgeAcl } from "../../../services/knowledge-acl";
import { knowledgeService } from "../../../services/knowledge-service";
import type { ToolDefinition, ToolResult } from "../types";
import { isKnowledgeReadAction } from "./knowledge-actions";
import { looseNumber, normalizeNumber } from "./number-param";

/**
 * KnowledgeAdmin — optional tool for managing the knowledge-base ACL system
 * (classification levels, tags, tag types, grants, per-user ACL, per-entry ACL).
 *
 * Only loadable by admin users (enforced in handleLoadToolCommand). As a second
 * line of defence this tool ALSO re-checks `caps.isAdmin` at execution time from
 * ctx.userId, so even if it were somehow invoked by a non-admin it refuses.
 *
 * Write actions require user permission via ctx.requestPermission. Under
 * bypassPermissions they trigger danger reflection (see classifyDanger).
 */

function deny(message: string): ToolResult {
	return { output: message, isError: true };
}

/** Compact JSON output helper. */
function jsonOut(title: string, value: unknown): ToolResult {
	return { output: JSON.stringify(value, null, 2), title };
}

export const knowledgeAdminTool: ToolDefinition = {
	name: "KnowledgeAdmin",
	description:
		"Manage the knowledge-base structure and access-control system (admin only). " +
		"Read actions (no approval): list_collections, list_levels, list_tags, list_tag_types, list_grants, get_user_acl. " +
		"Write actions (require approval): create_collection, update_collection, create_level, delete_level, create_tag, " +
		"update_tag, delete_tag, create_tag_type, update_tag_type, delete_tag_type, create_grant, delete_grant, " +
		"set_user_acl, set_entry_acl. " +
		"Collections are top-level containers for entries — create one first (or reuse one from list_collections) to get " +
		"a collectionId, which KnowledgeReview.create_entry needs. set_collection_acl sets a collection's own access gate " +
		"(classificationLevel / controlledTags / owner) — a collection is an access boundary: a user must be able to read " +
		"the collection before any entry inside it. " +
		"Levels are the clearance ladder (rank); controlled tags are compartments; grants give a user/role a clearance " +
		"level or a tag (grantType clearance|tag|review). set_user_acl replaces a user's whole ACL; set_entry_acl sets " +
		"an entry's classificationLevel / controlledTags / reviewTags / owner.",
	parameters: z.object({
		action: z
			.enum([
				"list_collections",
				"create_collection",
				"update_collection",
				"set_collection_acl",
				"list_levels",
				"create_level",
				"delete_level",
				"list_tags",
				"create_tag",
				"update_tag",
				"delete_tag",
				"list_tag_types",
				"create_tag_type",
				"update_tag_type",
				"delete_tag_type",
				"list_grants",
				"create_grant",
				"delete_grant",
				"get_user_acl",
				"set_user_acl",
				"set_entry_acl",
			])
			.describe("The structure / ACL management action to perform"),
		id: z
			.string()
			.optional()
			.describe(
				"Target id for update_collection / set_collection_acl / delete_level / delete_tag / update_tag / delete_tag_type / update_tag_type / delete_grant",
			),
		userId: z.string().optional().describe("Target user id for get_user_acl / set_user_acl"),
		entryId: z.string().optional().describe("Target entry id for set_entry_acl"),
		collectionId: z
			.string()
			.optional()
			.describe(
				"Scope a tag listing/creation or a grant to a collection; also filters list_collections by project",
			),
		// Collection fields
		name: z
			.string()
			.optional()
			.describe("Name for create_collection / create_level / create_tag / create_tag_type"),
		slug: z.string().optional().describe("Optional explicit slug for create_collection"),
		description: z
			.string()
			.nullable()
			.optional()
			.describe("Description for create_collection / update_collection"),
		projectId: z
			.string()
			.optional()
			.describe(
				"Project id for create_collection (scopes the collection to a project; omit for a global collection) and as the list_collections filter",
			),
		// Level fields
		rank: looseNumber("Rank for create_level (higher = more restricted)"),
		label: z.string().optional().describe("Display label for create_level"),
		// Tag fields
		controlled: z
			.boolean()
			.optional()
			.describe("create_tag/update_tag: whether the tag is a controlled compartment"),
		typeId: z.string().nullable().optional().describe("Tag type id for create_tag / update_tag"),
		sortOrder: looseNumber("Sort order for create_tag_type / update_tag_type"),
		// Grant fields
		principalType: z
			.enum(["user", "role"])
			.optional()
			.describe("create_grant / list_grants principal type"),
		principalId: z
			.string()
			.optional()
			.describe("create_grant / list_grants principal id (user id or 'admin'/'user')"),
		grantType: z
			.enum(["clearance", "tag", "review"])
			.optional()
			.describe("create_grant: clearance (level) | tag (compartment) | review"),
		clearanceLevel: z
			.string()
			.optional()
			.describe("create_grant clearance level name; set_user_acl clearance level name"),
		tagId: z.string().optional().describe("create_grant tag id (for grantType tag|review)"),
		canWrite: z
			.boolean()
			.optional()
			.describe("create_grant / set_user_acl: grant write capability"),
		// set_user_acl
		tagIds: z.array(z.string()).optional().describe("set_user_acl: controlled tag ids to grant"),
		reviewTagIds: z.array(z.string()).optional().describe("set_user_acl: review tag ids to grant"),
		// set_entry_acl
		classificationLevel: z
			.string()
			.nullable()
			.optional()
			.describe("set_entry_acl: entry classification level name (null = inherit collection)"),
		controlledTags: z
			.array(z.string())
			.optional()
			.describe("set_entry_acl: controlled tag ids required to read the entry"),
		reviewTags: z
			.array(z.string())
			.optional()
			.describe("set_entry_acl: review tag ids a reviewer must hold"),
		ownerUserId: z.string().nullable().optional().describe("set_entry_acl: entry owner user id"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const a = args as Record<string, unknown>;
		const action = a.action as string;

		// Admin-only enforcement (second line of defence beyond the load gate).
		const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
		if (!caps.isAdmin) {
			return deny("KnowledgeAdmin is restricted to administrators.");
		}

		// Write actions require user permission. Reads run directly.
		if (!isKnowledgeReadAction(action)) {
			const decision = await ctx.requestPermission(
				"KnowledgeAdmin",
				{ action, ...a },
				ctx.currentToolUseId ?? "",
			);
			if (decision.behavior !== "allow") {
				return deny(
					decision.behavior === "deny" && decision.message
						? decision.message
						: "KnowledgeAdmin action was denied by the user.",
				);
			}
		}

		try {
			switch (action) {
				// ── Collections ──
				case "list_collections": {
					const result = await knowledgeService.listCollections(
						(a.projectId as string | undefined) || undefined,
						{ userId: caps.userId, role: caps.role },
					);
					return {
						...jsonOut("Knowledge collections", result),
						metadata: { tool: "KnowledgeAdmin", action, data: result },
					};
				}
				case "create_collection": {
					const parsed = createKnowledgeCollectionSchema.safeParse({
						name: a.name,
						slug: a.slug,
						description: a.description ?? undefined,
						projectId: a.projectId,
					});
					if (!parsed.success)
						return deny(`Invalid create_collection input: ${parsed.error.message}`);
					const row = await knowledgeService.createCollection({
						...parsed.data,
						ownerUserId: caps.userId,
					});
					return {
						...jsonOut("Collection created", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "update_collection": {
					if (!a.id) return deny("update_collection requires 'id'.");
					const parsed = updateKnowledgeCollectionSchema.safeParse({
						name: a.name,
						description: a.description,
					});
					if (!parsed.success)
						return deny(`Invalid update_collection input: ${parsed.error.message}`);
					const row = await knowledgeService.updateCollection(a.id as string, parsed.data);
					return {
						...jsonOut("Collection updated", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "set_collection_acl": {
					if (!a.id) return deny("set_collection_acl requires 'id'.");
					const parsed = updateKnowledgeCollectionAclSchema.safeParse({
						classificationLevel: a.classificationLevel,
						controlledTags: a.controlledTags,
						ownerUserId: a.ownerUserId,
					});
					if (!parsed.success)
						return deny(`Invalid set_collection_acl input: ${parsed.error.message}`);
					await knowledgeAcl.updateCollectionAcl(a.id as string, parsed.data);
					return {
						output: `ACL updated for collection ${a.id}.`,
						title: "Collection ACL updated",
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}

				// ── Levels ──
				case "list_levels": {
					const result = await knowledgeAcl.listLevels();
					return {
						...jsonOut("Knowledge levels", result),
						metadata: { tool: "KnowledgeAdmin", action, data: result },
					};
				}
				case "create_level": {
					const parsed = createKnowledgeLevelSchema.safeParse({
						name: a.name,
						rank: normalizeNumber(a.rank, { min: 0, max: 1000 }),
						label: a.label,
					});
					if (!parsed.success) return deny(`Invalid create_level input: ${parsed.error.message}`);
					const row = await knowledgeAcl.createLevel(parsed.data);
					return {
						...jsonOut("Level created", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "delete_level": {
					if (!a.id) return deny("delete_level requires 'id'.");
					const res = await knowledgeAcl.deleteLevel(a.id as string);
					if (!res.ok) {
						const msg =
							res.reason === "in_use"
								? "Level is still referenced by entries, collections, or grants and cannot be deleted."
								: res.reason === "builtin"
									? "The public level cannot be deleted."
									: "Level not found.";
						return deny(msg);
					}
					return {
						output: "Level deleted.",
						title: "Level deleted",
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}

				// ── Tags ──
				case "list_tags": {
					const result = await knowledgeAcl.listTags(
						(a.collectionId as string | undefined) || undefined,
					);
					return {
						...jsonOut("Knowledge tags", result),
						metadata: { tool: "KnowledgeAdmin", action, data: result },
					};
				}
				case "create_tag": {
					const parsed = createKnowledgeTagSchema.safeParse({
						name: a.name,
						collectionId: a.collectionId,
						controlled: a.controlled,
						typeId: a.typeId,
					});
					if (!parsed.success) return deny(`Invalid create_tag input: ${parsed.error.message}`);
					const row = await knowledgeAcl.createTag(parsed.data);
					return {
						...jsonOut("Tag created", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "update_tag": {
					if (!a.id) return deny("update_tag requires 'id'.");
					const parsed = updateKnowledgeTagSchema.safeParse({
						name: a.name,
						controlled: a.controlled,
						typeId: a.typeId,
					});
					if (!parsed.success) return deny(`Invalid update_tag input: ${parsed.error.message}`);
					const row = await knowledgeAcl.updateTag(a.id as string, parsed.data);
					return {
						...jsonOut("Tag updated", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "delete_tag": {
					if (!a.id) return deny("delete_tag requires 'id'.");
					await knowledgeAcl.deleteTag(a.id as string);
					return {
						output: "Tag deleted.",
						title: "Tag deleted",
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}

				// ── Tag types ──
				case "list_tag_types": {
					const result = await knowledgeAcl.listTagTypes();
					return {
						...jsonOut("Knowledge tag types", result),
						metadata: { tool: "KnowledgeAdmin", action, data: result },
					};
				}
				case "create_tag_type": {
					const parsed = createKnowledgeTagTypeSchema.safeParse({
						name: a.name,
						sortOrder: normalizeNumber(a.sortOrder, { min: 0, max: 10_000 }),
					});
					if (!parsed.success)
						return deny(`Invalid create_tag_type input: ${parsed.error.message}`);
					const row = await knowledgeAcl.createTagType(parsed.data);
					return {
						...jsonOut("Tag type created", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "update_tag_type": {
					if (!a.id) return deny("update_tag_type requires 'id'.");
					const parsed = updateKnowledgeTagTypeSchema.safeParse({
						name: a.name,
						sortOrder: normalizeNumber(a.sortOrder, { min: 0, max: 10_000 }),
					});
					if (!parsed.success)
						return deny(`Invalid update_tag_type input: ${parsed.error.message}`);
					const row = await knowledgeAcl.updateTagType(a.id as string, parsed.data);
					return {
						...jsonOut("Tag type updated", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "delete_tag_type": {
					if (!a.id) return deny("delete_tag_type requires 'id'.");
					const res = await knowledgeAcl.deleteTagType(a.id as string);
					if (!res.ok) {
						return deny(
							res.reason === "builtin"
								? "Builtin tag type cannot be deleted."
								: "Tag type not found.",
						);
					}
					return {
						output: "Tag type deleted.",
						title: "Tag type deleted",
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}

				// ── Grants ──
				case "list_grants": {
					const result = await knowledgeAcl.listGrants({
						principalType: (a.principalType as string | undefined) || undefined,
						principalId: (a.principalId as string | undefined) || undefined,
					});
					return {
						...jsonOut("Knowledge grants", result),
						metadata: { tool: "KnowledgeAdmin", action, data: result },
					};
				}
				case "create_grant": {
					const parsed = createKnowledgeGrantSchema.safeParse({
						collectionId: a.collectionId,
						principalType: a.principalType,
						principalId: a.principalId,
						grantType: a.grantType,
						clearanceLevel: a.clearanceLevel,
						tagId: a.tagId,
						canWrite: a.canWrite,
					});
					if (!parsed.success) return deny(`Invalid create_grant input: ${parsed.error.message}`);
					const row = await knowledgeAcl.createGrant(parsed.data);
					return {
						...jsonOut("Grant created", row),
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}
				case "delete_grant": {
					if (!a.id) return deny("delete_grant requires 'id'.");
					await knowledgeAcl.deleteGrant(a.id as string);
					return {
						output: "Grant deleted.",
						title: "Grant deleted",
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}

				// ── Per-user ACL ──
				case "get_user_acl": {
					if (!a.userId) return deny("get_user_acl requires 'userId'.");
					const result = await knowledgeAcl.getUserAcl(a.userId as string);
					return {
						...jsonOut(`ACL for user ${a.userId}`, result),
						metadata: { tool: "KnowledgeAdmin", action, data: result },
					};
				}
				case "set_user_acl": {
					if (!a.userId) return deny("set_user_acl requires 'userId'.");
					const parsed = setUserAclSchema.safeParse({
						clearanceLevel: a.clearanceLevel,
						tagIds: a.tagIds,
						reviewTagIds: a.reviewTagIds,
						canWrite: a.canWrite,
					});
					if (!parsed.success) return deny(`Invalid set_user_acl input: ${parsed.error.message}`);
					await knowledgeAcl.setUserAcl(a.userId as string, parsed.data);
					return {
						output: `ACL updated for user ${a.userId}.`,
						title: "User ACL updated",
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}

				// ── Per-entry ACL ──
				case "set_entry_acl": {
					if (!a.entryId) return deny("set_entry_acl requires 'entryId'.");
					const parsed = updateKnowledgeEntryAclSchema.safeParse({
						classificationLevel: a.classificationLevel,
						controlledTags: a.controlledTags,
						reviewTags: a.reviewTags,
						ownerUserId: a.ownerUserId,
					});
					if (!parsed.success) return deny(`Invalid set_entry_acl input: ${parsed.error.message}`);
					await knowledgeService.updateEntryAcl(a.entryId as string, parsed.data);
					return {
						output: `ACL updated for entry ${a.entryId}.`,
						title: "Entry ACL updated",
						metadata: { tool: "KnowledgeAdmin", action, success: true },
					};
				}

				default:
					return deny(`Unknown action: ${action}`);
			}
		} catch (err) {
			return deny(
				`KnowledgeAdmin ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
};
