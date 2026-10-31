import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { requestInput, rowsAsHistory } from "../../../tests/fixtures/model-input";
import { cleanDb } from "../../../tests/setup";
import { narrators, users } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";

// Exercise real prefix snapshots against the same isolated on-disk DB as their worker.
const { db, sqlite } = await import("../../db");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const session = await import("../narrator-session");
const { bashTool } = await import("../../lib/agent/tools/bash");
const { interruptManualBash } = await import("../narrator-service");
const { getExecutionOwner, getRunControl } = await import("../agent-runtime/ownership");
const { enqueueBufferedMessage } = await import("../narrator-buffer");
const { activeNarrators } = await import("../narrator-session-state");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const { settings } = await import("../../lib/settings");
const providerCalls: string[] = [];
let observedNarratorId: string | undefined;
const observedPrincipals: Array<string | null | undefined> = [];
const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerCalls.push(requestInput(params));
		if (observedNarratorId) observedPrincipals.push(getRunControl(observedNarratorId)?.principal);
		params.onRequestStart?.();
		yield { text: "finished" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "test" ? provider : null),
	listReadiness: () => [],
});

async function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Idle pre-Bash admission timed out")), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test.each([
	{ name: "known", userId: "input-human", current: "session-human", expected: "input-human" },
	{ name: "explicit null", userId: null, current: "session-human", expected: null },
	{ name: "unknown", userId: undefined, current: "session-human", expected: "session-human" },
	{ name: "queued unknown", userId: undefined, current: undefined, expected: "registered-human" },
])("human entry principal preserves $name without widening the session identity", async ({
	name,
	userId,
	current,
	expected,
}) => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	settings.agent.autoContinuationMode = "off";
	const id = `principal-${name.replaceAll(" ", "-")}`;
	const now = new Date().toISOString();
	for (const user of ["input-human", "session-human", "registered-human"]) {
		await db
			.insert(users)
			.values({ id: user, username: user, passwordHash: "fixture", createdAt: now });
	}
	await db.insert(narrators).values({
		id,
		model: "test:model",
		title: id,
		cwd: process.cwd(),
		permissionMode: "bypassPermissions",
		autoContinuationOverride: "off",
		runtimeRegistrationJson: {
			version: 1,
			run: { logicalRunId: `fixture-${id}`, principal: { userId: "registered-human" } },
		},
		createdAt: now,
		updatedAt: now,
	});
	const active = await session.ensureNarrator(id, "en");
	active._currentUserId = current;
	observedNarratorId = id;
	observedPrincipals.length = 0;
	try {
		if (name === "queued unknown") {
			await enqueueBufferedMessage(id, "queued anonymous-looking metadata");
			await session.resumeNextBufferedMessage(active, "en");
		} else {
			await session.acceptUserMessage(id, "identity check", { userId });
		}
		const deadline = Date.now() + 3000;
		while ((!observedPrincipals.length || getExecutionOwner(id)) && Date.now() < deadline)
			await Bun.sleep(10);
		expect(observedPrincipals).toEqual([expected]);
	} finally {
		observedNarratorId = undefined;
		session.closeNarrator(id);
		getExecutionOwner(id)?.release();
	}
});

afterAll(async () => {
	unregisterProvider();
	mock.restore();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
});

test("concurrent idle pre-Bash admission accepts interrupt and aborts Bash before natural completion", async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	settings.agent.autoContinuationMode = "off";
	const id = "idle-pre-bash-interrupt";
	const userId = "pre-bash-human";
	const now = new Date().toISOString();
	await db
		.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", createdAt: now });
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "test:model",
		title: "pre-Bash test",
		permissionMode: "bypassPermissions",
		autoContinuationOverride: "off",
		status: "idle",
		cwd: process.cwd(),
		createdAt: now,
		updatedAt: now,
	});
	const started = Promise.withResolvers<AbortSignal>();
	const stopped = Promise.withResolvers<void>();
	const original = bashTool.execute;
	const execute = spyOn(bashTool, "execute").mockImplementation(async (input, context) => {
		try {
			return await original(input, {
				...context,
				emitOutput: (output) => {
					context.emitOutput?.(output);
					if (String(output).includes("idle-ready")) started.resolve(context.signal);
				},
			});
		} finally {
			stopped.resolve();
		}
	});
	let first: Promise<unknown> | undefined;
	let second: Promise<unknown> | undefined;
	try {
		first = session.acceptUserMessage(id, "first with pre-Bash", {
			userId,
			preBashCommand: "printf idle-ready; sleep 30",
		});
		const signal = await within(started.promise);
		const owner = getExecutionOwner(id);
		expect(owner).toBeDefined();
		expect(signal.aborted).toBe(false);
		second = session.acceptUserMessage(id, "urgent replacement", { userId, interrupt: true });
		expect(await within(second)).toMatchObject({ buffered: true });
		expect(signal.aborted).toBe(true);
		// The pre-command is the activity being cancelled, not the turn/run controller.
		expect(activeNarrators.get(id)?.abortController.signal.aborted).toBe(false);
		await within(stopped.promise);
		expect(await within(first)).toMatchObject({ buffered: false });
		const deadline = Date.now() + 3000;
		while (
			(!providerCalls.some((text) => text.includes("urgent replacement")) ||
				getExecutionOwner(id)) &&
			Date.now() < deadline
		)
			await Bun.sleep(10);
		expect(providerCalls.some((text) => text.includes("urgent replacement"))).toBe(true);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.lastStopReason,
		).not.toBe("user_interrupt");
	} finally {
		interruptManualBash(id);
		session.closeNarrator(id);
		await within(stopped.promise).catch(() => {});
		await within(Promise.allSettled([first, second])).catch(() => {});
		getExecutionOwner(id)?.release();
		execute.mockRestore();
	}
}, 10_000);
