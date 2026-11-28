import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { eventBus } from "../../lib/event-bus";
import type { StartedRun, StartRunInput } from "../agent-runtime/publication";
import { bindRuntimeQueue, type RuntimeQueuePort } from "../agent-runtime/runtime-queue-port";

const realEngine = { ...(await import("../agent-runtime/postgres-runtime-publication")) };
let commit: ReturnType<typeof Promise.withResolvers<StartedRun>>;
let calls = 0;
mock.module("../agent-runtime/postgres-runtime-publication", () => ({
	...realEngine,
	createPostgresRuntimePublication: () => ({
		startRun(_input: StartRunInput) {
			calls++;
			return commit.promise;
		},
	}),
}));
const { getRuntimePublicationService, runtimePublication } = await import(
	"../agent-runtime/publication"
);
runtimePublication.stop();

let invalidations = 0;
const onChange = () => invalidations++;
beforeEach(() => {
	commit = Promise.withResolvers<StartedRun>();
	calls = 0;
	invalidations = 0;
	bindRuntimeQueue({
		backend: "postgres",
		queue: { publicationTx: { handle: {} } } as unknown as RuntimeQueuePort,
	});
	eventBus.on("narrator:execution_principal_changed", onChange);
});
afterEach(() => {
	getRuntimePublicationService().stop();
	bindRuntimeQueue(undefined);
	eventBus.off("narrator:execution_principal_changed", onChange);
});
afterAll(() => {
	mock.module("../agent-runtime/postgres-runtime-publication", () => realEngine);
	mock.restore();
});

test("PG startRun facade invalidates only once the committed engine result resolves", async () => {
	const facade = getRuntimePublicationService();
	expect(facade.backend).toBe("postgres");
	const pending = facade.startRun({
		narratorId: "root",
		binding: { principal: { userId: "bob" } },
	});
	expect(calls).toBe(1);
	expect(invalidations).toBe(0);
	const started: StartedRun = { binding: { logicalRunId: "run", principal: { userId: "bob" } } };
	commit.resolve(started);
	expect(await pending).toBe(started);
	expect(invalidations).toBe(1);
});

test("PG startRun facade preserves commit rejection without invalidation", async () => {
	const pending = getRuntimePublicationService().startRun({ narratorId: "root", binding: {} });
	commit.reject(new Error("PG start commit failed"));
	await expect(pending).rejects.toThrow("PG start commit failed");
	expect(calls).toBe(1);
	expect(invalidations).toBe(0);
});
