import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	aclGrants,
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeTags,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { knowledgeReadStore } from "../knowledge/store";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { resolveInjections, scanToolOutputForKnowledgeDetailed } from "../knowledge-injection";
import { knowledgeInjectionReads, knowledgeService } from "../knowledge-service";

let userId: string;
let collectionId: string;
const keyword = "evidencekeyword";

beforeAll(async () => {
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: userId,
		passwordHash: "unused",
		role: "user",
		createdAt: new Date().toISOString(),
	});
});
beforeEach(async () => {
	collectionId = (await knowledgeService.createCollection({ name: generateId() })).id;
});
afterEach(() => mock.restore());

function createEntry(content = "Original evidence") {
	return knowledgeService.createEntry({
		collectionId,
		title: "Evidence title",
		content,
		keywords: [keyword],
	});
}

function changeAfterCandidates(change: () => Promise<void>) {
	const original = knowledgeInjectionReads.listKeywordInjectionCandidates;
	return spyOn(knowledgeInjectionReads, "listKeywordInjectionCandidates").mockImplementationOnce(
		async (options) => {
			const candidates = await original(options);
			await change();
			return candidates;
		},
	);
}

function changeAfterAclCheck(change: () => Promise<void>) {
	const original = knowledgeService.filterReadable;
	return spyOn(knowledgeService, "filterReadable").mockImplementationOnce(
		async (principal, rows, options) => {
			const readable = await original(principal, rows, options);
			await change();
			return readable;
		},
	);
}

describe("knowledge injection evidence", () => {
	test("unchanged evidence retains a matching revision and bounded excerpt", async () => {
		const entry = await createEntry("可读证据".repeat(1000));
		const hits = await resolveInjections(userId, keyword, { collectionId });
		expect(hits).toHaveLength(1);
		expect(hits[0]?.entryId).toBe(entry.id);
		expect(hits[0]?.entryRevisionId).toBe(entry.currentRevisionId);
		// Existing excerpt contract allows one trailing ellipsis after 320 code units.
		expect(hits[0]?.summary.length).toBeLessThanOrEqual(321);
	});

	test("a revision published after candidate discovery is paired with its own excerpt", async () => {
		const entry = await createEntry();
		let revisionId = "";
		const changed = changeAfterCandidates(async () => {
			const revision = await knowledgeService.addRevision(entry.id, {
				content: "Current evidence",
			});
			revisionId = revision.revisionId;
		});
		const hits = await resolveInjections(userId, keyword, { collectionId });
		expect(changed).toHaveBeenCalledTimes(1);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.entryRevisionId).toBe(revisionId);
		expect(hits[0]?.summary).toBe("Current evidence");
	});

	test("a warm dictionary cannot resurrect a removed keyword with an unchanged signature", async () => {
		const entry = await createEntry();
		expect(await resolveInjections(userId, keyword, { collectionId })).toHaveLength(1);
		await db
			.update(knowledgeEntries)
			.set({
				keywordsJson: ["differentkeyword"],
				currentKeywords: "differentkeyword",
			})
			.where(eq(knowledgeEntries.id, entry.id));
		expect(await resolveInjections(userId, keyword, { collectionId })).toEqual([]);
	});

	test("metadata is taken from the same current row as the excerpt, not a warm cache", async () => {
		const entry = await createEntry();
		await resolveInjections(userId, keyword, { collectionId });
		await db
			.update(knowledgeEntries)
			.set({ title: "Current title" })
			.where(eq(knowledgeEntries.id, entry.id));
		const hits = await resolveInjections(userId, keyword, { collectionId });
		expect(hits[0]?.title).toBe("Current title");
	});

	test.each([
		"archive",
		"delete",
		"move",
	] as const)("%s after the first ACL check invalidates evidence", async (action) => {
		const entry = await createEntry();
		const changed = changeAfterAclCheck(async () => {
			if (action === "delete") {
				await db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, entry.id));
			} else if (action === "archive") {
				await db
					.update(knowledgeEntries)
					.set({ status: "archived" })
					.where(eq(knowledgeEntries.id, entry.id));
			} else {
				const other = await knowledgeService.createCollection({ name: generateId() });
				await db
					.update(knowledgeEntries)
					.set({ collectionId: other.id })
					.where(eq(knowledgeEntries.id, entry.id));
			}
		});
		expect(await resolveInjections(userId, keyword, { collectionId })).toEqual([]);
		expect(changed).toHaveBeenCalled();
	});

	test("revocation after the first ACL check cannot expose a snippet", async () => {
		const entry = await createEntry();
		const changed = changeAfterAclCheck(async () => {
			await db
				.update(knowledgeEntries)
				.set({ controlledTagsJson: ["revoked-compartment"] })
				.where(eq(knowledgeEntries.id, entry.id));
		});
		expect(await resolveInjections(userId, keyword, { collectionId })).toEqual([]);
		expect(changed).toHaveBeenCalled();
	});

	test("an already-cancelled request performs no candidate reads", async () => {
		await createEntry();
		const controller = new AbortController();
		controller.abort(new Error("cancel evidence"));
		const read = spyOn(knowledgeInjectionReads, "listKeywordInjectionCandidates");
		const options = { collectionId, signal: controller.signal };
		await expect(resolveInjections(userId, keyword, options)).rejects.toThrow("cancel evidence");
		expect(read).not.toHaveBeenCalled();
	});

	test("cancellation while candidates are read is not swallowed as an empty result", async () => {
		await createEntry();
		const controller = new AbortController();
		const changed = changeAfterCandidates(async () => {
			controller.abort(new Error("cancel evidence"));
		});
		const options = { collectionId, signal: controller.signal };
		await expect(resolveInjections(userId, keyword, options)).rejects.toThrow("cancel evidence");
		expect(changed).toHaveBeenCalled();
	});

	test("the UTF-8 evidence budget omits whole hits instead of truncating their references", async () => {
		await createEntry("中文证据".repeat(100));
		for (const byteBudget of [0, 80, Number.NaN]) {
			const options = { collectionId, byteBudget };
			expect(await resolveInjections(userId, keyword, options)).toEqual([]);
		}
		const options = { collectionId, byteBudget: 2048 };
		const hits = await resolveInjections(userId, keyword, options);
		expect(hits).toHaveLength(1);
		expect(Buffer.byteLength(JSON.stringify(hits), "utf8")).toBeLessThanOrEqual(options.byteBudget);
	});
	test.each([
		1, 2,
	])("grant revocation during evidence read %i is checked before returning", async (readNumber) => {
		const entry = await createEntry();
		const tagId = generateId();
		await db
			.insert(knowledgeTags)
			.values({ id: tagId, name: tagId, controlled: true, createdAt: new Date().toISOString() });
		await db
			.update(knowledgeEntries)
			.set({ controlledTagsJson: [tagId] })
			.where(eq(knowledgeEntries.id, entry.id));
		const grantId = generateId();
		await db.insert(aclGrants).values({
			id: grantId,
			scopeType: "global",
			principalType: "user",
			principalId: userId,
			capability: "read",
			domainKind: "tag",
			domainValue: tagId,
			createdAt: new Date().toISOString(),
		});
		expect(await resolveInjections(userId, keyword, { collectionId })).toHaveLength(1);
		let reads = 0;
		const original = knowledgeReadStore.getInjectionEvidence;
		spyOn(knowledgeReadStore, "getInjectionEvidence").mockImplementation(async (opts) => {
			const result = await original(opts);
			if (++reads === readNumber) await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
			return result;
		});
		expect(await resolveInjections(userId, keyword, { collectionId })).toEqual([]);
		expect(reads).toBeGreaterThanOrEqual(readNumber);
	});

	test("personal evidence is omitted if archived while its first snapshot is read", async () => {
		const personalKeyword = `personal${generateId()}`;
		const personal = await knowledgeBranchService.createStandalone(
			{ userId, role: "user" },
			{
				title: "Private evidence",
				content: "private body",
				keywords: [personalKeyword],
			},
		);
		const original = knowledgeReadStore.getInjectionEvidence;
		spyOn(knowledgeReadStore, "getInjectionEvidence").mockImplementationOnce(async (opts) => {
			const rows = await original(opts);
			await db
				.update(knowledgeDrafts)
				.set({ status: "archived" })
				.where(eq(knowledgeDrafts.id, personal.id));
			return rows;
		});
		expect(await resolveInjections(userId, personalKeyword)).toEqual([]);
	});

	test("tool-output cancellation never mutates the compact-cycle dedupe set", async () => {
		await createEntry();
		const controller = new AbortController();
		controller.abort(new Error("stop tool-output scan"));
		const already = new Set<string>();
		const options = { collectionId, signal: controller.signal };
		await expect(
			scanToolOutputForKnowledgeDetailed(userId, keyword, already, options),
		).rejects.toThrow("stop tool-output scan");
		expect(already.size).toBe(0);
	});
});
