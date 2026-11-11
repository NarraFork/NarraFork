import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeEntries, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { resolveInjections } from "../knowledge-injection";
import { knowledgeService } from "../knowledge-service";

let userId: string;
let collectionId: string;
const query = "hybridneedle";

beforeAll(async () => {
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: userId,
		role: "user",
		passwordHash: "unused",
		createdAt: new Date().toISOString(),
	});
});
beforeEach(async () => {
	collectionId = (await knowledgeService.createCollection({ name: generateId() })).id;
});
afterEach(() => mock.restore());

function enableHybrid() {
	Object.assign(settings.knowledge, { retrievalMode: "hybrid" });
}

function entry(title: string, content: string, keywords?: string[]) {
	return knowledgeService.createEntry({ collectionId, title, content, keywords });
}

describe("hybrid knowledge retrieval", () => {
	test("the legacy default remains keyword-only and makes no full-text query", async () => {
		const bodyOnly = await entry("No keyword", `Body contains ${query}`);
		const search = spyOn(knowledgeService, "search");
		expect(await resolveInjections(userId, query, { collectionId })).toEqual([]);
		expect(search).not.toHaveBeenCalled();
		expect(bodyOnly.id).toBeString();
	});

	test("explicit hybrid mode finds body evidence without author-declared keywords", async () => {
		const bodyOnly = await entry("Body-only", `Evidence containing ${query}`);
		enableHybrid();
		const hits = await resolveInjections(userId, query, { collectionId });
		expect(hits).toHaveLength(1);
		expect(hits[0]?.entryId).toBe(bodyOnly.id);
		expect(hits[0]?.entryRevisionId).toBe(bodyOnly.currentRevisionId);
		expect(hits[0]?.summary).toContain(query);
	});

	test("keywords outrank body-only hits and both channels merge without duplicate entries", async () => {
		const keywordOnly = await entry("Declared", "Explicit instructions", [query]);
		const bodyOnly = await entry("Body", query);
		const both = await entry("Both", query, [query]);
		enableHybrid();
		const hits = await resolveInjections(userId, query, { collectionId });
		const ids = hits.map((hit) => hit.entryId);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		expect(ids.indexOf(keywordOnly.id)).toBeLessThan(ids.indexOf(bodyOnly.id));
		expect(ids.indexOf(both.id)).toBeLessThan(ids.indexOf(bodyOnly.id));
	});

	test("an exact title outranks a body-only hit and ties remain deterministic", async () => {
		const titleHit = await entry(query, "Title-specific evidence");
		await entry("Body matching", query.repeat(12));
		enableHybrid();
		const first = await resolveInjections(userId, query, { collectionId });
		const second = await resolveInjections(userId, query, { collectionId });
		expect(first[0]?.entryId).toBe(titleHit.id);
		expect(first.map((hit) => hit.entryId)).toEqual(second.map((hit) => hit.entryId));
	});

	test("body excerpts beyond the prefix remain pinned to the searched revision", async () => {
		const far = await entry(
			"Far evidence",
			`${"ordinary text ".repeat(500)} ${query} useful details`,
		);
		enableHybrid();
		const hits = await resolveInjections(userId, query, { collectionId });
		expect(hits[0]?.entryId).toBe(far.id);
		expect(hits[0]?.summary).toContain(query);
		expect(hits[0]?.entryRevisionId).toBe(far.currentRevisionId);
	});

	test("a revision changed after search cannot reuse stale full-text evidence", async () => {
		const old = await entry("Old hit", query);
		enableHybrid();
		const search = knowledgeService.search;
		const changed = spyOn(knowledgeService, "search").mockImplementationOnce(async (opts) => {
			const rows = await search(opts);
			await knowledgeService.addRevision(old.id, { content: "No matching evidence remains" });
			return rows;
		});
		expect(await resolveInjections(userId, query, { collectionId })).toEqual([]);
		expect(changed).toHaveBeenCalled();
	});

	test("unreadable and archived body hits never appear", async () => {
		const secret = await entry("Secret", query);
		const archived = await entry("Archived", query);
		await db
			.update(knowledgeEntries)
			.set({ controlledTagsJson: ["not-granted"] })
			.where(eq(knowledgeEntries.id, secret.id));
		await db
			.update(knowledgeEntries)
			.set({ status: "archived" })
			.where(eq(knowledgeEntries.id, archived.id));
		enableHybrid();
		expect(await resolveInjections(userId, query, { collectionId })).toEqual([]);
	});

	test("full-text project scope includes only the selected project plus global collections", async () => {
		const projectId = generateId();
		const otherId = generateId();
		const now = new Date().toISOString();
		await db
			.insert(projects)
			.values([projectId, otherId].map((id) => ({ id, name: id, createdAt: now, updatedAt: now })));
		const local = await knowledgeService.createCollection({ name: generateId(), projectId });
		const other = await knowledgeService.createCollection({
			name: generateId(),
			projectId: otherId,
		});
		const term = `scope${generateId()}`;
		const globalEntry = await entry("Global", term);
		const localEntry = await knowledgeService.createEntry({
			collectionId: local.id,
			title: "Local",
			content: term,
		});
		const otherEntry = await knowledgeService.createEntry({
			collectionId: other.id,
			title: "Other",
			content: term,
		});
		enableHybrid();
		const ids = (await resolveInjections(userId, term, { projectId })).map((hit) => hit.entryId);
		expect(ids).toContain(globalEntry.id);
		expect(ids).toContain(localEntry.id);
		expect(ids).not.toContain(otherEntry.id);
	});

	test("full-text query input and result count are bounded and carry a cancellable signal", async () => {
		enableHybrid();
		const search = spyOn(knowledgeService, "search").mockResolvedValue([]);
		await resolveInjections(userId, `${query} `.repeat(1000), { collectionId });
		expect(search).toHaveBeenCalledTimes(1);
		const opts = search.mock.calls[0]?.[0];
		expect(opts?.q?.length).toBeLessThanOrEqual(512);
		expect(opts?.limit).toBeLessThanOrEqual(50);
		expect(opts?.signal).toBeInstanceOf(AbortSignal);
	});

	test("punctuation-only input does not become a browse-all search", async () => {
		enableHybrid();
		const search = spyOn(knowledgeService, "search");
		expect(await resolveInjections(userId, "*** () [] :;", { collectionId })).toEqual([]);
		expect(search).not.toHaveBeenCalled();
	});

	test("full-text failure keeps exact keyword evidence instead of failing the request", async () => {
		const exact = await entry("Exact", "Body", [query]);
		enableHybrid();
		spyOn(knowledgeService, "search").mockRejectedValue(new Error("unavailable"));
		expect((await resolveInjections(userId, query, { collectionId }))[0]?.entryId).toBe(exact.id);
	});
});
