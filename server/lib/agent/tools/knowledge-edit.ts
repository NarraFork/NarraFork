import { z } from "zod/v4";
import {
	addKnowledgeRevisionSchema,
	createKnowledgeEntrySchema,
	updateKnowledgeEntrySchema,
} from "../../../lib/validators";
import { knowledgeAcl, type Principal } from "../../../services/knowledge-acl";
import { knowledgeBranchService } from "../../../services/knowledge-branch-service";
import { knowledgeService } from "../../../services/knowledge-service";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

/**
 * KnowledgeCreate / KnowledgeEdit — the contributor-facing knowledge tools.
 *
 * Model: every user has a PERSONAL knowledge library that sits beside the global base
 * (like a fork). You create/edit personal entries freely; to share them you PUBLISH (a
 * review-gated merge into the global base). Users with write permission on the target
 * may instead write the global base directly (`direct: true`).
 *
 * Authorization is enforced in the service layer per action; the tools only require user
 * permission for writes (and the publish/global-write paths trigger danger reflection
 * under bypassPermissions — see classifyDanger).
 */

async function principalOf(ctx: ToolContext): Promise<Principal> {
	const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
	return { userId: caps.userId, role: caps.role };
}

function deny(message: string): ToolResult {
	return { output: message, isError: true };
}

async function assertCollectionProjectContext(
	collectionId: string,
	projectId: string | null | undefined,
): Promise<void> {
	if (!projectId) return;
	const collection = await knowledgeService.getCollection(collectionId);
	if (collection.projectId && collection.projectId !== projectId) {
		throw new Error("Knowledge resource is outside the narrator project context");
	}
}

async function assertKnowledgeProjectContext(
	principal: Principal,
	ctx: ToolContext,
	input: Record<string, unknown>,
): Promise<void> {
	if (!ctx.projectId) return;
	for (const key of ["collectionId", "collectionTargetId"] as const) {
		const collectionId = input[key];
		if (typeof collectionId === "string" && collectionId) {
			await assertCollectionProjectContext(collectionId, ctx.projectId);
		}
	}
	if (typeof input.entryId === "string" && input.entryId) {
		await knowledgeService.getEntry(input.entryId, { projectId: ctx.projectId });
	}
	if (typeof input.personalEntryId === "string" && input.personalEntryId) {
		const personal = await knowledgeBranchService.getMine(principal, input.personalEntryId);
		if (personal.entryId) {
			await knowledgeService.getEntry(personal.entryId, { projectId: ctx.projectId });
		} else if (personal.targetCollectionId) {
			await assertCollectionProjectContext(personal.targetCollectionId, ctx.projectId);
		}
	}
}

// ─── KnowledgeCreate ───
export const knowledgeCreateTool: ToolDefinition = {
	name: "KnowledgeCreate",
	description:
		"Create a knowledge entry. By default this creates an entry in YOUR personal knowledge " +
		"library (private to you) that you can later publish into the shared global base via " +
		"KnowledgeEdit (action 'publish'). If you have write permission on the target collection " +
		"and pass direct:true, it creates the entry directly in the global base instead. " +
		"Use this for brand-new entries; use KnowledgeEdit to change existing ones. " +
		"Set `keywords` to the distinctive terms that should passively surface this entry in " +
		"future sessions (see the keywords param guidance). Requires user permission.",
	parameters: z.object({
		title: z.string().describe("Entry title"),
		content: z.string().optional().describe("Entry body content (markdown)"),
		collectionId: z
			.string()
			.optional()
			.describe(
				"Target collection. For a direct global create this is required; for a personal entry it is the intended publish target (can be set later).",
			),
		tags: z.array(z.string()).optional().describe("Tags (direct global create only)"),
		keywords: z
			.array(z.string())
			.optional()
			.describe(
				"Trigger terms for passive auto-injection: when one appears in a later user message " +
					"or tool output, this entry's summary is surfaced automatically. Choose DISTINCTIVE, " +
					"specific terms — proper nouns, error codes, API/function names, domain jargon. Avoid " +
					"short (<3 char) or broad generic words (e.g. 'data', 'error', 'file'); they cause noisy, " +
					"irrelevant injections. An entry with no keywords is never auto-injected (still findable " +
					"via KnowledgeSearch). Prefer a few high-signal terms over many weak ones.",
			),
		direct: z
			.boolean()
			.optional()
			.describe(
				"If true AND you have write permission on the collection, create directly in the global base (skips publish review). Ignored without permission — falls back to a personal entry.",
			),
		changeNote: z.string().optional().describe("Short note describing the entry (direct create)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const a = args as {
			title: string;
			content?: string;
			collectionId?: string;
			tags?: string[];
			keywords?: string[];
			direct?: boolean;
			changeNote?: string;
		};
		const decision = await ctx.requestPermission(
			"KnowledgeCreate",
			{ title: a.title, collectionId: a.collectionId ?? "", direct: !!a.direct },
			ctx.currentToolUseId ?? "",
		);
		if (decision.behavior !== "allow") {
			return deny("KnowledgeCreate was denied by the user.");
		}
		try {
			const principal = await principalOf(ctx);
			if (!principal.userId) return deny("Cannot create knowledge without an identified user.");
			await assertKnowledgeProjectContext(principal, ctx, a);

			// Direct global create: only when explicitly requested, a collection is given, and the
			// caller actually has write capability there. createEntry enforces the capability; we
			// pre-check to decide whether to fall back to a personal entry.
			if (a.direct && a.collectionId) {
				const caps = await knowledgeAcl.resolveCapsByUserId(ctx.userId);
				const col = await knowledgeService.getCollection(a.collectionId).catch(() => null);
				if (col && knowledgeAcl.canWriteCollection(caps, col)) {
					const parsed = createKnowledgeEntrySchema.safeParse({
						collectionId: a.collectionId,
						title: a.title,
						content: a.content,
						tags: a.tags,
						keywords: a.keywords,
						changeNote: a.changeNote,
					});
					if (!parsed.success) return deny(`Invalid create input: ${parsed.error.message}`);
					const created = await knowledgeService.createEntry({
						...parsed.data,
						authorUserId: principal.userId,
						principal,
					});
					return {
						output: `Created global entry "${created.title}" (${created.id}).`,
						title: `KnowledgeCreate: ${created.title}`,
						metadata: { tool: "KnowledgeCreate", direct: true, entryId: created.id },
					};
				}
				// else fall through to personal-entry creation.
			}

			// Default: create a standalone personal entry (to be published later).
			const personal = await knowledgeBranchService.createStandalone(principal, {
				title: a.title,
				content: a.content,
				targetCollectionId: a.collectionId,
				keywords: a.keywords,
			});
			return {
				output:
					`Created a personal entry "${a.title}" (${personal.id}) in your personal library. ` +
					`It is private to you. Use KnowledgeEdit (action 'publish') to propose publishing it into the global base` +
					`${a.collectionId ? "" : " (set a target collection first via action 'set_target')"}.`,
				title: `KnowledgeCreate: ${a.title}`,
				metadata: { tool: "KnowledgeCreate", direct: false, personalEntryId: personal.id },
			};
		} catch (err) {
			return deny(`KnowledgeCreate failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
};

// ─── KnowledgeEdit ───
export const knowledgeEditTool: ToolDefinition = {
	name: "KnowledgeEdit",
	description:
		"Edit and maintain knowledge through your PERSONAL library, then publish to the shared base. Actions:\n" +
		"- save: write content to your personal entry (pass entryId for a linked entry, or personalEntryId for a standalone one). With direct:true AND write permission, writes the global main directly.\n" +
		"- rebase: when your personal entry is based on an outdated main (drifted), three-way-merge the latest main into it. Conflict → returns both versions to redo manually.\n" +
		"- publish: submit your personal entry to be published into the global base (review-gated).\n" +
		"- set_target: set the target collection for a standalone personal entry (required before publish).\n" +
		"- update_meta: change a GLOBAL entry's title/tags/keywords/status (pass entryId; needs write permission), OR a standalone PERSONAL entry's title/keywords (pass personalEntryId).\n" +
		"- transfer_owner / transfer_collection_owner: hand off ownership (admin or current owner).\n" +
		"Requires user permission for all actions.",
	parameters: z.object({
		action: z
			.enum([
				"save",
				"rebase",
				"publish",
				"set_target",
				"update_meta",
				"transfer_owner",
				"transfer_collection_owner",
			])
			.describe("The edit/maintain action"),
		// Targeting: a linked personal entry references a global entry; a standalone one has its own id.
		entryId: z
			.string()
			.optional()
			.describe("Global entry id (save linked entry / update_meta / transfer_owner)"),
		personalEntryId: z
			.string()
			.optional()
			.describe(
				"Personal entry id (save standalone / rebase / publish / set_target / update_meta)",
			),
		content: z.string().optional().describe("New content for save"),
		direct: z
			.boolean()
			.optional()
			.describe("save: if true AND you have write permission, write the global main directly"),
		changeNote: z.string().optional().describe("Change note for save / publish"),
		// set_target
		collectionId: z.string().optional().describe("set_target: target collection id"),
		// update_meta
		title: z.string().optional().describe("update_meta: new title"),
		tags: z.array(z.string()).optional().describe("update_meta: new tags"),
		keywords: z
			.array(z.string())
			.optional()
			.describe(
				"update_meta: replace the entry's auto-injection keywords. Use DISTINCTIVE, specific " +
					"terms (proper nouns, error codes, API names, domain jargon); avoid short (<3 char) or " +
					"broad generic words, which cause noisy injections. Empty array clears keywords (entry " +
					"will no longer auto-inject).",
			),
		entryStatus: z.enum(["active", "archived"]).optional().describe("update_meta: entry status"),
		// transfer
		collectionTargetId: z.string().optional().describe("transfer_collection_owner: collection id"),
		newOwnerUserId: z
			.string()
			.nullable()
			.optional()
			.describe("transfer_*: new owner user id (null to abandon, admin only)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const a = args as Record<string, unknown>;
		const action = a.action as string;
		const decision = await ctx.requestPermission(
			"KnowledgeEdit",
			{ action, ...a },
			ctx.currentToolUseId ?? "",
		);
		if (decision.behavior !== "allow") {
			return deny(
				decision.behavior === "deny" && decision.message
					? decision.message
					: "KnowledgeEdit action was denied by the user.",
			);
		}
		try {
			const principal = await principalOf(ctx);
			if (!principal.userId) return deny("Cannot edit knowledge without an identified user.");
			await assertKnowledgeProjectContext(principal, ctx, a);

			switch (action) {
				case "save":
					return await editSave(principal, a);
				case "rebase":
					return await editRebase(principal, a);
				case "publish":
					return await editPublish(principal, a);
				case "set_target":
					return await editSetTarget(principal, a);
				case "update_meta":
					return await editUpdateMeta(principal, a);
				case "transfer_owner":
					return await editTransferOwner(principal, a);
				case "transfer_collection_owner":
					return await editTransferCollectionOwner(principal, a);
				default:
					return deny(`Unknown action: ${action}`);
			}
		} catch (err) {
			return deny(
				`KnowledgeEdit ${action} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	},
};

// ─── KnowledgeEdit action handlers ───

async function editSave(principal: Principal, a: Record<string, unknown>): Promise<ToolResult> {
	const content = a.content;
	if (typeof content !== "string") return deny("save requires 'content'.");

	// Direct global main write (owner / write-grant only). addRevision enforces the gate.
	if (a.direct && a.entryId) {
		const caps = await knowledgeAcl.resolveCapsByUserId(principal.userId);
		const entryRow = await knowledgeService
			.getEntry(a.entryId as string, { principal })
			.catch(() => null);
		const canDirect = entryRow ? knowledgeAcl.canWriteMain(caps, entryRow) : false;
		if (canDirect) {
			const parsed = addKnowledgeRevisionSchema.safeParse({
				content,
				changeNote: a.changeNote,
			});
			if (!parsed.success) return deny(`Invalid save input: ${parsed.error.message}`);
			const result = await knowledgeService.addRevision(a.entryId as string, {
				...parsed.data,
				authorUserId: principal.userId,
				principal,
			});
			return {
				output: `Wrote a new global revision (v${(result as { version?: number }).version ?? "?"}) to entry ${a.entryId}.`,
				title: "KnowledgeEdit: save (direct)",
				metadata: { tool: "KnowledgeEdit", action: "save", direct: true, entryId: a.entryId },
			};
		}
		// No permission → fall through to personal-entry edit (don't error; honor "ignored" semantics).
	}

	// Personal-entry edit. Resolve which personal entry to write.
	let draftId = a.personalEntryId as string | undefined;
	if (!draftId && a.entryId) {
		// Linked entry: get-or-create the caller's personal entry on it.
		const existing = await knowledgeBranchService.getMyDraft(principal, a.entryId as string);
		if (existing) {
			draftId = existing.id;
		} else {
			const created = await knowledgeBranchService.createDraft(principal, a.entryId as string, {});
			draftId = (created as { id: string }).id;
		}
	}
	if (!draftId) {
		return deny("save requires 'personalEntryId' (standalone) or 'entryId' (linked entry).");
	}
	await knowledgeBranchService.updateDraft(principal, draftId, { content });
	return {
		output: `Saved content to your personal entry (${draftId}). Use action 'publish' to propose it for the global base.`,
		title: "KnowledgeEdit: save",
		metadata: { tool: "KnowledgeEdit", action: "save", direct: false, personalEntryId: draftId },
	};
}

async function editRebase(principal: Principal, a: Record<string, unknown>): Promise<ToolResult> {
	const draftId = (a.personalEntryId as string) || (await resolveLinkedDraftId(principal, a));
	if (!draftId) return deny("rebase requires 'personalEntryId' or 'entryId'.");
	const res = await knowledgeBranchService.rebaseDraft(principal, draftId);
	if (res.ok) {
		return {
			output: res.rebased
				? `Rebased your personal entry onto the latest main. Review the merged result, then publish.`
				: `Your personal entry is already based on the latest main; nothing to rebase.`,
			title: "KnowledgeEdit: rebase",
			metadata: { tool: "KnowledgeEdit", action: "rebase", rebased: res.rebased },
		};
	}
	return {
		output:
			`Rebase hit a conflict — your edit overlaps the latest main and can't be merged automatically.\n\n` +
			`Current main:\n\`\`\`\n${res.conflict.theirs}\n\`\`\`\n\nYour version:\n\`\`\`\n${res.conflict.yours}\n\`\`\`\n\n` +
			`Re-edit your personal entry (action 'save') to reconcile, then publish.`,
		title: "KnowledgeEdit: rebase (conflict)",
		metadata: { tool: "KnowledgeEdit", action: "rebase", conflict: true },
	};
}

async function editPublish(principal: Principal, a: Record<string, unknown>): Promise<ToolResult> {
	const draftId = (a.personalEntryId as string) || (await resolveLinkedDraftId(principal, a));
	if (!draftId) return deny("publish requires 'personalEntryId' or 'entryId'.");
	const submission = await knowledgeBranchService.submitForReview(principal, draftId, {
		changeNote: a.changeNote as string | undefined,
	});
	return {
		output: `Submitted your personal entry for publishing (submission ${(submission as { id: string }).id}). A reviewer must approve before it enters the global base.`,
		title: "KnowledgeEdit: publish",
		metadata: {
			tool: "KnowledgeEdit",
			action: "publish",
			submissionId: (submission as { id: string }).id,
		},
	};
}

async function editSetTarget(
	principal: Principal,
	a: Record<string, unknown>,
): Promise<ToolResult> {
	if (!a.personalEntryId) return deny("set_target requires 'personalEntryId'.");
	if (!a.collectionId) return deny("set_target requires 'collectionId'.");
	await knowledgeBranchService.updateStandaloneMeta(principal, a.personalEntryId as string, {
		targetCollectionId: a.collectionId as string,
	});
	return {
		output: `Set publish target collection to ${a.collectionId} for personal entry ${a.personalEntryId}.`,
		title: "KnowledgeEdit: set_target",
		metadata: { tool: "KnowledgeEdit", action: "set_target", personalEntryId: a.personalEntryId },
	};
}

async function editUpdateMeta(
	principal: Principal,
	a: Record<string, unknown>,
): Promise<ToolResult> {
	// Personal (standalone) entry: update its own title / keywords via the branch service.
	// tags/status don't apply to personal entries (they only exist on global entries).
	if (a.personalEntryId && !a.entryId) {
		const patch: { title?: string; keywords?: string[] } = {};
		if (a.title !== undefined) patch.title = a.title as string;
		if (a.keywords !== undefined) {
			if (!Array.isArray(a.keywords)) return deny("update_meta 'keywords' must be an array.");
			patch.keywords = a.keywords as string[];
		}
		if (Object.keys(patch).length === 0) {
			return deny("update_meta for a personal entry needs 'title' and/or 'keywords'.");
		}
		await knowledgeBranchService.updateStandaloneMeta(
			principal,
			a.personalEntryId as string,
			patch,
		);
		return {
			output: `Updated metadata for personal entry ${a.personalEntryId}.`,
			title: "KnowledgeEdit: update_meta",
			metadata: {
				tool: "KnowledgeEdit",
				action: "update_meta",
				personalEntryId: a.personalEntryId,
			},
		};
	}

	if (!a.entryId) {
		return deny("update_meta requires 'entryId' (global entry) or 'personalEntryId' (personal).");
	}
	const parsed = updateKnowledgeEntrySchema.safeParse({
		title: a.title,
		tags: a.tags,
		keywords: a.keywords,
		status: a.entryStatus,
	});
	if (!parsed.success) return deny(`Invalid update_meta input: ${parsed.error.message}`);
	await knowledgeService.updateEntryMeta(a.entryId as string, parsed.data, principal);
	return {
		output: `Updated metadata for global entry ${a.entryId}.`,
		title: "KnowledgeEdit: update_meta",
		metadata: { tool: "KnowledgeEdit", action: "update_meta", entryId: a.entryId },
	};
}

async function editTransferOwner(
	principal: Principal,
	a: Record<string, unknown>,
): Promise<ToolResult> {
	if (!a.entryId) return deny("transfer_owner requires 'entryId'.");
	if (a.newOwnerUserId === undefined) {
		return deny("transfer_owner requires 'newOwnerUserId' (a user id, or null to abandon).");
	}
	const res = await knowledgeService.transferEntryOwner(
		a.entryId as string,
		a.newOwnerUserId as string | null,
		principal,
	);
	return {
		output: `Entry ${res.entryId} owner set to ${res.ownerUserId ?? "(none)"}.`,
		title: "KnowledgeEdit: transfer_owner",
		metadata: { tool: "KnowledgeEdit", action: "transfer_owner", entryId: a.entryId },
	};
}

async function editTransferCollectionOwner(
	principal: Principal,
	a: Record<string, unknown>,
): Promise<ToolResult> {
	if (!a.collectionTargetId)
		return deny("transfer_collection_owner requires 'collectionTargetId'.");
	if (a.newOwnerUserId === undefined) {
		return deny(
			"transfer_collection_owner requires 'newOwnerUserId' (a user id, or null to abandon).",
		);
	}
	const res = await knowledgeService.transferCollectionOwner(
		a.collectionTargetId as string,
		a.newOwnerUserId as string | null,
		principal,
	);
	return {
		output: `Collection ${res.collectionId} owner set to ${res.ownerUserId ?? "(none)"}.`,
		title: "KnowledgeEdit: transfer_collection_owner",
		metadata: { tool: "KnowledgeEdit", action: "transfer_collection_owner" },
	};
}

/** For a linked-entry action given only entryId, resolve the caller's active personal entry id. */
async function resolveLinkedDraftId(
	principal: Principal,
	a: Record<string, unknown>,
): Promise<string | undefined> {
	if (!a.entryId) return undefined;
	const existing = await knowledgeBranchService.getMyDraft(principal, a.entryId as string);
	return existing?.id;
}
