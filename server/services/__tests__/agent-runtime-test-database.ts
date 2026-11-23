import type { Database } from "bun:sqlite";
import { expect, spyOn } from "bun:test";
import * as communicationWork from "../agent-runtime/async-work";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const databases = new WeakMap<Database, ReturnType<typeof getNarratorWorkerTestDb>>();

/** File-backed, WAL-enabled fixture with the complete current schema and triggers. */
export function getRuntimeTestDb() {
	const fixture = getNarratorWorkerTestDb();
	databases.set(fixture.sqlite, fixture);
	return fixture;
}

/** Rearm recovery fixtures only after their DB exports are bound, never during native readiness. */
export async function prepareRuntimeTestDb(sqlite: Database): Promise<void> {
	const fixture = databases.get(sqlite);
	if (!fixture) throw new Error("Unknown runtime test database");
	await fixture.ready;
	const notifications = await import("../notification-service");
	const snapshot = notifications.getNotificationBackgroundWorkSnapshot();
	if (snapshot.pending || snapshot.failed)
		throw new Error(
			`Notification fixture cannot rearm: pending=${snapshot.pending}, failed=${snapshot.failed}`,
		);
	await notifications.resetNotificationBackgroundWorkForTests({ expectedFailures: 0 });
}

let acknowledgedFailures = 0;

export async function drainRuntimeTestWork(options: { deadlineAt?: number } = {}): Promise<void> {
	try {
		await communicationWork.drainCommunicationWork(options);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			error.message !== "Communication database tail failed" ||
			communicationWork.getCommunicationWorkFailureCount() !== acknowledgedFailures
		)
			throw error;
	}
	expect(communicationWork.getCommunicationWorkStatus().pending).toBe(0);
	expect(communicationWork.getCommunicationWorkFailureCount()).toBe(acknowledgedFailures);
	await (await import("../notification-service")).drainNotificationBackgroundWork(options);
}

/** An injected bookkeeping failure must be the exact new marker, not a sticky old failure. */
export async function expectRuntimeTestFailure<T>(
	work: () => Promise<T>,
	expected: { kind: "marker"; caller: string },
): Promise<T> {
	await drainRuntimeTestWork();
	const before = communicationWork.getCommunicationWorkFailureCount();
	const original = communicationWork.markCommunicationWorkFailed;
	const stacks: string[] = [];
	const marker = spyOn(communicationWork, "markCommunicationWorkFailed").mockImplementation(() => {
		stacks.push(new Error().stack ?? "");
		original();
	});
	try {
		const result = await work();
		try {
			await communicationWork.drainCommunicationWork();
		} catch (error) {
			expect(error).toMatchObject({ message: "Communication database tail failed" });
		}
		expect(stacks).toHaveLength(1);
		expect(stacks[0]).toContain(expected.caller);
		expect(communicationWork.getCommunicationWorkFailureCount() - before).toBe(1);
		acknowledgedFailures++;
		await drainRuntimeTestWork();
		return result;
	} finally {
		marker.mockRestore();
	}
}

/** Stop publishers before closing; reader shutdown follows all detached producer tails. */
export async function closeRuntimeTestDb(
	sqlite: Database,
	options: { sessionTails?: boolean } = {},
): Promise<void> {
	const fixture = databases.get(sqlite);
	if (!fixture) throw new Error("Unknown runtime test database");
	const deadlineAt = Date.now() + 30_000;
	const notifications = await import("../notification-service");
	let drained = false;
	try {
		if (options.sessionTails) {
			(await import("../agent-runtime/inbox")).stopInboxWakes();
			(await import("../agent-runtime/publication")).stopRuntimePublications();
			const buffer = await import("../narrator-buffer");
			buffer.stopBufferedFilePreparations();
			const session = await import("../narrator-session");
			await (await import("../background-occupancy-store")).stopBackgroundOccupancy();
			do {
				if (Date.now() >= deadlineAt) throw new Error("Runtime fixture tails did not drain");
				await session.drainNarratorSessionTails({ deadlineAt });
				await buffer.drainBufferedFilePreparations({ deadlineAt });
				await drainRuntimeTestWork({ deadlineAt });
			} while (
				session.getNarratorSessionTailStatus().pending > 0 ||
				buffer.hasPendingBufferedFilePreparations() ||
				communicationWork.getCommunicationWorkStatus().pending > 0 ||
				notifications.getNotificationBackgroundWorkSnapshot().pending > 0
			);
		}
		await drainRuntimeTestWork({ deadlineAt });
		await notifications.stopNotificationBackgroundWork({ deadlineAt });
		drained = true;
	} finally {
		// A failed drain must not close readers underneath a still-live producer chain.
		if (drained) {
			await (await import("../narrator-prefix-snapshots")).closePrefixSnapshotStore();
			await fixture.close();
			databases.delete(sqlite);
		}
	}
}
