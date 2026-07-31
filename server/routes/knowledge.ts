import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import {
	addKnowledgeRevisionSchema,
	bulkKnowledgeGrantSchema,
	createKnowledgeCollectionSchema,
	createKnowledgeDraftSchema,
	createKnowledgeEntrySchema,
	createKnowledgeGrantSchema,
	createKnowledgeLevelSchema,
	createKnowledgeLinkSchema,
	createKnowledgeTagSchema,
	createKnowledgeTagTypeSchema,
	createPersonalEntrySchema,
	knowledgeGraphQuerySchema,
	knowledgeSearchQuerySchema,
	listDraftSubmissionsQuerySchema,
	listKnowledgeLinksQuerySchema,
	listPersonalEntriesQuerySchema,
	rebaseKnowledgeDraftQuerySchema,
	resolveKnowledgeConflictSchema,
	resubmitKnowledgeSubmissionSchema,
	reviewKnowledgeSubmissionSchema,
	setUserAclSchema,
	submitKnowledgeDraftSchema,
	transferKnowledgeOwnerSchema,
	updateKnowledgeCollectionAclSchema,
	updateKnowledgeCollectionSchema,
	updateKnowledgeDraftSchema,
	updateKnowledgeEntryAclSchema,
	updateKnowledgeEntrySchema,
	updateKnowledgeLevelSchema,
	updateKnowledgeTagSchema,
	updateKnowledgeTagTypeSchema,
	updatePersonalEntryMetaSchema,
	withdrawKnowledgeSubmissionSchema,
} from "../lib/validators";
import { requireAdmin } from "../middleware/auth";
import { knowledgeAcl } from "../services/knowledge-acl";
import { knowledgeBranchService } from "../services/knowledge-branch-service";
import { knowledgeLinkService } from "../services/knowledge-link-service";
import { knowledgeService } from "../services/knowledge-service";

export const knowledgeRoutes = new Hono();

/** Build the Principal from the authed JWT context. */
function principalOf(c: { get: (k: "user") => { sub: string; role: "admin" | "user" } }) {
	const u = c.get("user");
	return { userId: u.sub, role: u.role };
}

// ─── Collections ──────────────────────────────────────────────────────

knowledgeRoutes.get("/collections", async (c) => {
	const projectId = c.req.query("projectId") || undefined;
	return c.json(await knowledgeService.listCollections(projectId, principalOf(c)));
});

knowledgeRoutes.post("/collections", async (c) => {
	const parsed = createKnowledgeCollectionSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// Record the creating user as owner so the owner short-circuit is meaningful.
	return c.json(
		await knowledgeService.createCollection({ ...parsed.data, ownerUserId: c.get("user").sub }),
		201,
	);
});

knowledgeRoutes.patch("/collections/:id", requireAdmin, async (c) => {
	const parsed = updateKnowledgeCollectionSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeService.updateCollection(c.req.param("id") ?? "", parsed.data));
});

// Set collection ACL attributes (classification level, controlled tags, owner) — admin only.
knowledgeRoutes.patch("/collections/:id/acl", requireAdmin, async (c) => {
	const parsed = updateKnowledgeCollectionAclSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.updateCollectionAcl(c.req.param("id") ?? "", parsed.data));
});

// Transfer collection ownership — admin OR current owner (enforced in the service; NOT requireAdmin).
knowledgeRoutes.post("/collections/:id/transfer-owner", async (c) => {
	const parsed = transferKnowledgeOwnerSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeService.transferCollectionOwner(
			c.req.param("id") ?? "",
			parsed.data.ownerUserId,
			principalOf(c),
		),
	);
});

knowledgeRoutes.delete("/collections/:id", requireAdmin, async (c) => {
	return c.json(await knowledgeService.deleteCollection(c.req.param("id") ?? ""));
});

// ─── Entries ──────────────────────────────────────────────────────────

knowledgeRoutes.get("/entries", async (c) => {
	const collectionId = c.req.query("collectionId") || undefined;
	const tag = c.req.query("tag") || undefined;
	const q = c.req.query("q");
	const principal = principalOf(c);
	if (q?.trim()) {
		const results = knowledgeService.search({ q, collectionId, tag });
		return c.json(await knowledgeService.filterReadable(principal, results));
	}
	const entries = await knowledgeService.listEntries({ collectionId, tag });
	return c.json(await knowledgeService.filterReadable(principal, entries));
});

knowledgeRoutes.post("/entries", async (c) => {
	const parsed = createKnowledgeEntrySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	// Pass principal so the collection write-gate (read + write the collection) is enforced.
	return c.json(
		await knowledgeService.createEntry({
			...parsed.data,
			authorUserId: userId,
			principal: principalOf(c),
		}),
		201,
	);
});

knowledgeRoutes.get("/entries/:id", async (c) => {
	const entry = await knowledgeService.getEntry(c.req.param("id"), {
		withContent: true,
		principal: principalOf(c),
	});
	return c.json(entry);
});

knowledgeRoutes.patch("/entries/:id", async (c) => {
	const parsed = updateKnowledgeEntrySchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeService.updateEntryMeta(c.req.param("id"), parsed.data, principalOf(c)),
	);
});

knowledgeRoutes.delete("/entries/:id", async (c) => {
	return c.json(await knowledgeService.deleteEntry(c.req.param("id"), principalOf(c)));
});

// Set entry ACL attributes (classification level, controlled/review tags, owner) — admin only.
knowledgeRoutes.patch("/entries/:id/acl", requireAdmin, async (c) => {
	const parsed = updateKnowledgeEntryAclSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const id = c.req.param("id") ?? "";
	return c.json(await knowledgeService.updateEntryAcl(id, parsed.data));
});

// Transfer entry ownership — admin OR current owner (enforced in the service; NOT requireAdmin).
knowledgeRoutes.post("/entries/:id/transfer-owner", async (c) => {
	const parsed = transferKnowledgeOwnerSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeService.transferEntryOwner(
			c.req.param("id") ?? "",
			parsed.data.ownerUserId,
			principalOf(c),
		),
	);
});

// ─── Revisions (direct main write — gated to admin/owner/write-grant) ───

knowledgeRoutes.post("/entries/:id/revisions", async (c) => {
	const parsed = addKnowledgeRevisionSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const result = await knowledgeService.addRevision(c.req.param("id"), {
		...parsed.data,
		authorUserId: userId,
		principal: principalOf(c),
	});
	return c.json(result, 201);
});

knowledgeRoutes.get("/entries/:id/revisions", async (c) => {
	return c.json(await knowledgeService.listRevisions(c.req.param("id"), principalOf(c)));
});

knowledgeRoutes.get("/revisions/:id", async (c) => {
	return c.json(await knowledgeService.getRevision(c.req.param("id"), principalOf(c)));
});

// ─── Entry links (entry-scope knowledge graph) ──────────────────────────

// List links touching an entry (both endpoints filtered by canRead).
knowledgeRoutes.get("/entries/:id/links", async (c) => {
	const parsed = listKnowledgeLinksQuerySchema.safeParse({
		direction: c.req.query("direction"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const id = c.req.param("id") ?? "";
	return c.json(await knowledgeLinkService.listLinks(principalOf(c), id, parsed.data.direction));
});

// Create an entry-scope link from this entry → target.
knowledgeRoutes.post("/entries/:id/links", async (c) => {
	const fromEntryId = c.req.param("id") ?? "";
	const parsed = createKnowledgeLinkSchema.safeParse({
		...(await c.req.json()),
		fromEntryId,
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeLinkService.addLink(principalOf(c), {
			fromEntryId,
			toEntryId: parsed.data.toEntryId,
			linkType: parsed.data.linkType,
			label: parsed.data.label,
			toRevisionId: parsed.data.toRevisionId,
		}),
		201,
	);
});

// Bounded, permission-filtered graph traversal from an entry.
knowledgeRoutes.get("/entries/:id/graph", async (c) => {
	const parsed = knowledgeGraphQuerySchema.safeParse({
		depth: c.req.query("depth"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const id = c.req.param("id") ?? "";
	return c.json(
		await knowledgeLinkService.getGraph(principalOf(c), id, { depth: parsed.data.depth }),
	);
});

// Delete a link by id (gated on readability of the source entry).
knowledgeRoutes.delete("/links/:id", async (c) => {
	const id = c.req.param("id") ?? "";
	return c.json(await knowledgeLinkService.removeLink(principalOf(c), id));
});

// ─── Personal library (standalone personal entries) ─────────────────────

knowledgeRoutes.get("/personal-entries", async (c) => {
	const parsed = listPersonalEntriesQuerySchema.safeParse({
		status: c.req.query("status"),
		limit: c.req.query("limit"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeBranchService.listMine(principalOf(c), parsed.data));
});

knowledgeRoutes.post("/personal-entries", async (c) => {
	const parsed = createPersonalEntrySchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeBranchService.createStandalone(principalOf(c), parsed.data), 201);
});

knowledgeRoutes.get("/personal-entries/:id", async (c) => {
	return c.json(await knowledgeBranchService.getMine(principalOf(c), c.req.param("id")));
});

knowledgeRoutes.patch("/personal-entries/:id", async (c) => {
	const parsed = updatePersonalEntryMetaSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.updateStandaloneMeta(
			principalOf(c),
			c.req.param("id"),
			parsed.data,
		),
	);
});

// ─── Drafts (personal working copies) ───────────────────────────────────

knowledgeRoutes.post("/entries/:id/drafts", async (c) => {
	const parsed = createKnowledgeDraftSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const draft = await knowledgeBranchService.createDraft(
		principalOf(c),
		c.req.param("id"),
		parsed.data,
	);
	return c.json(draft, 201);
});

knowledgeRoutes.get("/entries/:id/drafts/mine", async (c) => {
	return c.json(await knowledgeBranchService.getMyDraft(principalOf(c), c.req.param("id")));
});

knowledgeRoutes.get("/entries/:id/drafts/mine/drift", async (c) => {
	return c.json(await knowledgeBranchService.getDraftDrift(principalOf(c), c.req.param("id")));
});

knowledgeRoutes.patch("/drafts/:id", async (c) => {
	const parsed = updateKnowledgeDraftSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.updateDraft(principalOf(c), c.req.param("id"), parsed.data),
	);
});

knowledgeRoutes.get("/drafts/:id/diff", async (c) => {
	// `against=current` (default) diffs vs current main; `against=base` vs the fork point.
	const against = c.req.query("against") === "base" ? "base" : "current";
	return c.json(
		await knowledgeBranchService.getDraftDiff(principalOf(c), c.req.param("id"), { against }),
	);
});

// `strategy=merge` (default) three-way merges; `strategy=theirs` replaces the draft with
// current main, DISCARDING local edits (the explicit "give up my changes" exit from a
// conflict — the UI confirms before calling it).
knowledgeRoutes.post("/drafts/:id/rebase", async (c) => {
	const parsed = rebaseKnowledgeDraftQuerySchema.safeParse({ strategy: c.req.query("strategy") });
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.rebaseDraft(principalOf(c), c.req.param("id"), {
			strategy: parsed.data.strategy,
		}),
	);
});

knowledgeRoutes.post("/drafts/:id/submit", async (c) => {
	const parsed = submitKnowledgeDraftSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.submitForReview(principalOf(c), c.req.param("id"), parsed.data),
		201,
	);
});

// ─── Submissions (review workflow) ──────────────────────────────────────

knowledgeRoutes.get("/submissions", async (c) => {
	const entryId = c.req.query("entryId") || undefined;
	const status = c.req.query("status") || undefined;
	return c.json(await knowledgeBranchService.listSubmissions(principalOf(c), { entryId, status }));
});

knowledgeRoutes.get("/submissions/:id", async (c) => {
	return c.json(await knowledgeBranchService.getSubmission(principalOf(c), c.req.param("id")));
});

knowledgeRoutes.post("/submissions/:id/review", async (c) => {
	const parsed = reviewKnowledgeSubmissionSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.review(principalOf(c), c.req.param("id"), parsed.data),
	);
});

knowledgeRoutes.post("/submissions/:id/resolve", async (c) => {
	const parsed = resolveKnowledgeConflictSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.resolveConflict(principalOf(c), c.req.param("id"), parsed.data),
	);
});

// ─── Search ─────────────────────────────────────────────────────────────

knowledgeRoutes.get("/search", async (c) => {
	const parsed = knowledgeSearchQuerySchema.safeParse({
		q: c.req.query("q"),
		collectionId: c.req.query("collectionId"),
		tag: c.req.query("tag"),
		limit: c.req.query("limit"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const results = knowledgeService.search(parsed.data);
	return c.json(await knowledgeService.filterReadable(principalOf(c), results));
});

// ─── ACL admin: levels / tags / grants (admin only) ─────────────────────

knowledgeRoutes.get("/levels", async (c) => c.json(await knowledgeAcl.listLevels()));
knowledgeRoutes.post("/levels", requireAdmin, async (c) => {
	const parsed = createKnowledgeLevelSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.createLevel(parsed.data), 201);
});
knowledgeRoutes.patch("/levels/:id", requireAdmin, async (c) => {
	const parsed = updateKnowledgeLevelSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.updateLevel(c.req.param("id") ?? "", parsed.data));
});
knowledgeRoutes.delete("/levels/:id", requireAdmin, async (c) => {
	const result = await knowledgeAcl.deleteLevel(c.req.param("id") ?? "");
	if (!result.ok) {
		const msg =
			result.reason === "in_use"
				? "Level is still referenced by entries, collections, or grants and cannot be deleted"
				: result.reason === "builtin"
					? "The public level cannot be deleted"
					: "Level not found";
		throw new ValidationError(msg);
	}
	return c.json(result);
});

knowledgeRoutes.get("/tags", async (c) =>
	c.json(await knowledgeAcl.listTags(c.req.query("collectionId") || undefined)),
);
knowledgeRoutes.post("/tags", requireAdmin, async (c) => {
	const parsed = createKnowledgeTagSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.createTag(parsed.data), 201);
});
knowledgeRoutes.patch("/tags/:id", requireAdmin, async (c) => {
	const parsed = updateKnowledgeTagSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.updateTag(c.req.param("id") ?? "", parsed.data));
});
knowledgeRoutes.delete("/tags/:id", requireAdmin, async (c) =>
	c.json(await knowledgeAcl.deleteTag(c.req.param("id") ?? "")),
);

// ─── Tag types (organization / position / permission / other; builtin not deletable) ───
knowledgeRoutes.get("/tag-types", async (c) => c.json(await knowledgeAcl.listTagTypes()));
knowledgeRoutes.post("/tag-types", requireAdmin, async (c) => {
	const parsed = createKnowledgeTagTypeSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.createTagType(parsed.data), 201);
});
knowledgeRoutes.patch("/tag-types/:id", requireAdmin, async (c) => {
	const parsed = updateKnowledgeTagTypeSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.updateTagType(c.req.param("id") ?? "", parsed.data));
});
knowledgeRoutes.delete("/tag-types/:id", requireAdmin, async (c) => {
	const result = await knowledgeAcl.deleteTagType(c.req.param("id") ?? "");
	if (!result.ok) {
		throw new ValidationError(
			result.reason === "builtin" ? "Builtin tag type cannot be deleted" : "Tag type not found",
		);
	}
	return c.json(result);
});

// ─── Per-user ACL (clearance level + tags) — admin only ───
knowledgeRoutes.get("/users/:userId/acl", requireAdmin, async (c) =>
	c.json(await knowledgeAcl.getUserAcl(c.req.param("userId") ?? "")),
);
knowledgeRoutes.put("/users/:userId/acl", requireAdmin, async (c) => {
	const parsed = setUserAclSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.setUserAcl(c.req.param("userId") ?? "", parsed.data));
});

knowledgeRoutes.get("/grants", requireAdmin, async (c) =>
	c.json(
		await knowledgeAcl.listGrants({
			principalType: c.req.query("principalType") || undefined,
			principalId: c.req.query("principalId") || undefined,
		}),
	),
);
knowledgeRoutes.post("/grants", requireAdmin, async (c) => {
	const parsed = createKnowledgeGrantSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.createGrant(parsed.data), 201);
});
knowledgeRoutes.delete("/grants/:id", requireAdmin, async (c) =>
	c.json(await knowledgeAcl.deleteGrant(c.req.param("id") ?? "")),
);

// ─── Entry accessible users preview (admin only) ───
knowledgeRoutes.get("/entries/:id/accessible-users", requireAdmin, async (c) =>
	c.json(await knowledgeAcl.getEntryAccessibleUsers(c.req.param("id") ?? "")),
);

// ─── Review inbox badge (WP1) ───
// Bounded count of open submissions the caller may review. `capped: true` means the
// real number may be higher than `count` (the UI renders "100+"); the implementation
// reads at most limit+1 rows instead of running an unbounded COUNT(*).
knowledgeRoutes.get("/review-inbox/count", async (c) =>
	c.json(await knowledgeBranchService.countReviewInbox(principalOf(c))),
);

// ─── Personal library: delete + publish history (WP2) ───────────────────
//
// Appended here (not next to the other /personal-entries routes) to keep the diff
// append-only while sibling work packages edit the same file.

// Soft-delete (archive) one of the caller's own personal entries. Authorization is the
// author-or-admin check inside the service (loadOwnDraft → NotFound for anyone else, so
// entry existence is not leaked). Any open publish request is rejected in the same
// transaction.
knowledgeRoutes.delete("/personal-entries/:id", async (c) => {
	return c.json(
		await knowledgeBranchService.deletePersonalEntry(principalOf(c), c.req.param("id")),
	);
});

// Publish history for ONE personal entry, from the AUTHOR's point of view.
//
// GET /submissions is the REVIEWER view (it filters to submissions the caller may review,
// and nobody may review their own submission), so an author cannot see their own publish
// history through it — hence this author-scoped path instead of a `draftId` filter on
// /submissions. Gated on draft ownership (author or admin) and bounded by LIMIT.
knowledgeRoutes.get("/personal-entries/:id/submissions", async (c) => {
	const parsed = listDraftSubmissionsQuerySchema.safeParse({ limit: c.req.query("limit") });
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.listSubmissionsForDraft(
			principalOf(c),
			c.req.param("id"),
			parsed.data,
		),
	);
});

// The caller's own in-flight publish requests (pending / conflict / changes_requested),
// keyed by draftId. Lets the personal-library list badge every card from ONE bounded
// query instead of one request per card. Own submissions only — no ACL gate needed.
knowledgeRoutes.get("/my-open-submissions", async (c) => {
	const parsed = listDraftSubmissionsQuerySchema.safeParse({ limit: c.req.query("limit") });
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeBranchService.listMyOpenSubmissions(principalOf(c), parsed.data));
});

// ─── Bulk grants + collection ACL readback (admin only) ─────────────────

// Grant one credential (clearance / tag / review) to many users at once. The Zod schema caps
// userIds at 200 and the service writes them in a single transaction, so a large request can
// neither run unbounded on the main thread nor leave a half-applied batch behind.
knowledgeRoutes.post("/grants/bulk", requireAdmin, async (c) => {
	const parsed = bulkKnowledgeGrantSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgeAcl.bulkGrant(parsed.data), 201);
});

// Read a collection's ACL attributes (level / controlled tags / owner) for admin UI echo-back.
// admin-only, matching PATCH /collections/:id/acl above.
knowledgeRoutes.get("/collections/:id/acl", requireAdmin, async (c) =>
	c.json(await knowledgeAcl.getCollectionAcl(c.req.param("id") ?? "")),
);

// ─── Review state machine closure: withdraw / resubmit / my scope (WP5) ───
//
// Appended here (not next to the other /submissions routes) to keep the diff append-only
// while sibling work packages edit the same file.

// Withdraw one of the caller's OWN open publish requests (pending / conflict) → `withdrawn`.
// Authorization is submitter-or-admin inside the service (anyone else gets NotFound, so
// submission existence isn't leaked). Deliberately author-side: a REVIEWER who wants a
// request closed uses /review, which records a verdict.
knowledgeRoutes.post("/submissions/:id/withdraw", async (c) => {
	const parsed = withdrawKnowledgeSubmissionSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.withdrawSubmission(principalOf(c), c.req.param("id"), parsed.data),
	);
});

// Re-submit after a `changes_requested` verdict: creates a NEW submission from the draft's
// CURRENT content, linked to the bounced one via previousSubmissionId + round, so a reviewer
// sees the revision round instead of an unrelated-looking proposal.
knowledgeRoutes.post("/submissions/:id/resubmit", async (c) => {
	const parsed = resubmitKnowledgeSubmissionSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgeBranchService.resubmit(principalOf(c), c.req.param("id"), parsed.data),
		201,
	);
});

// The caller's own review authority (which review tags they hold, which collections they may
// publish into), so the review tab can state it instead of leaving users to infer it from
// whichever submissions happen to be listed. Bounded: own grants + one capped collection read.
knowledgeRoutes.get("/my-review-scope", async (c) =>
	c.json(await knowledgeBranchService.getMyReviewScope(principalOf(c))),
);
