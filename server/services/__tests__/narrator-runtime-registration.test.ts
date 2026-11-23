/**
 * Runtime registration through the real database: policy sources
 * are followed live and fail closed, registrations are relationship-only, and two
 * narrators with no parent/child link can be related exactly like a delegation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { DISABLED_TOOLS_TRAIT_PREFIX, upsertEncodedTrait } from "../../lib/narrator-custom-traits";
import { withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import { MAX_POLICY_SOURCE_DEPTH } from "../../lib/runtime-source";
import { isRuntimeToolAllowed } from "../agent-runtime/policy";
import { customSubagentService } from "../custom-subagent-service";
import { materializeLegacyDelegations } from "../legacy-delegation-materializer";
import { getRuntimeRegistration, setPolicySource } from "../narrator-runtime-registration";
import { narratorService } from "../narrator-service";
import {
	resetTraitLayerCaches,
	resolveNarratorCapabilities,
	resolveNarratorRuntimePolicy,
} from "../trait-layer-service";
import { captureWorkerRejectionThrower } from "./narrator-worker-fixture";

const created: string[] = [];

afterEach(async () => {
	resetTraitLayerCaches();
	const ids = created.splice(0);
	if (ids.length === 0) return;
	// Children reference parents; clear the links before deleting.
	await db
		.update(narrators)
		.set({
			parentNarratorId: null,
			aclRootNarratorId: null,
			runtimeRegistrationJson: null,
			policySourceNarratorId: null,
		})
		.where(inArray(narrators.id, ids));
	await db.delete(narrators).where(inArray(narrators.id, ids));
});

async function narrator(traits: string[] = []): Promise<string> {
	const row = await narratorService.create({ locale: "en" });
	created.push(row.id);
	if (traits.length) await db.update(narrators).set({ traits }).where(eq(narrators.id, row.id));
	return row.id;
}

async function setTraits(id: string, traits: string[]): Promise<void> {
	await db.update(narrators).set({ traits }).where(eq(narrators.id, id));
}

const denySpawn = withRuntimePolicyTrait([], { version: 1, deny: ["spawnAgent"] });

describe("policy source layer", () => {
	test("an unrelated narrator can be a policy source, and changes follow live", async () => {
		const source = await narrator();
		const target = await narrator();
		await setPolicySource(target, source);
		expect((await resolveNarratorRuntimePolicy(target)).capabilities.spawnAgent).toBe(true);

		await setTraits(source, denySpawn);
		expect((await resolveNarratorRuntimePolicy(target)).capabilities.spawnAgent).toBe(false);

		// Restrictions also follow, and stay boundaries the target cannot relax.
		await setTraits(
			source,
			upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, {
				version: 1,
				tools: ["Bash"],
			}),
		);
		await setTraits(
			target,
			upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, { version: 1, tools: [] }),
		);
		const effective = (await resolveNarratorCapabilities(target)).traits;
		expect(effective.enforced.disabledTools.has("Bash")).toBe(true);
	});

	test("the target's own ceiling cannot widen the source's", async () => {
		const source = await narrator(withRuntimePolicyTrait([], { version: 1, tools: ["Read"] }));
		const target = await narrator(
			withRuntimePolicyTrait([], { version: 1, tools: ["Read", "Write"] }),
		);
		await setPolicySource(target, source);
		const policy = await resolveNarratorRuntimePolicy(target);
		expect(isRuntimeToolAllowed(policy, "Read")).toBe(true);
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
	});

	test("cycles and missing sources are refused at registration and fail at resolution", async () => {
		const a = await narrator();
		const b = await narrator();
		await setPolicySource(b, a);
		expect(await captureWorkerRejectionThrower(setPolicySource(a, b))).toThrow("cycle");
		expect(await captureWorkerRejectionThrower(setPolicySource(a, a))).toThrow("cycle");
		// A cycle written behind the service's back still fails closed.
		await db.update(narrators).set({ policySourceNarratorId: b }).where(eq(narrators.id, a));
		expect(await captureWorkerRejectionThrower(resolveNarratorRuntimePolicy(a))).toThrow("cycle");

		// The column's FK refuses a missing source outright.
		expect(() =>
			db
				.update(narrators)
				.set({ policySourceNarratorId: "missing-source" })
				.where(eq(narrators.id, a))
				.run(),
		).toThrow();
	});

	test("chains deeper than the bound are refused", async () => {
		const ids: string[] = [];
		for (let i = 0; i <= MAX_POLICY_SOURCE_DEPTH; i++) ids.push(await narrator());
		for (let i = 1; i < ids.length; i++) {
			await db
				.update(narrators)
				.set({ policySourceNarratorId: ids[i - 1] })
				.where(eq(narrators.id, ids[i]));
		}
		expect(
			await captureWorkerRejectionThrower(resolveNarratorRuntimePolicy(ids.at(-1) as string)),
		).toThrow("too deep");
	});

	test("an unreadable registration or ceiling never resolves as unrestricted", async () => {
		const id = await narrator(["custom-runtime-policy:not-json"]);
		expect(await captureWorkerRejectionThrower(resolveNarratorRuntimePolicy(id))).toThrow();
		await setTraits(id, []);
		await db
			.update(narrators)
			.set({ runtimeRegistrationJson: { version: 2 } as never })
			.where(eq(narrators.id, id));
		expect(await captureWorkerRejectionThrower(resolveNarratorRuntimePolicy(id))).toThrow();
	});
});

describe("delegation creation", () => {
	test("a created child stores its compiled ceiling and follows the parent live", async () => {
		const parent = await narrator();
		const child = await narratorService.createSubagent({
			subagentOriginKind: "standalone",
			parentNarratorId: parent,
			subagentType: "general",
			cwd: ".",
		});
		created.push(child.id);
		expect(await getRuntimeRegistration(child.id)).toMatchObject({
			modelPool: "general",
			controller: { narratorId: parent },
		});
		expect((await narratorService.getById(child.id)).policySourceNarratorId).toBe(parent);
		const before = await resolveNarratorRuntimePolicy(child.id);
		expect(before.capabilities.spawnAgent).toBe(false);
		expect(isRuntimeToolAllowed(before, "Write")).toBe(true);

		// The parent becomes read-only after creation: the child follows on its next resolve.
		await setTraits(parent, withRuntimePolicyTrait([], { version: 1, readOnly: true }));
		expect(isRuntimeToolAllowed(await resolveNarratorRuntimePolicy(child.id), "Write")).toBe(false);
	});

	test("every legacy delegated shape materializes a restricted ceiling", async () => {
		const typeOnly = await narrator();
		await db
			.update(narrators)
			.set({ type: "subagent", variant: "primary", subagentType: null })
			.where(eq(narrators.id, typeOnly));
		const bareVariant = await narrator();
		await db.update(narrators).set({ variant: "subagent" }).where(eq(narrators.id, bareVariant));
		const typedExplore = await narrator();
		await db
			.update(narrators)
			.set({ type: "subagent", variant: "primary", subagentType: "explore" })
			.where(eq(narrators.id, typedExplore));
		await materializeLegacyDelegations([typeOnly, bareVariant, typedExplore]);
		for (const id of [typeOnly, bareVariant, typedExplore]) {
			const policy = await resolveNarratorRuntimePolicy(id);
			expect(policy.capabilities.spawnAgent).toBe(false);
			expect(policy.capabilities.askUserQuestion).toBe("disabled");
		}
		// Fallback template is "general"; an explicit legacy subagentType is honoured.
		expect(isRuntimeToolAllowed(await resolveNarratorRuntimePolicy(typeOnly), "Write")).toBe(true);
		expect(isRuntimeToolAllowed(await resolveNarratorRuntimePolicy(typedExplore), "Write")).toBe(
			false,
		);
	});

	test("custom templates compile once at creation; later edits or deletion do not move the ceiling", async () => {
		const parent = await narrator();
		const name = `ceiling-${Date.now()}`;
		const definition = {
			name,
			description: "fixture",
			toolAccess: "custom" as const,
			customTools: ["Read", "Write"],
			defaultModel: "",
			prompt: "fixture",
		};
		await customSubagentService.create(definition);
		try {
			const child = await narratorService.createSubagent({
				subagentOriginKind: "standalone",
				parentNarratorId: parent,
				subagentType: name,
				cwd: ".",
			});
			created.push(child.id);
			const expectCreationCeiling = async () => {
				const policy = await resolveNarratorRuntimePolicy(child.id);
				expect(policy.tools.builtin).toEqual(["Read", "Write"]);
				expect(isRuntimeToolAllowed(policy, "Grep")).toBe(false);
			};
			await expectCreationCeiling();
			await customSubagentService.update(name, { ...definition, customTools: ["Grep"] });
			await expectCreationCeiling();
			await customSubagentService.remove(name);
			await expectCreationCeiling();
		} finally {
			await customSubagentService.remove(name).catch(() => {});
		}
	});

	test("a custom template missing at creation compiles to read-only", async () => {
		const parent = await narrator();
		const child = await narratorService.createSubagent({
			subagentOriginKind: "standalone",
			parentNarratorId: parent,
			subagentType: "definition-that-does-not-exist",
			cwd: ".",
		});
		created.push(child.id);
		const policy = await resolveNarratorRuntimePolicy(child.id);
		expect(policy.tools.readOnly).toBe(true);
		expect(isRuntimeToolAllowed(policy, "Write")).toBe(false);
		expect(isRuntimeToolAllowed(policy, "Read")).toBe(true);
	});

	test("legacy delegated rows materialize their template's ceiling", async () => {
		const id = await narrator();
		await db.update(narrators).set({ variant: "subagent:review" }).where(eq(narrators.id, id));
		await materializeLegacyDelegations([id]);
		const policy = await resolveNarratorRuntimePolicy(id);
		expect(policy.readOnlyGitShell).toBe(true);
		expect(policy.capabilities.askUserQuestion).toBe("disabled");
	});
});
