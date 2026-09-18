/**
 * The PostgreSQL-mode publication facade (`createUnwiredPublicationFacade`): on the PG
 * backend the module-level `runtimePublication` is this fail-closed stand-in, so
 * importing `publication.ts` and registering producers must survive PG startup while
 * every database operation throws a precise error instead of touching the fail-closed
 * SQLite proxy.
 *
 * This suite runs on SQLite: it constructs the facade directly (the module-level export
 * keeps the eager SQLite service here, pinned by every other publication test).
 */
import { expect, test } from "bun:test";
import { db } from "../../db";
import {
	createRuntimePublicationService,
	createUnwiredPublicationFacade,
	runtimePublication,
} from "../agent-runtime/publication";

// Retire the module-level worker's timer so this file leaves no scheduled flush behind.
runtimePublication.stop();

test("the facade exposes the exact synchronous API surface of the real service", () => {
	const real = createRuntimePublicationService(db);
	try {
		const facade = createUnwiredPublicationFacade();
		expect(Object.keys(facade).sort()).toEqual(Object.keys(real).sort());
	} finally {
		real.stop();
	}
});

test("every database operation fails closed with a precise error", () => {
	const facade = createUnwiredPublicationFacade();
	const run = { producerKind: "bash" as const, taskId: "t", logicalRunId: "r", recipientId: "p" };
	const invocations: Record<string, () => unknown> = {
		store: () => facade.store,
		startAgentRun: () => facade.startAgentRun({ narratorId: "n", parentNarratorId: "p" }),
		getAgentRun: () => facade.getAgentRun("n", "p"),
		newBashRun: () => facade.newBashRun("t", "p"),
		reserve: () => facade.reserve(run, undefined as never),
		persistResult: () => facade.persistResult(run, "text", undefined as never),
		commit: () =>
			facade.commit(
				{ ...run, eventKind: "completed", resultRef: "r", summary: "s" },
				undefined as never,
			),
		hasPendingSource: () => facade.hasPendingSource(run),
		flushRecipient: () => facade.flushRecipient("p"),
		flushPage: () => facade.flushPage(),
		schedule: () => facade.schedule(),
		migrateLegacyTaskNotice: () =>
			facade.migrateLegacyTaskNotice("p", {
				kind: "bg_bash",
				task: { id: "t" } as never,
			}),
	};
	for (const [operation, invoke] of Object.entries(invocations)) {
		expect(invoke, operation).toThrow(/not wired/);
		expect(invoke, operation).toThrow(/no SQLite fallback/);
	}
});

test("registrations and stop never throw — module-scope producer wiring survives PG startup", () => {
	const facade = createUnwiredPublicationFacade();
	facade.setWake(() => {});
	facade.setWake(undefined);
	facade.setLegacyRuntimeAdmissionReader("agent", () => undefined);
	facade.setLegacyRuntimeAdmissionReader("bash", () => undefined);
	facade.setLegacyCompletionAdmissionReader(() => undefined);
	facade.stop();
});
