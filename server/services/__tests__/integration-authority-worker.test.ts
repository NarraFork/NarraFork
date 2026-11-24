import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../../db";
import { integrationAuthorities, integrationCapabilityGrants } from "../../db/schema";
import { readIntegrationAuthoritySnapshotTask } from "../../lib/db-worker/integration-authority-read-task";
import * as pool from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import { WorkerHandle } from "../../lib/worker-runtime/lifecycle";
import { integrationAuthorityService } from "../integration-authority-service";

const now = "2026-01-01T00:00:00.000Z";
let authorityId: string;
beforeEach(() => {
	authorityId = generateId();
	db.insert(integrationAuthorities)
		.values({
			id: authorityId,
			kind: "plugin_installation",
			integrationType: "plugin",
			integrationId: "worker-fixture",
			policyJson: { allow: true },
			metadataJson: { origin: "fixture" },
			createdAt: now,
			updatedAt: now,
		})
		.run();
});
afterEach(() => {
	db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, authorityId)).run();
});
afterAll(() => pool.closeReadDatabase(sqlite.filename));

function grant(id: string, input: { expiresAt?: string; revokedAt?: string } = {}) {
	db.insert(integrationCapabilityGrants)
		.values({
			id,
			authorityId,
			capabilityId: "project.read",
			scopeType: "project",
			scopeId: id,
			scopeKey: `project:${id}`,
			constraintsJson: { methods: ["read"] },
			createdByType: "system",
			createdAt: now,
			updatedAt: now,
			...input,
		})
		.run();
}
function snapshot(includeExpired = false) {
	return readIntegrationAuthoritySnapshotTask(sqlite, { authorityId, includeExpired, now });
}

test("the snapshot preserves row mapping, grant order and expiry/revocation filters", async () => {
	grant("z");
	grant("a");
	grant("expired", { expiresAt: "2025-01-01T00:00:00.000Z" });
	grant("revoked", { revokedAt: now });
	expect(snapshot()).toMatchObject({
		storedAuthority: {
			id: authorityId,
			revision: 1,
			policyJson: { allow: true },
			metadataJson: { origin: "fixture" },
		},
		grants: [
			{ id: "a", constraintsJson: '{"methods":["read"]}' },
			{ id: "z", constraintsJson: '{"methods":["read"]}' },
		],
	});
	expect(snapshot(true).grants.map((row) => row.id)).toEqual(["a", "expired", "z"]);
	const live = await integrationAuthorityService.getSnapshot(authorityId, { includeExpired: true });
	expect(live?.authority ?? null).toEqual(snapshot(true).storedAuthority);
	expect(live?.grants.map((row) => row.id)).toEqual(["a", "expired", "z"]);
	expect(live?.grants[0]?.constraintsJson).toEqual({ methods: ["read"] });
	expect(sqlite.inTransaction).toBe(false);
});

test("empty grants and absent authorities retain distinct empty/null results", async () => {
	expect(snapshot().grants).toEqual([]);
	expect((await integrationAuthorityService.getSnapshot(authorityId))?.grants).toEqual([]);
	expect(
		readIntegrationAuthoritySnapshotTask(sqlite, {
			authorityId: "missing",
			includeExpired: false,
			now,
		}),
	).toEqual({ storedAuthority: null, grants: [] });
	expect(await integrationAuthorityService.getSnapshot("missing")).toBeNull();
});

test("integration listings do not flood the bounded Worker queue", async () => {
	const integrationId = `batch-${authorityId}`;
	const ids = Array.from({ length: 65 }, () => generateId());
	db.insert(integrationAuthorities)
		.values(
			ids.map((id) => ({
				id,
				kind: "plugin_installation" as const,
				integrationType: "plugin" as const,
				integrationId,
				createdAt: now,
				updatedAt: now,
			})),
		)
		.run();
	try {
		const snapshots = await integrationAuthorityService.listForIntegration({
			kind: "plugin_installation",
			integrationId,
		});
		expect(snapshots).toHaveLength(65);
		expect(new Set(snapshots.map((snapshot) => snapshot.authority.id))).toEqual(new Set(ids));
	} finally {
		db.delete(integrationAuthorities)
			.where(eq(integrationAuthorities.integrationId, integrationId))
			.run();
	}
});

test("the source row cap retains one overflow row for the service to reject", async () => {
	sqlite.transaction(() => {
		for (let index = 0; index < 2002; index++) grant(`grant-${index.toString().padStart(4, "0")}`);
	})();
	expect(snapshot().grants).toHaveLength(2001);
	const error = await integrationAuthorityService.getSnapshot(authorityId).catch((error) => error);
	expect(error).toMatchObject({ code: "INTEGRATION_GRANT_LIMIT_EXCEEDED" });
});

test.each([
	"constraints",
	"policy",
	"metadata",
] as const)("oversized %s fails before parsing or returning truncated JSON", async (field) => {
	grant("grant");
	const encoded = JSON.stringify({ text: "界".repeat(field === "constraints" ? 1400 : 2800) });
	if (field === "constraints")
		sqlite
			.query("UPDATE integration_capability_grants SET constraints_json = ? WHERE authority_id = ?")
			.run(encoded, authorityId);
	else if (field === "policy")
		sqlite
			.query("UPDATE integration_authorities SET policy_json = ? WHERE id = ?")
			.run(encoded, authorityId);
	else
		sqlite
			.query("UPDATE integration_authorities SET metadata_json = ? WHERE id = ?")
			.run(encoded, authorityId);
	expect(snapshot).toThrow();
	const error = await integrationAuthorityService.getSnapshot(authorityId).catch((error) => error);
	expect(error).toMatchObject({ code: "DB_READ_BUDGET" });
	expect(sqlite.inTransaction).toBe(false);
});

test("a Worker snapshot forwards the caller budget and never SELECTs on its owning connection", async () => {
	grant("grant");
	const request = new AbortController();
	const options = { signal: request.signal, deadlineAt: Date.now() + 10_000 };
	const reads = spyOn(pool, "runReadTask");
	const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
		throw new Error("main prepare");
	});
	const query = spyOn(sqlite, "query").mockImplementation(() => {
		throw new Error("main query");
	});
	try {
		expect(
			(await integrationAuthorityService.getSnapshot(authorityId, {}, options))?.grants,
		).toHaveLength(1);
		expect(reads).toHaveBeenCalledTimes(1);
		expect(reads.mock.calls[0]?.[1]).toMatchObject({
			kind: "domainRead",
			task: "platformIntegrationAuthoritySnapshot",
			input: { authorityId },
		});
		expect(reads.mock.calls[0]?.[2]).toMatchObject(options);
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
		reads.mockRestore();
	}
});

test.each([
	"creation",
	"disabled",
	"runtime",
	"timeout",
] as const)("%s failure cannot fall back to the owning connection", async (mode) => {
	await pool.resetDbWorkerPoolForTest();
	const previous = process.env.NARRAFORK_DB_WORKER;
	const spawn =
		mode === "creation"
			? spyOn(WorkerHandle, "thread").mockImplementation(() => {
					throw new Error("fixture creation failure");
				})
			: undefined;
	const failure = new pool.DbReadTaskExecutionError("fixture runtime failure");
	const dispatch =
		mode === "runtime" ? spyOn(pool, "runReadTask").mockRejectedValue(failure) : undefined;
	if (mode === "disabled") process.env.NARRAFORK_DB_WORKER = "off";
	const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
		throw new Error("main prepare");
	});
	const query = spyOn(sqlite, "query").mockImplementation(() => {
		throw new Error("main query");
	});
	try {
		const result = await integrationAuthorityService
			.getSnapshot(authorityId, {}, mode === "timeout" ? { deadlineAt: Date.now() - 1 } : undefined)
			.catch((error) => error);
		if (mode === "runtime") expect(result).toBe(failure);
		else
			expect(result).toMatchObject({
				code: mode === "timeout" ? "DB_READ_TASK_TIMEOUT" : "DB_READ_UNAVAILABLE",
			});
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
		spawn?.mockRestore();
		dispatch?.mockRestore();
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = previous;
		await pool.resetDbWorkerPoolForTest();
	}
});
