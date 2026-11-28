/**
 * Step-2 contract: permissions, models and control come from explicit registrations.
 *
 * Every case runs twice with the same relationships:
 *  - "delegated": a child created through `createSubagent` (parent link + registrations);
 *  - "unrelated": two ordinary narrators, no parent link, given the same registrations.
 * Same configuration, same observed behaviour — nothing may depend on parent/variant.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../../db";
import { narratorBlacklistCmds, narrators, users } from "../../db/schema";
import * as workerPool from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import { withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import { settings } from "../../lib/settings";
import {
	CONTROLLER_ACTIONS,
	delegationRegistration,
} from "../../lib/validators/runtime-registration";
import { setRunHold } from "../agent-runtime/ownership";
import { compileDelegationPolicy, isRuntimeToolAllowed } from "../agent-runtime/policy";
import { executionPolicyEngine } from "../execution-policy/engine";
import { executionPolicyRepository } from "../execution-policy/repository";
import { materializeLegacyDelegations } from "../legacy-delegation-materializer";
import { authorizeAgentControl } from "../narrator-control";
import { setPolicySource, setRuntimeRegistration } from "../narrator-runtime-registration";
import { narratorService } from "../narrator-service";
import { resolveSubagentModelForRun } from "../subagent-model";
import { resetTraitLayerCaches, resolveNarratorRuntimePolicy } from "../trait-layer-service";
import { captureWorkerRejectionThrower } from "./narrator-worker-fixture";

const A = "anthropic:claude-sonnet-4-20250514";
const B = "anthropic:claude-opus-4-20250514";
const C = "anthropic:claude-3-5-haiku-20241022";

const created: string[] = [];
const createdUsers: string[] = [];
const savedPools = structuredClone(settings.agent.subagentAllowedModels ?? {});

afterEach(async () => {
	resetTraitLayerCaches();
	settings.agent.subagentAllowedModels = structuredClone(savedPools);
	for (const id of created) setRunHold(id, undefined);
	const ids = created.splice(0);
	if (ids.length) {
		await db.delete(narratorBlacklistCmds).where(inArray(narratorBlacklistCmds.narratorId, ids));
		await db
			.update(narrators)
			.set({
				parentNarratorId: null,
				aclRootNarratorId: null,
				policySourceNarratorId: null,
				runtimeRegistrationJson: null,
			})
			.where(inArray(narrators.id, ids));
		await db.delete(narrators).where(inArray(narrators.id, ids));
	}
	const userIds = createdUsers.splice(0);
	if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

async function primary(model = A): Promise<string> {
	const row = await narratorService.create({ locale: "en", model });
	created.push(row.id);
	return row.id;
}

/**
 * - delegated: created through `createSubagent`;
 * - unrelated: two ordinary narrators given the same registrations, no parent link;
 * - legacy: a delegated row written before registrations existed (parent link and
 *   delegated variant only), after the one-time materialization stored its relations.
 */
type Shape = "delegated" | "unrelated" | "legacy";

/** A source and a dependent related by `shape`; both shapes register the same facts. */
async function related(shape: Shape): Promise<{ source: string; dependent: string }> {
	const source = await primary();
	if (shape !== "unrelated") {
		const child = await narratorService.createSubagent({
			subagentOriginKind: "standalone",
			parentNarratorId: source,
			subagentType: "general",
			cwd: ".",
		});
		created.push(child.id);
		await narratorService.updateStatus(child.id, "idle");
		if (shape === "legacy") {
			await db
				.update(narrators)
				.set({
					policySourceNarratorId: null,
					runtimeRegistrationJson: null,
					traits: ["standalone"],
				})
				.where(eq(narrators.id, child.id));
			await materializeLegacyDelegations([child.id]);
		}
		return { source, dependent: child.id };
	}
	const dependent = await primary();
	await setPolicySource(dependent, source);
	await setRuntimeRegistration(dependent, delegationRegistration(source, "general"));
	await narratorService.updateModel(dependent, FOLLOW_PARENT_MODEL);
	// Same compiled ceiling the delegation template gives (stored on the row, never re-read).
	const child = await db.query.narrators.findFirst({
		where: eq(narrators.id, dependent),
		columns: { traits: true },
	});
	await db
		.update(narrators)
		.set({
			traits: withRuntimePolicyTrait(
				child?.traits,
				compileDelegationPolicy({ template: "general" }),
			),
		})
		.where(eq(narrators.id, dependent));
	return { source, dependent };
}

async function setTraits(id: string, traits: string[]) {
	await db.update(narrators).set({ traits }).where(eq(narrators.id, id));
	resetTraitLayerCaches();
}

const shapes: Shape[] = ["delegated", "unrelated", "legacy"];

describe.each(shapes)("%s session: permissions follow the registered source", (shape) => {
	test("the source's execution rules apply, and a tightening applies on the next load", async () => {
		const { source, dependent } = await related(shape);
		const before = executionPolicyRepository.loadNow(dependent);
		expect(before.inheritedNarratorIds).toEqual([dependent, source]);
		expect(before.commandBlacklist.some((rule) => rule.pattern === "rm*")).toBe(false);
		await db.insert(narratorBlacklistCmds).values({
			id: generateId(),
			narratorId: source,
			pattern: "rm*",
			createdAt: new Date().toISOString(),
		});
		const after = executionPolicyRepository.loadNow(dependent);
		expect(after.commandBlacklist.some((rule) => rule.pattern === "rm*")).toBe(true);
		expect(await executionPolicyRepository.load(dependent)).toEqual(after);
	});

	test("a capability tightening on the source reaches the dependent", async () => {
		const { source, dependent } = await related(shape);
		expect(isRuntimeToolAllowed(await resolveNarratorRuntimePolicy(dependent), "Write")).toBe(true);
		await setTraits(source, withRuntimePolicyTrait([], { version: 1, readOnly: true }));
		expect(isRuntimeToolAllowed(await resolveNarratorRuntimePolicy(dependent), "Write")).toBe(
			false,
		);
	});

	test("a permission-mode change propagates to registered dependents only", async () => {
		const { source, dependent } = await related(shape);
		const bystander = await primary();
		await narratorService.updatePermissionMode(source, "readOnly");
		const rows = await db.query.narrators.findMany({
			where: inArray(narrators.id, [dependent, bystander]),
			columns: { id: true, permissionMode: true },
		});
		expect(rows.find((row) => row.id === dependent)?.permissionMode).toBe("readOnly");
		expect(rows.find((row) => row.id === bystander)?.permissionMode).not.toBe("readOnly");
	});

	test("deleting a source freezes its ceiling into the dependent, never widens it", async () => {
		const { source, dependent } = await related(shape);
		if (shape !== "unrelated") return; // a source's own children are removed with it
		await setTraits(source, withRuntimePolicyTrait([], { version: 1, readOnly: true }));
		await narratorService.remove(source);
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, dependent),
			columns: { policySourceNarratorId: true },
		});
		expect(row?.policySourceNarratorId).toBeNull();
		expect(isRuntimeToolAllowed(await resolveNarratorRuntimePolicy(dependent), "Write")).toBe(
			false,
		);
	});
});

test("committed policy rejects Worker failures without reading policy inline", async () => {
	const id = await primary();
	const inline = spyOn(executionPolicyRepository, "loadNow");
	const dispatch = spyOn(workerPool, "runReadTask");
	const original = process.env.NARRAFORK_DB_WORKER;
	try {
		process.env.NARRAFORK_DB_WORKER = "off";
		expect(await captureWorkerRejectionThrower(executionPolicyRepository.load(id))).toThrow(
			"disabled_by_env",
		);
		for (const message of ["worker creation failed", "worker crashed", "worker timed out"]) {
			dispatch.mockRejectedValueOnce(new Error(message));
			expect(await captureWorkerRejectionThrower(executionPolicyRepository.load(id))).toThrow(
				message,
			);
		}
		expect(dispatch).toHaveBeenCalledTimes(4);
		expect(inline).not.toHaveBeenCalled();
		expect((await executionPolicyEngine.compileCurrent(id, null, [])).narratorId).toBe(id);
		expect(dispatch).toHaveBeenCalledTimes(4);
	} finally {
		if (original === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = original;
		dispatch.mockRestore();
		inline.mockRestore();
	}
});

test("committed policy never dispatches inside an active transaction or after cancellation", async () => {
	const id = await primary();
	const dispatch = spyOn(workerPool, "runReadTask");
	try {
		const inTransaction = sqlite.transaction(() => executionPolicyRepository.load(id))();
		expect(await captureWorkerRejectionThrower(inTransaction)).toThrow("requires_committed_file");
		expect(
			await captureWorkerRejectionThrower(
				executionPolicyRepository.load(id, AbortSignal.abort(new Error("turn cancelled"))),
			),
		).toThrow("turn cancelled");
		expect(dispatch).not.toHaveBeenCalled();
	} finally {
		dispatch.mockRestore();
	}
});

test("the Worker rejects a policy over the per-table limit, rather than dropping rules", async () => {
	const id = await primary();
	sqlite
		.query(
			`WITH RECURSIVE rules(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM rules WHERE n < 2001)
			INSERT INTO narrator_blacklist_cmds (id, narrator_id, pattern, created_at)
			SELECT ? || '-' || n, ?, 'command-' || n, ? FROM rules`,
		)
		.run(id, id, new Date().toISOString());
	expect(await captureWorkerRejectionThrower(executionPolicyRepository.load(id))).toThrow(
		"Permission rule budget exceeded",
	);
});

describe.each(shapes)("%s session: model follows the registered source", (shape) => {
	test("follows the source and picks up a source switch on the next resolution", async () => {
		const { source, dependent } = await related(shape);
		const read = () => narratorService.getById(dependent);
		expect((await resolveSubagentModelForRun(await read())).model).toBe(A);
		await narratorService.updateModel(source, B);
		const next = await resolveSubagentModelForRun(await read());
		expect(next.model).toBe(B);
		expect(next.inheritance).toMatchObject({ source: "parent", parentModel: B });
	});

	test("the registered pool bounds a followed model and falls back to its first entry", async () => {
		const { source, dependent } = await related(shape);
		settings.agent.subagentAllowedModels = { ...savedPools, general: [C] };
		await narratorService.updateModel(source, B);
		const run = await resolveSubagentModelForRun(await narratorService.getById(dependent));
		expect(run.model).toBe(C);
		expect(run.inheritance).toMatchObject({ source: "pool-fallback", poolKey: "general" });
		settings.agent.subagentAllowedModels = { ...savedPools, general: [] };
		// A non-empty settings pool is required to restrict; an empty one means no pool.
		expect((await resolveSubagentModelForRun(await narratorService.getById(dependent))).model).toBe(
			B,
		);
	});

	test("a pinned model is not overridden by the source", async () => {
		const { source, dependent } = await related(shape);
		await narratorService.updateModel(dependent, C);
		await narratorService.updateModel(source, B);
		const run = await resolveSubagentModelForRun(await narratorService.getById(dependent));
		expect(run.model).toBe(C);
		expect(run.inheritance).toBeUndefined();
	});
});

test("a session with no registered source cannot follow one, even with a parent link", async () => {
	const parent = await primary();
	const orphan = await primary();
	// A fork-style parent link alone confers neither a model nor a policy source.
	await db.update(narrators).set({ parentNarratorId: parent }).where(eq(narrators.id, orphan));
	await narratorService.updateModel(orphan, FOLLOW_PARENT_MODEL);
	expect(
		await captureWorkerRejectionThrower(
			resolveSubagentModelForRun(await narratorService.getById(orphan)),
		),
	).toThrow("registered source");
	expect(executionPolicyRepository.loadNow(orphan).inheritedNarratorIds).toEqual([orphan]);
});

describe.each(shapes)("%s session: control is a separate, explicit grant", (shape) => {
	test("the registered controller may stop, steer and archive", async () => {
		const { source, dependent } = await related(shape);
		for (const action of CONTROLLER_ACTIONS)
			expect(
				(
					await authorizeAgentControl({
						callerNarratorId: source,
						targetNarratorId: dependent,
						action,
					})
				).id,
			).toBe(dependent);
	});

	test("siblings and fork sources get no control", async () => {
		const { source, dependent } = await related(shape);
		// A sibling registered against the same source.
		const sibling = await primary();
		await setPolicySource(sibling, source);
		await setRuntimeRegistration(sibling, delegationRegistration(source, "general"));
		// A fork source: parent link on an ordinary narrator, no registration.
		const forkSource = await primary();
		const fork = await primary();
		await db.update(narrators).set({ parentNarratorId: forkSource }).where(eq(narrators.id, fork));
		const denied = async (caller: string, target: string, action: "stop" | "archive") =>
			expect(
				await captureWorkerRejectionThrower(
					authorizeAgentControl({ callerNarratorId: caller, targetNarratorId: target, action }),
				),
			).toThrow();
		for (const action of ["stop", "archive"] as const) {
			await denied(sibling, dependent, action);
			await denied(dependent, sibling, action);
			await denied(forkSource, fork, action);
		}
	});

	test("a grant limited to some actions does not imply the others", async () => {
		const { source, dependent } = await related(shape);
		await setRuntimeRegistration(dependent, {
			version: 1,
			modelPool: "general",
			controller: { narratorId: source, actions: ["steer"] },
		});
		await authorizeAgentControl({
			callerNarratorId: source,
			targetNarratorId: dependent,
			action: "steer",
		});
		expect(
			await captureWorkerRejectionThrower(
				authorizeAgentControl({
					callerNarratorId: source,
					targetNarratorId: dependent,
					action: "stop",
				}),
			),
		).toThrow("not a direct child");
	});

	test("the controller cannot stop or archive while the user has taken the session over", async () => {
		const { source, dependent } = await related(shape);
		setRunHold(dependent, { released: false });
		for (const action of ["stop", "archive"] as const)
			expect(
				await captureWorkerRejectionThrower(
					authorizeAgentControl({ callerNarratorId: source, targetNarratorId: dependent, action }),
				),
			).toThrow("taken over");
		// A steer (Send doInterrupt) stays authorized; its caller delivers without interrupting.
		await authorizeAgentControl({
			callerNarratorId: source,
			targetNarratorId: dependent,
			action: "steer",
		});
		setRunHold(dependent, undefined);
		await authorizeAgentControl({
			callerNarratorId: source,
			targetNarratorId: dependent,
			action: "stop",
		});
	});

	test("the controller's own ceiling and the acting user's ACL still bound control", async () => {
		const { source, dependent } = await related(shape);
		await setTraits(source, withRuntimePolicyTrait([], { version: 1, deny: ["spawnAgent"] }));
		expect(
			await captureWorkerRejectionThrower(
				authorizeAgentControl({
					callerNarratorId: source,
					targetNarratorId: dependent,
					action: "stop",
				}),
			),
		).toThrow("capability ceiling");
		await setTraits(source, []);
		const [owner, stranger] = [generateId(), generateId()];
		createdUsers.push(owner, stranger);
		for (const id of [owner, stranger])
			await db.insert(users).values({
				id,
				username: `ctl-${id}`,
				passwordHash: "fixture",
				role: "user",
				createdAt: new Date().toISOString(),
			});
		// Delegated rows judge access by their ACL root (the source); make both private.
		await db
			.update(narrators)
			.set({ ownerUserId: owner, visibility: "private", writeAudience: "owner" })
			.where(inArray(narrators.id, [source, dependent]));
		await authorizeAgentControl({
			callerNarratorId: source,
			targetNarratorId: dependent,
			action: "stop",
			userId: owner,
		});
		expect(
			await captureWorkerRejectionThrower(
				authorizeAgentControl({
					callerNarratorId: source,
					targetNarratorId: dependent,
					action: "stop",
					userId: stranger,
				}),
			),
		).toThrow("current user");
	});
});

test("deleting a source removes its delegated children and keeps a survivor restricted", async () => {
	const { source, dependent: child } = await related("delegated");
	const survivor = await primary();
	await setPolicySource(survivor, source);
	await setTraits(source, withRuntimePolicyTrait([], { version: 1, readOnly: true }));
	await narratorService.remove(source);
	const remaining = await db.query.narrators.findMany({
		where: inArray(narrators.id, [source, child, survivor]),
		columns: { id: true, policySourceNarratorId: true },
	});
	expect(remaining).toEqual([{ id: survivor, policySourceNarratorId: null }]);
	expect(isRuntimeToolAllowed(await resolveNarratorRuntimePolicy(survivor), "Write")).toBe(false);
});

test("a primary fork with a parent link is unaffected by permission-mode propagation", async () => {
	const source = await primary();
	const fork = await primary();
	await db.update(narrators).set({ parentNarratorId: source }).where(eq(narrators.id, fork));
	const before = (await narratorService.getById(fork)).permissionMode;
	await narratorService.updatePermissionMode(
		source,
		before === "readOnly" ? "default" : "readOnly",
	);
	expect((await narratorService.getById(fork)).permissionMode).toBe(before);
});
