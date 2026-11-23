import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorToolContinuations,
} from "../../db/schema";
import * as reads from "../../db/worker-read";
import * as pool from "../../lib/db-worker/pool";
import { captureWorkerRejection, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { toolContinuationService: service } = await import("../tool-continuation-service");
const NOW = "2026-08-01T00:00:00.000Z";
const input = {
	toolCallId: "call",
	narratorId: "parent",
	updateEpoch: "epoch",
	kind: "send_await" as const,
	state: "waiting" as const,
	payloadJson: { text: "\uFEFF  中文 🧭\n" },
};
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators).values({ id: "parent", createdAt: NOW, updatedAt: NOW }).run();
	db.insert(narratorMessages)
		.values({
			id: "message",
			narratorId: "parent",
			role: "assistant",
			contentJson: [],
			createdAt: NOW,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "call",
			narratorId: "parent",
			messageId: "message",
			toolUseId: "use",
			toolName: "Send",
			status: "running",
			executionAttempt: 1,
			createdAt: NOW,
		})
		.run();
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.module("../../db", () => realDb);
	await fixture.close();
});

function seed() {
	db.insert(narratorToolContinuations)
		.values({ id: "record", ...input, createdAt: NOW, updatedAt: NOW })
		.run();
}

test("batched identity lookup preserves records, deduplicates ids and handles empty/missing sets", async () => {
	seed();
	const [record] = await service.getByToolCallIds(["call", "missing", "call"]);
	expect(record).toMatchObject(input);
	expect(await service.getByToolCallIds([])).toEqual([]);
	expect(await service.getByToolCallIds(["missing"])).toEqual([]);
});

test("batch identity lookup uses two bounded reads per hundred records", async () => {
	seed();
	const ids = Array.from({ length: 200 }, (_, index) => `call-${index}`);
	db.insert(narratorToolCalls)
		.values(
			ids.map((id) => ({
				id,
				narratorId: "parent",
				messageId: "message",
				toolUseId: `use-${id}`,
				toolName: "Send",
				status: "running" as const,
				executionAttempt: 1,
				createdAt: NOW,
			})),
		)
		.run();
	db.insert(narratorToolContinuations)
		.values(
			ids.map((id) => ({
				...input,
				id: `record-${id}`,
				toolCallId: id,
				createdAt: NOW,
				updatedAt: NOW,
			})),
		)
		.run();
	const original = pool.runReadTask;
	let calls = 0;
	spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
		calls++;
		return original(path, params, options);
	}) as typeof pool.runReadTask);
	expect(await service.getByToolCallIds(["call", ...ids])).toHaveLength(201);
	expect(calls).toBe(6);
});

test("batch payload size admission rejects oversized data and growth between snapshots", async () => {
	seed();
	db.update(narratorToolContinuations)
		.set({ payloadJson: { text: "x".repeat(65_536) } })
		.run();
	const oversized = await captureWorkerRejection(service.getByToolCallIds(["call"]));
	expect(oversized).toMatchObject({ message: "Continuation recovery payload budget exceeded" });
	db.update(narratorToolContinuations).set({ payloadJson: {} }).run();
	const original = reads.readQuery;
	let fired = false;
	spyOn(reads, "readQuery").mockImplementation((async (query, options) => {
		const result = await original(query as Parameters<typeof reads.readQuery>[0], options);
		if (!fired) {
			fired = true;
			db.update(narratorToolContinuations)
				.set({ payloadJson: { text: "grew" } })
				.run();
		}
		return result;
	}) as typeof reads.readQuery);
	const error = await captureWorkerRejection(service.getByToolCallIds(["call"]));
	expect(error).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
	expect(fired).toBe(true);
});

test("batch metadata and payload reads forward budgets and propagate Worker errors", async () => {
	seed();
	const original = pool.runReadTask;
	const signal = new AbortController().signal;
	const deadlineAt = Date.now() + 10_000;
	let calls = 0;
	const probe = spyOn(pool, "runReadTask").mockImplementation(((path, params, options) => {
		calls++;
		expect(options).toMatchObject({ signal, deadlineAt, timeoutMs: 2_000 });
		return original(path, params, options);
	}) as typeof pool.runReadTask);
	expect(
		await service.getByToolCallIds(["call"], { signal, deadlineAt, timeoutMs: 2_000 }),
	).toHaveLength(1);
	expect(calls).toBe(2);
	const failure = new Error("batch worker failed");
	probe.mockImplementation(() => Promise.reject(failure));
	expect(await captureWorkerRejection(service.getByToolCallIds(["call"]))).toBe(failure);
});
function stored() {
	return db
		.select()
		.from(narratorToolContinuations)
		.where(eq(narratorToolContinuations.id, "record"))
		.get();
}
function interleave(full: "first" | "many", mutation: () => void | Promise<void>) {
	let injected = false;
	if (full === "first") {
		const original = reads.readQueryFirst;
		spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
			const row = await original(query, options);
			if (!injected && row && typeof row === "object" && "toolCallId" in row) {
				injected = true;
				await mutation();
			}
			return row;
		});
	} else {
		const original = reads.readQuery;
		spyOn(reads, "readQuery").mockImplementation((async (query, options) => {
			const rows = await original(query as Parameters<typeof reads.readQuery>[0], options);
			if (
				!injected &&
				Array.isArray(rows) &&
				rows[0] &&
				typeof rows[0] === "object" &&
				"toolCallId" in rows[0]
			) {
				injected = true;
				await mutation();
			}
			return rows;
		}) as typeof reads.readQuery);
	}
	return () => expect(injected).toBe(true);
}

test("normal and empty continuation reads retain exact text bytes and honor read budgets", async () => {
	expect(await service.getByToolCallId("missing")).toBeNull();
	expect(await service.listByEpoch("missing")).toEqual([]);
	const created = await service.create(input);
	expect((await service.getByToolCallId("call"))?.payloadJson?.text).toBe(input.payloadJson.text);
	expect((await service.listByEpoch("epoch"))[0]?.id).toBe(created.id);
	const controller = new AbortController();
	controller.abort();
	const ownerRead = spyOn(sqlite, "query");
	for (const options of [{ signal: controller.signal }, { deadlineAt: Date.now() - 1 }]) {
		expect(await captureWorkerRejection(service.getByToolCallId("call", options))).toBeInstanceOf(
			Error,
		);
		expect(await captureWorkerRejection(service.listByEpoch("epoch", options))).toBeInstanceOf(
			Error,
		);
	}
	expect(ownerRead).not.toHaveBeenCalled();
});

for (const operation of ["create", "upsert"] as const) {
	test(`${operation} cannot checkpoint a replaced execution attempt`, async () => {
		if (operation === "upsert") seed();
		const before = stored();
		const original = reads.readQueryFirst;
		let injected = false;
		spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
			const row = await original(query, options);
			if (!injected && row && typeof row === "object" && "executionAttempt" in row) {
				injected = true;
				db.update(narratorToolCalls)
					.set({ executionAttempt: 2 })
					.where(eq(narratorToolCalls.id, "call"))
					.run();
			}
			return row;
		});
		expect(await captureWorkerRejection(service[operation](input))).toMatchObject({
			code: "RUNTIME_READ_CONFLICT",
			statusCode: 409,
		});
		expect(injected).toBe(true);
		expect(stored()).toEqual(before);
	});
}

for (const operation of ["checkpoint", "token"] as const)
	for (const raw of [` { "text" : ${JSON.stringify(input.payloadJson.text)} } `, "null"])
		test(`${operation} compares the stored JSON representation without a false revision conflict: ${raw === "null" ? "JSON null" : "whitespace"}`, async () => {
			seed();
			db.update(narratorToolContinuations)
				.set({ payloadJson: sql`${raw}` })
				.run();
			expect((await service.getByToolCallId("call"))?.payloadJson).toEqual(JSON.parse(raw));
			if (operation === "checkpoint")
				expect((await service.checkpoint(input)).payloadJson?.text).toBe(input.payloadJson.text);
			else {
				const [record] = await service.bindRecoveryTokenForNarrator("parent", "epoch", "token");
				expect(record?.payloadJson).toEqual({ ...(JSON.parse(raw) ?? {}), recoveryToken: "token" });
			}
		});

for (const operation of ["result", "cancel"] as const) {
	for (const change of ["renewed", "released", "taken-over"] as const) {
		test(`${operation} ${change === "renewed" ? "survives a renewed lease" : `conflicts after the claim is ${change}`} after its Worker snapshot`, async () => {
			seed();
			db.update(narratorToolContinuations)
				.set({
					state: "resuming",
					claimToken: "owner",
					claimedAt: NOW,
					deadlineAt: "2026-08-01T00:01:00.000Z",
				})
				.run();
			let changed: ReturnType<typeof stored>;
			const check = interleave(operation === "result" ? "first" : "many", async () => {
				if (change === "renewed") {
					const renewed = await service.renewClaim("call", {
						claimToken: "owner",
						updateEpoch: "epoch",
						now: "2026-08-01T00:00:30.000Z",
						deadlineAt: "2026-08-01T00:02:00.000Z",
					});
					expect(renewed?.deadlineAt).toBe("2026-08-01T00:02:00.000Z");
				} else
					db.update(narratorToolContinuations)
						.set(
							change === "released"
								? { state: "waiting", claimToken: null, claimedAt: null, deadlineAt: null }
								: { claimToken: "new-owner", claimedAt: "2026-08-01T00:00:30.000Z" },
						)
						.run();
				changed = stored();
			});
			const work =
				operation === "result"
					? service.markResultWritten("call", {
							claimToken: "owner",
							updateEpoch: "epoch",
							payloadJson: { toolSucceeded: true },
						})
					: service.cancelInterruptibleForNarrator("parent", "epoch");
			if (change === "renewed") {
				await work;
				expect(stored()?.state).toBe(operation === "result" ? "resuming" : "cancelled");
				if (operation === "result") {
					expect(stored()?.payloadJson?.recoveryPhase).toBe("result_written");
					expect(stored()?.payloadJson?.toolSucceeded).toBe(true);
					expect(stored()?.deadlineAt).toBe("2026-08-01T00:02:00.000Z");
					expect(stored()?.claimToken).toBe("owner");
				}
			} else {
				expect(await captureWorkerRejection(work)).toMatchObject({
					code: "RUNTIME_READ_CONFLICT",
					statusCode: 409,
				});
				expect(stored()).toEqual(changed);
			}
			check();
		});
	}
}

for (const operation of [
	"checkpoint",
	"reconcile",
	"result",
	"token",
	"pending",
	"started",
	"cancel",
] as const) {
	test(`${operation} rejects a concurrent same-timestamp payload revision without losing the newer write`, async () => {
		seed();
		if (operation === "result")
			db.update(narratorToolContinuations).set({ state: "resuming", claimToken: "owner" }).run();
		if (operation === "pending" || operation === "started")
			db.update(narratorToolContinuations)
				.set({
					state: "completed",
					payloadJson: {
						recoveryPhase:
							operation === "pending" ? "result_written" : "owner_continuation_pending",
					},
				})
				.run();
		let newer: ReturnType<typeof stored>;
		const check = interleave(
			["checkpoint", "reconcile", "result"].includes(operation) ? "first" : "many",
			() => {
				db.update(narratorToolContinuations)
					.set({ payloadJson: { newer: "must survive" } })
					.run();
				newer = stored();
			},
		);
		const work = () => {
			switch (operation) {
				case "checkpoint":
					return service.checkpoint(input);
				case "reconcile":
					return service.reconcileSendAwaitResult("call", "epoch");
				case "result":
					return service.markResultWritten("call", {
						claimToken: "owner",
						updateEpoch: "epoch",
						payloadJson: { stale: true },
					});
				case "token":
					return service.bindRecoveryTokenForNarrator("parent", "epoch", "new-token");
				case "pending":
					return service.markOwnerContinuationPendingForMessage("message", "epoch");
				case "started":
					return service.markOwnerContinuationStartedForMessage("message", "epoch");
				case "cancel":
					return service.cancelInterruptibleForNarrator("parent", "epoch");
			}
		};
		expect(await captureWorkerRejection(work())).toMatchObject({
			code: "RUNTIME_READ_CONFLICT",
			statusCode: 409,
		});
		check();
		expect(stored()).toEqual(newer);
	});
}

test("a continuation inserted during message readiness cannot be skipped by owner publication", async () => {
	seed();
	db.update(narratorToolContinuations)
		.set({ state: "completed", payloadJson: { recoveryPhase: "result_written" } })
		.run();
	const check = interleave("many", () => {
		db.insert(narratorToolCalls)
			.values({
				id: "other",
				narratorId: "parent",
				messageId: "message",
				toolUseId: "other-use",
				toolName: "Send",
				status: "running",
				createdAt: NOW,
			})
			.run();
		db.insert(narratorToolContinuations)
			.values({ id: "other-record", ...input, toolCallId: "other", createdAt: NOW, updatedAt: NOW })
			.run();
	});
	expect(
		await captureWorkerRejection(
			service.markOwnerContinuationPendingForMessage("message", "epoch"),
		),
	).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
	check();
	expect(stored()?.payloadJson?.recoveryPhase).toBe("result_written");
});

for (const failure of ["creation failure", "crash", "timeout", "disabled"])
	test(`Worker ${failure} rejects instead of reporting empty continuations or reading locally`, async () => {
		seed();
		const message = `injected Worker ${failure}`;
		spyOn(pool, "runReadTask").mockRejectedValue(new Error(message));
		const ownerRead = spyOn(sqlite, "query");
		expect(await captureWorkerRejection(service.listByEpoch("epoch"))).toMatchObject({ message });
		expect(await captureWorkerRejection(service.getByToolCallId("call"))).toMatchObject({
			message,
		});
		expect(await captureWorkerRejection(service.create(input))).toMatchObject({ message });
		expect(ownerRead).not.toHaveBeenCalled();
	});
