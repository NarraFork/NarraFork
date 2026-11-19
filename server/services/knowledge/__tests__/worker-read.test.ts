import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { knowledgeCollections, knowledgeEntries } from "../../../db/schema";
import { readDomainTask } from "../../../db/worker-read";
import { generateId } from "../../../lib/id";
import { getNarratorWorkerTestDb } from "../../__tests__/narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
beforeAll(() => fixture.ready);
afterAll(() => fixture.close());

test("entry detail preserves legal large metadata and UTF-8 chunk boundaries in a Worker", async () => {
	const collectionId = generateId(),
		entryId = generateId(),
		now = new Date().toISOString();
	fixture.db
		.insert(knowledgeCollections)
		.values({
			id: collectionId,
			name: collectionId,
			slug: collectionId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const currentContent = `${"x".repeat(128 * 1024 - 1)}😀中文`;
	const metadata = { note: "m".repeat(5 * 1024 * 1024) };
	fixture.db
		.insert(knowledgeEntries)
		.values({
			id: entryId,
			collectionId,
			title: "entry",
			slug: entryId,
			currentContent,
			metadataJson: metadata,
			tagsJson: ["tag"],
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const forbidden = () => {
		throw new Error("Owning connection must not execute a SELECT");
	};
	const prepare = spyOn(fixture.sqlite, "prepare").mockImplementation(forbidden);
	const query = spyOn(fixture.sqlite, "query").mockImplementation(forbidden);
	try {
		const row = await readDomainTask(
			fixture.sqlite,
			"knowledgeEntryDetail",
			{ entryId },
			{ executionPolicy: "worker-required" },
		);
		expect(row?.currentContent).toBe(currentContent);
		expect(JSON.parse(row?.metadataJson ?? "null")).toEqual(metadata);
		expect(JSON.parse(row?.tagsJson ?? "null")).toEqual(["tag"]);
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
	}
});

test("cancelled entry reads reject rather than returning a missing entry", async () => {
	await expect(
		readDomainTask(
			fixture.sqlite,
			"knowledgeEntryDetail",
			{ entryId: "missing" },
			{ executionPolicy: "worker-required", signal: AbortSignal.abort() },
		),
	).rejects.toMatchObject({ code: "DB_READ_ABORTED" });
});
