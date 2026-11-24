import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, sqlite } from "../../../db";
import {
	knowledgeCollections,
	knowledgeDrafts,
	knowledgeEntries,
	projects,
	users,
} from "../../../db/schema";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	setDbWorkerSpecifiersForTest,
	WorkersUnavailableError,
} from "../../../lib/db-worker/pool";
import {
	captureWorkerRejection,
	captureWorkerRejectionThrower,
} from "../../__tests__/narrator-worker-fixture";
import { sqliteKnowledgeInjectionReads, sqliteKnowledgeReadStore } from "../sqlite-read-store";

const older = "2026-01-01T00:00:00.000Z";
const newer = "2026-02-01T00:00:00.000Z";
const excluded = "2026-03-01T00:00:00.000Z";
const timestamps = { createdAt: older, updatedAt: older };

beforeAll(async () => {
	expect(sqlite.filename).not.toBe(":memory:");
	await db
		.insert(projects)
		.values(
			["signature-project", "signature-other"].map((id) => ({ id, name: id, ...timestamps })),
		);
	await db.insert(knowledgeCollections).values(
		[
			{ id: "sig-shared", projectId: null },
			{ id: "sig-local", projectId: "signature-project" },
			{ id: "sig-other", projectId: "signature-other" },
		].map((row) => ({ ...row, name: row.id, slug: row.id, ...timestamps })),
	);
	const entry = (id: string, collectionId: string) => ({
		id,
		collectionId,
		title: id,
		slug: id,
		currentKeywords: "keyword",
		...timestamps,
	});
	await db
		.insert(knowledgeEntries)
		.values([
			entry("sig-shared-entry", "sig-shared"),
			{ ...entry("sig-local-entry", "sig-local"), updatedAt: newer },
			{ ...entry("sig-other-entry", "sig-other"), updatedAt: excluded },
			{ ...entry("sig-keywordless", "sig-local"), currentKeywords: null, updatedAt: excluded },
			{ ...entry("sig-archived", "sig-local"), status: "archived", updatedAt: excluded },
		]);
	await db.insert(users).values(
		["sig-author", "sig-other-author"].map((id) => ({
			id,
			username: id,
			passwordHash: "test",
			createdAt: older,
		})),
	);
	const draft = (id: string, targetCollectionId: string | null) => ({
		id,
		targetCollectionId,
		authorUserId: "sig-author",
		content: "",
		contentHash: "test",
		keywordsJson: ["keyword"],
		...timestamps,
	});
	await db.insert(knowledgeDrafts).values([
		draft("sig-draft-global", null),
		{ ...draft("sig-draft-local", "sig-local"), updatedAt: newer },
		{ ...draft("sig-draft-other", "sig-other"), updatedAt: excluded },
		{
			...draft("sig-draft-foreign", "sig-local"),
			authorUserId: "sig-other-author",
			updatedAt: excluded,
		},
		{
			...draft("sig-draft-linked", "sig-local"),
			entryId: "sig-local-entry",
			updatedAt: excluded,
		},
		{ ...draft("sig-draft-keywordless", "sig-local"), keywordsJson: null, updatedAt: excluded },
		{ ...draft("sig-draft-archived", "sig-local"), status: "archived", updatedAt: excluded },
	]);
});

afterAll(resetDbWorkerPoolForTest);

describe("SQLite keyword matcher signatures", () => {
	test("ordinary Worker matches the compatibility read and respects project and collection", async () => {
		const scoped = { projectId: "signature-project" };
		const value = await sqliteKnowledgeReadStore.keywordInjectionCandidatesSignature(scoped);
		expect(getDbWorkerPoolStats().workers).toBeGreaterThan(0);
		expect(value).toBe(`2:${newer}`);
		expect(value).toBe(
			await sqliteKnowledgeInjectionReads.keywordInjectionCandidatesSignature(scoped),
		);
		expect(
			await sqliteKnowledgeReadStore.keywordInjectionCandidatesSignature({
				...scoped,
				collectionId: "sig-local",
			}),
		).toBe(`1:${newer}`);
		expect(
			await sqliteKnowledgeReadStore.keywordInjectionCandidatesSignature({
				...scoped,
				collectionId: "sig-other",
			}),
		).toBe("0:");
	});

	test("personal signature is scoped to the author and matching standalone drafts", async () => {
		const scoped = { projectId: "signature-project", userId: "sig-author" };
		expect(await sqliteKnowledgeReadStore.personalKeywordInjectionSignature(scoped)).toBe(
			`2:${newer}`,
		);
		expect(
			await sqliteKnowledgeReadStore.personalKeywordInjectionSignature({
				...scoped,
				collectionId: "sig-local",
			}),
		).toBe(`1:${newer}`);
		expect(
			await sqliteKnowledgeReadStore.personalKeywordInjectionSignature({
				...scoped,
				userId: "missing",
			}),
		).toBe("0:");
	});

	test("a cancelled request fails without starting a Worker", async () => {
		await resetDbWorkerPoolForTest();
		const signal = AbortSignal.abort(new DOMException("Stopped", "AbortError"));
		expect(
			await captureWorkerRejectionThrower(
				sqliteKnowledgeReadStore.keywordInjectionCandidatesSignature({ signal }),
			),
		).toThrow("database read task aborted");
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test("Worker startup failure does not redo the aggregate on the main connection", async () => {
		await resetDbWorkerPoolForTest();
		setDbWorkerSpecifiersForTest([new URL("./missing-signature-worker.ts", import.meta.url).href]);
		try {
			expect(
				await captureWorkerRejection(
					sqliteKnowledgeReadStore.keywordInjectionCandidatesSignature({
						projectId: "signature-project",
					}),
				),
			).toBeInstanceOf(WorkersUnavailableError);
		} finally {
			await resetDbWorkerPoolForTest();
		}
	});

	test("disabled Workers reject both the read store and compatibility injection reads", async () => {
		const previous = process.env.NARRAFORK_DB_WORKER;
		process.env.NARRAFORK_DB_WORKER = "off";
		try {
			expect(
				await captureWorkerRejection(
					sqliteKnowledgeReadStore.keywordInjectionCandidatesSignature({}),
				),
			).toBeInstanceOf(WorkersUnavailableError);
			expect(
				await captureWorkerRejection(
					sqliteKnowledgeReadStore.personalKeywordInjectionSignature({ userId: "sig-author" }),
				),
			).toBeInstanceOf(WorkersUnavailableError);
			expect(
				await captureWorkerRejection(
					sqliteKnowledgeInjectionReads.keywordInjectionCandidatesSignature({
						projectId: "signature-project",
					}),
				),
			).toBeInstanceOf(WorkersUnavailableError);
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
	});
});
