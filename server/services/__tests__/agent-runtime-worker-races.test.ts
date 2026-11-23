import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import * as bridge from "../../db/worker-read";
import { DbReadError } from "../../lib/db-worker/errors";
import { createRuntimeFinalizationReads } from "../agent-runtime/finalization-reads";
import { createMailboxStore } from "../agent-runtime/mailbox";
import { createRuntimePublicationService } from "../agent-runtime/publication";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const finalization = createRuntimeFinalizationReads(db);
const mailbox = createMailboxStore(db);
const publication = createRuntimePublicationService(db);
publication.stop();
const time = "2026-10-02T00:00:00.000Z";
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators).values({ id: "actor", createdAt: time, updatedAt: time }).run();
});
afterEach(() => mock.restore());
afterAll(async () => await closeRuntimeTestDb(sqlite));

function afterSnapshot(write: () => void) {
	const original = bridge.readQueryFirst;
	let injected = false;
	spyOn(bridge, "readQueryFirst").mockImplementation(
		async <T>(
			query: PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } },
			options?: bridge.ReadQueryOptions,
		): Promise<T | undefined> => {
			const row = await original(query, options);
			if (!injected) {
				injected = true;
				write();
			}
			return row;
		},
	);
	return () => expect(injected).toBe(true);
}

test("finalization handles empty and normal observations", async () => {
	expect(await finalization.restoreModel("missing")).toBeUndefined();
	expect(await finalization.clearTransientSubstatus("missing")).toBeUndefined();
	db.update(narrators)
		.set({
			model: "temporary",
			pendingModelRestore: "original",
			substatus: JSON.stringify(["reasoning", "unread", "reflecting"]),
		})
		.where(eq(narrators.id, "actor"))
		.run();
	expect(await finalization.restoreModel("actor")).toBe("original");
	expect(await finalization.clearTransientSubstatus("actor")).toEqual(["unread"]);
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()).toMatchObject({
		model: "original",
		pendingModelRestore: null,
		substatus: '["unread"]',
	});
});

for (const changed of ["model", "pending"] as const)
	test(`model restore rejects a concurrent ${changed} update`, async () => {
		db.update(narrators)
			.set({ model: "temporary", pendingModelRestore: "original" })
			.where(eq(narrators.id, "actor"))
			.run();
		const injected = afterSnapshot(() => {
			db.update(narrators)
				.set(changed === "model" ? { model: "concurrent" } : { pendingModelRestore: "concurrent" })
				.where(eq(narrators.id, "actor"))
				.run();
		});
		const error = await finalization.restoreModel("actor").catch((error) => error);
		injected();
		expect(error).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
		expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()).toMatchObject(
			changed === "model"
				? { model: "concurrent", pendingModelRestore: "original" }
				: { model: "temporary", pendingModelRestore: "concurrent" },
		);
	});

test("transient cleanup cannot erase a concurrent substatus", async () => {
	db.update(narrators).set({ substatus: '["reasoning"]' }).where(eq(narrators.id, "actor")).run();
	const injected = afterSnapshot(() => {
		db.update(narrators)
			.set({ substatus: '["reasoning","error"]' })
			.where(eq(narrators.id, "actor"))
			.run();
	});
	const error = await finalization.clearTransientSubstatus("actor").catch((error) => error);
	injected();
	expect(error).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()?.substatus).toBe(
		'["reasoning","error"]',
	);
});

test("run registration rejects a source replaced during the Worker read", async () => {
	let concurrentRun: string | undefined;
	const injected = afterSnapshot(() => {
		concurrentRun = publication.startRun({ narratorId: "actor", binding: {} }).binding.logicalRunId;
	});
	const observed = await bridge.readQueryFirst(
		db
			.select({
				runtimeRegistrationJson: narrators.runtimeRegistrationJson,
				ownerUserId: narrators.ownerUserId,
				policySourceNarratorId: narrators.policySourceNarratorId,
			})
			.from(narrators)
			.where(eq(narrators.id, "actor"))
			.limit(1),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	injected();
	if (!observed) throw new Error("Missing actor");
	expect(() =>
		publication.startRun({ narratorId: "actor", binding: {}, expectedSource: observed }),
	).toThrow("Runtime state changed while reading");
	expect(db.select().from(narrators).where(eq(narrators.id, "actor")).get()?.logicalRunId).toBe(
		concurrentRun,
	);
});

test("mailbox absence is distinct from Worker failure, with no owning-thread fallback", async () => {
	expect(await mailbox.getByDelivery("missing")).toBeUndefined();
	const failure = new DbReadError("DB_READ_UNSUPPORTED", "required reader disabled");
	spyOn(bridge, "readQueryFirst").mockRejectedValue(failure);
	const owner = spyOn(sqlite, "query");
	expect(await mailbox.getByDelivery("missing").catch((error) => error)).toBe(failure);
	expect(await finalization.restoreModel("actor").catch((error) => error)).toBe(failure);
	expect(owner).not.toHaveBeenCalled();
});

test("cancellation cannot erase a queued payload edited during its Worker observation", async () => {
	const result = mailbox.enqueue({
		kind: "user_input",
		narratorId: "actor",
		text: "old",
		projectedByteSize: 3,
		requestKey: "edit-race",
	});
	if (result.status !== "accepted" || !result.delivery.deliveryId)
		throw new Error("Missing delivery");
	const deliveryId = result.delivery.deliveryId;
	const injected = afterSnapshot(() => {
		mailbox.editUser(deliveryId, { text: "new", projectedByteSize: 3 });
	});
	const observed = await mailbox.getByDelivery(deliveryId);
	injected();
	if (!observed) throw new Error("Missing observed delivery");
	expect(() =>
		mailbox.cancel(deliveryId, "cancel", {
			state: observed.state,
			revision: observed.contentRevision,
		}),
	).toThrow("Runtime state changed while reading");
	expect(await mailbox.getByDelivery(deliveryId)).toMatchObject({
		state: "queued",
		text: "new",
		contentRevision: 2,
	});
});

test("cancelled and expired required reads fail explicitly", async () => {
	const controller = new AbortController();
	controller.abort();
	const cancelled = await mailbox
		.getByDelivery("missing", { signal: controller.signal })
		.catch((error) => error);
	expect(cancelled).toBeInstanceOf(Error);
	const expired = await mailbox
		.getByDelivery("missing", { deadlineAt: Date.now() - 1 })
		.catch((error) => error);
	expect(expired).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
});
