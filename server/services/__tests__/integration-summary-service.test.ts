import { expect, test } from "bun:test";
import { resetDbWorkerPoolForTest } from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import { getIntegrationSummary } from "../integration-summary-service";

for (const role of ["user", "admin"] as const) {
	test(`${role} summary fits one normal Worker slot without a queue`, async () => {
		const concurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		const queue = process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
		await resetDbWorkerPoolForTest();
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = "0";
		let error: unknown;
		let summary: Awaited<ReturnType<typeof getIntegrationSummary>> | undefined;
		try {
			summary = await getIntegrationSummary({ userId: generateId(), role, attentionLimit: 10 });
		} catch (caught) {
			error = caught;
		} finally {
			if (concurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
			else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = concurrency;
			if (queue === undefined) delete process.env.NARRAFORK_DB_WORKER_MAX_QUEUED;
			else process.env.NARRAFORK_DB_WORKER_MAX_QUEUED = queue;
			await resetDbWorkerPoolForTest();
		}
		expect(error).toBeUndefined();
		expect(summary?.connectedApps).toEqual({ active: 0, revoked: 0 });
		expect(Boolean(summary?.admin)).toBe(role === "admin");
	});
}
