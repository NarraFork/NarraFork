import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqlite as template } from "../db";
import * as schema from "../db/schema";
import { closeFileWorkerDatabase, openFileWorkerDatabase } from "./__tests__/file-worker-database";
import { FileChangeBlobCatalog } from "./file-change-blob-catalog";
import { FileChangeEvidenceService } from "./file-change-evidence";

let sqlite: Database;
const wrap = (client: Database) => drizzle(client, { schema });
let database: ReturnType<typeof wrap>;
let evidence: FileChangeEvidenceService;
let scopeId: string;
const restores: Array<() => void> = [];

beforeEach(() => {
	sqlite = openFileWorkerDatabase(template);
	database = wrap(sqlite);
	evidence = new FileChangeEvidenceService(database);
	scopeId = evidence.prepareScope({
		sourceInstanceId: "worker-source",
		deviceId: "local",
		workspaceInstanceId: "worker-workspace",
		pathFlavor: "posix",
		canonicalRoot: "/worker-fixture",
	}).id;
});
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	await closeFileWorkerDatabase(sqlite);
});

function forbidMainReads() {
	const query = spyOn(sqlite, "query").mockImplementation(() => {
		throw new Error("metadata read reached the owning SQLite connection");
	});
	const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
		throw new Error("metadata prepare reached the owning SQLite connection");
	});
	restores.push(
		() => query.mockRestore(),
		() => prepare.mockRestore(),
	);
}

describe("file metadata Worker boundary", () => {
	test("scope, operation pages and editor evidence use the explicit file-backed reader", async () => {
		forbidMainReads();
		expect(await evidence.getScope(scopeId)).toMatchObject({
			id: scopeId,
			canonicalRoot: "/worker-fixture",
		});
		expect(await evidence.getOperation("missing-operation")).toBeNull();
		expect(await evidence.getEditorOperation("worker-source", "missing-editor")).toBeNull();
		expect(await evidence.getEffect("missing-operation", "missing-mutation")).toBeNull();
		expect((await evidence.listEffects("missing-operation")).items).toEqual([]);
		expect((await evidence.listPendingOperations({ settlement: "preparing" })).items).toEqual([]);
		expect(await evidence.getEditorSnapshot("worker-source", "missing-editor")).toEqual({
			operation: null,
			effects: [],
		});
	});

	test("catalog snapshots read budget and metadata without preparing on the owner", async () => {
		const catalog = new FileChangeBlobCatalog({ db: database, namespaceKey: "worker-namespace" });
		catalog.initializeNamespace({ quotaBytes: 16 });
		forbidMainReads();
		expect(await catalog.getBudget()).toMatchObject({
			namespaceKey: "worker-namespace",
			quotaBytes: 16,
		});
		expect(
			await catalog.getMetadata({
				ref: { algorithm: "sha256", digest: "a".repeat(64), sizeBytes: 1 },
			}),
		).toBeNull();
		expect((await catalog.listReservations({ status: "reserved", limit: 2 })).items).toEqual([]);
	});

	test("cancelled metadata requests fail instead of using the owner connection", async () => {
		forbidMainReads();
		await expect(evidence.getScope(scopeId, { signal: AbortSignal.abort() })).rejects.toMatchObject(
			{ code: "DB_READ_ABORTED" },
		);
	});

	test("uncommitted caller transactions are never treated as Worker-visible metadata", async () => {
		let pending: Promise<unknown> = Promise.resolve();
		sqlite.transaction(() => {
			pending = evidence.getScope(scopeId);
		})();
		await expect(pending).rejects.toMatchObject({ code: "DB_READ_UNSUPPORTED" });
	});

	test("in-memory metadata has no implicit synchronous fallback", async () => {
		const memory = new Database(":memory:");
		try {
			const service = new FileChangeEvidenceService(wrap(memory));
			await expect(service.getScope(scopeId)).rejects.toMatchObject({
				code: "DB_READ_UNSUPPORTED",
			});
		} finally {
			memory.close(true);
		}
	});
});
