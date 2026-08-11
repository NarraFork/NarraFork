/**
 * Knowledge-base in-app notification bridge.
 *
 * Turns the `knowledge:*` event-bus events emitted by knowledge-branch-service into
 * targeted WebSocket pushes, so reviewers see pending publish requests and submitters
 * see review outcomes without polling `/submissions`.
 *
 * Design constraints:
 *  - **No notification table.** The push is an invalidation signal (ids only); clients
 *    refetch through the ACL-checked HTTP endpoints. Nothing here carries entry titles
 *    or bodies, so a push can never leak a classified entry to a user who can't read it.
 *  - **ACL is never re-implemented.** Reviewer resolution reuses `knowledge-acl`'s
 *    `canReadCollection` / `canReview` / `canWriteCollection` predicates, matching the
 *    authorization in `knowledgeBranchService.review` exactly.
 *  - **Bounded.** Candidate reviewers come from `resolveCapsForAllUsers`, which caps the
 *    population (200 users / fixed query count). Above the cap it degrades to admins only
 *    instead of scanning the whole user table.
 *  - **Off the request path.** Handlers are async and never awaited by the emitter; a
 *    failure logs and is dropped rather than failing the publish/review that triggered it.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { knowledgeCollections, knowledgeEntries, knowledgeSubmissions } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import type { NarratorServerMessage } from "../websocket/narrator-ws-types";
import {
	type AclCollection,
	type AclEntry,
	canReadCollection,
	canReview,
	canWriteCollection,
	resolveCapsForAllUsers,
} from "./knowledge-acl";

/** Injectable so tests can assert the pushes without a live WebSocket server. */
type PushFn = (userId: string, message: NarratorServerMessage) => void;

let push: PushFn | null = null;

async function defaultPush(userId: string, message: NarratorServerMessage): Promise<void> {
	// Imported lazily: narrator-ws pulls in the whole WS/session graph, and this module
	// is also loaded by tests that only care about the routing decisions.
	const { broadcastToUser } = await import("../websocket/narrator-ws");
	broadcastToUser(userId, message);
}

/** Override the delivery channel (tests only). Pass null to restore the default. */
export function setKnowledgeNotifyPush(fn: PushFn | null): void {
	push = fn;
}

function deliver(userId: string, message: NarratorServerMessage): void {
	if (!userId) return;
	if (push) {
		push(userId, message);
		return;
	}
	void defaultPush(userId, message).catch((err) => {
		logger.error("Knowledge notify push failed", {
			userId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

function toAclEntry(
	entry: Pick<
		typeof knowledgeEntries.$inferSelect,
		"id" | "collectionId" | "ownerUserId" | "classificationLevel" | "controlledTagsJson"
	> & { reviewTagsJson?: unknown },
): AclEntry {
	return {
		id: entry.id,
		collectionId: entry.collectionId,
		ownerUserId: entry.ownerUserId,
		classificationLevel: entry.classificationLevel,
		controlledTagsJson: entry.controlledTagsJson,
		reviewTagsJson: entry.reviewTagsJson,
	};
}

function toAclCollection(
	c: Pick<
		typeof knowledgeCollections.$inferSelect,
		"id" | "defaultLevel" | "classificationLevel" | "controlledTagsJson" | "ownerUserId"
	>,
): AclCollection {
	return {
		id: c.id,
		defaultLevel: c.defaultLevel,
		classificationLevel: c.classificationLevel,
		controlledTagsJson: c.controlledTagsJson,
		ownerUserId: c.ownerUserId,
	};
}

/**
 * Resolve the users who may review a submission, excluding the submitter.
 *
 * Mirrors the authorization split in `knowledgeBranchService.review`:
 *  - LINKED submission (entryId set)      → collection readable AND `canReview(entry)`.
 *  - STANDALONE submission (collectionId) → collection readable AND writable.
 *
 * The submitter is always excluded: self-review is rejected by the service, so pushing
 * a "needs your review" signal to them would be noise. Returns at most the bounded
 * population from `resolveCapsForAllUsers`.
 */
export async function resolveReviewerUserIds(input: {
	entryId: string | null;
	collectionId: string | null;
	submitterUserId: string;
}): Promise<string[]> {
	const { byUserId } = await resolveCapsForAllUsers();

	let aclEntry: AclEntry | null = null;
	let aclCollection: AclCollection | null = null;

	if (input.entryId) {
		const entry = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, input.entryId),
			columns: {
				id: true,
				collectionId: true,
				ownerUserId: true,
				classificationLevel: true,
				controlledTagsJson: true,
				reviewTagsJson: true,
			},
		});
		if (!entry) return [];
		const collection = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, entry.collectionId),
			columns: {
				id: true,
				defaultLevel: true,
				classificationLevel: true,
				controlledTagsJson: true,
				ownerUserId: true,
			},
		});
		if (!collection) return [];
		aclEntry = toAclEntry(entry);
		aclCollection = toAclCollection(collection);
	} else if (input.collectionId) {
		const collection = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, input.collectionId),
			columns: {
				id: true,
				defaultLevel: true,
				classificationLevel: true,
				controlledTagsJson: true,
				ownerUserId: true,
			},
		});
		if (!collection) return [];
		aclCollection = toAclCollection(collection);
	} else {
		// Neither target: nothing reviewable (a standalone publish without a collection
		// is refused at submit time).
		return [];
	}

	const out: string[] = [];
	for (const [userId, caps] of byUserId) {
		if (userId === input.submitterUserId) continue;
		if (!(await canReadCollection(caps, aclCollection))) continue;
		if (aclEntry) {
			if (canReview(caps, aclEntry)) out.push(userId);
		} else if (canWriteCollection(caps, aclCollection)) {
			out.push(userId);
		}
	}
	return out;
}

/** Load the routing scalars for a submission (no proposedContent). */
async function loadSubmissionRouting(submissionId: string) {
	return db.query.knowledgeSubmissions.findFirst({
		where: eq(knowledgeSubmissions.id, submissionId),
		columns: {
			id: true,
			entryId: true,
			collectionId: true,
			submitterUserId: true,
			status: true,
		},
	});
}

async function onSubmissionCreated(event: {
	submissionId: string;
	entryId: string | null;
	collectionId: string | null;
	submitterUserId: string;
}): Promise<void> {
	const reviewers = await resolveReviewerUserIds(event);
	for (const userId of reviewers) {
		deliver(userId, {
			type: "knowledge:review_inbox_changed",
			reason: "submission_created",
			submissionId: event.submissionId,
			role: "reviewer",
			entryId: event.entryId,
		});
	}
}

async function onSubmissionReviewed(event: {
	submissionId: string;
	status: string;
	submitterUserId: string;
	reviewerUserId: string;
}): Promise<void> {
	const sub = await loadSubmissionRouting(event.submissionId);
	deliver(event.submitterUserId, {
		type: "knowledge:review_inbox_changed",
		reason: "submission_reviewed",
		submissionId: event.submissionId,
		role: "submitter",
		status: event.status,
		entryId: sub?.entryId ?? null,
	});
	// The submission left (or re-entered) the reviewer queue — refresh their badges too.
	// A conflict stays open, so it must remain visible to the other candidate reviewers.
	if (!sub) return;
	const reviewers = await resolveReviewerUserIds({
		entryId: sub.entryId ?? null,
		collectionId: sub.collectionId ?? null,
		submitterUserId: sub.submitterUserId,
	});
	for (const userId of reviewers) {
		deliver(userId, {
			type: "knowledge:review_inbox_changed",
			reason: "submission_reviewed",
			submissionId: event.submissionId,
			role: "reviewer",
			status: event.status,
			entryId: sub.entryId ?? null,
		});
	}
}

async function onSubmissionInvalidated(event: {
	submissionId: string;
	submitterUserId: string;
}): Promise<void> {
	const sub = await loadSubmissionRouting(event.submissionId);
	deliver(event.submitterUserId, {
		type: "knowledge:review_inbox_changed",
		reason: "submission_invalidated",
		submissionId: event.submissionId,
		role: "submitter",
		status: sub?.status,
		entryId: sub?.entryId ?? null,
	});
	if (!sub) return;
	// It disappeared from the reviewer queue — clear their badge without a refetch race.
	const reviewers = await resolveReviewerUserIds({
		entryId: sub.entryId ?? null,
		collectionId: sub.collectionId ?? null,
		submitterUserId: sub.submitterUserId,
	});
	for (const userId of reviewers) {
		deliver(userId, {
			type: "knowledge:review_inbox_changed",
			reason: "submission_invalidated",
			submissionId: event.submissionId,
			role: "reviewer",
			status: sub.status,
			entryId: sub.entryId ?? null,
		});
	}
}

function onEntryPublished(event: {
	entryId: string;
	submissionId: string;
	submitterUserId: string;
}): void {
	deliver(event.submitterUserId, {
		type: "knowledge:review_inbox_changed",
		reason: "entry_published",
		submissionId: event.submissionId,
		role: "submitter",
		status: "approved",
		entryId: event.entryId,
	});
}

/**
 * Cap on personal-version holders notified when an entry's main advances.
 *
 * Bounded on purpose: this runs after EVERY main write, so an entry forked by a huge number of
 * users must not turn one revision into an unbounded scan + fan-out. Beyond the cap some badges
 * go stale until the next refetch, which is an acceptable trade for a fixed cost.
 */
const DRIFT_NOTIFY_MAX_HOLDERS = 200;

/**
 * Announce that an entry's main revision advanced, so holders of a personal version are drifted.
 *
 * Lives HERE, next to the listener that consumes the event, because both write paths that can move
 * main need it: a direct revision (knowledge-service) and an approved publish
 * (knowledge-branch-service). Those two modules do not import each other, so each used to carry an
 * identical private copy — one query, one cap and one swallow-policy duplicated in two places,
 * which is exactly the kind of drift-by-copy this function is about.
 *
 * Resolving WHICH users are affected needs a drafts query, which is why callers hand over ids only.
 * Failure is swallowed: a missing drift badge must never fail the write that already committed.
 */
export function emitEntryDrifted(entryId: string, excludeUserId: string | null): void {
	void (async () => {
		const holders = await db.query.knowledgeDrafts.findMany({
			where: (d, { and: a, eq: e, inArray: ia, isNotNull }) =>
				a(e(d.entryId, entryId), ia(d.status, ["active"]), isNotNull(d.baseRevisionId)),
			columns: { authorUserId: true },
			limit: DRIFT_NOTIFY_MAX_HOLDERS,
		});
		const userIds = [
			...new Set(
				holders
					.map((h) => h.authorUserId)
					.filter((id): id is string => !!id && id !== excludeUserId),
			),
		];
		if (userIds.length === 0) return;
		eventBus.emit({ type: "knowledge:entry_drifted", entryId, driftedUserIds: userIds });
	})().catch((err) => {
		logger.warn("knowledge drift notification failed", {
			entryId,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

/**
 * A global entry advanced → tell the holders of a personal version that theirs is now behind.
 *
 * `emitEntryDrifted` already resolved WHO is affected (it owns the drafts query) and excluded the
 * author of the change, so this is a pure fan-out. No ACL re-check is needed: holding an active
 * personal version of an entry means the user could read it when they forked, and the push carries
 * only the entry id — the client's refetch is what re-applies the ACL.
 */
function onEntryDrifted(event: { entryId: string; driftedUserIds: string[] }): void {
	for (const userId of event.driftedUserIds) {
		deliver(userId, {
			type: "knowledge:library_changed",
			reason: "entry_drifted",
			entryId: event.entryId,
		});
	}
}

/**
 * A principal's authorization changed → their readable set, review scope and badges may all differ.
 *
 * Deliberately carries no level/tag detail: knowing "something changed" is enough to trigger a
 * refetch, and naming the credential would leak which compartments exist to a user who just lost
 * access to them.
 */
function onAclChanged(event: {
	userIds: string[];
	reason: "grant_added" | "grant_removed" | "user_acl_replaced";
}): void {
	for (const userId of event.userIds) {
		deliver(userId, { type: "knowledge:library_changed", reason: "acl_changed" });
	}
}

/**
 * Ownership moved → notify BOTH parties, since owner is an ACL short-circuit: one of them just
 * gained full access and the other may have lost it.
 */
function onOwnerTransferred(event: {
	targetType: "entry" | "collection";
	targetId: string;
	previousOwnerUserId: string | null;
	newOwnerUserId: string | null;
}): void {
	const affected = new Set(
		[event.previousOwnerUserId, event.newOwnerUserId].filter((id): id is string => !!id),
	);
	for (const userId of affected) {
		deliver(userId, {
			type: "knowledge:library_changed",
			reason: "owner_transferred",
			...(event.targetType === "entry"
				? { entryId: event.targetId }
				: { collectionId: event.targetId }),
		});
	}
}

function guard(label: string, run: () => Promise<void>): void {
	run().catch((err) => {
		logger.error("Knowledge notify handler failed", {
			handler: label,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

let registered = false;

/** Register the knowledge notification listeners. Idempotent. */
export function initKnowledgeNotify(): void {
	if (registered) return;
	registered = true;

	eventBus.on("knowledge:submission_created", (event) => {
		guard("submission_created", () => onSubmissionCreated(event));
	});
	eventBus.on("knowledge:submission_reviewed", (event) => {
		guard("submission_reviewed", () => onSubmissionReviewed(event));
	});
	eventBus.on("knowledge:submission_invalidated", (event) => {
		guard("submission_invalidated", () => onSubmissionInvalidated(event));
	});
	eventBus.on("knowledge:entry_published", (event) => {
		onEntryPublished(event);
	});
	// Library-side signals: things that change a user's knowledge view WITHOUT a submission
	// being involved. All three were previously silent — the user only found out by navigating
	// to the right tab and noticing a banner (drift) or an unexplained permission change.
	eventBus.on("knowledge:entry_drifted", (event) => {
		onEntryDrifted(event);
	});
	eventBus.on("knowledge:acl_changed", (event) => {
		onAclChanged(event);
	});
	eventBus.on("knowledge:owner_transferred", (event) => {
		onOwnerTransferred(event);
	});
}

export const knowledgeNotify = {
	initKnowledgeNotify,
	resolveReviewerUserIds,
	setKnowledgeNotifyPush,
};
