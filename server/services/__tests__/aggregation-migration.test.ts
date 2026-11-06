import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { hooks, narrators, scheduledTasks } from "../../db/schema";
import { generateId } from "../../lib/id";
import { type NarraForkSettings, saveSettings, settings } from "../../lib/settings";
import {
	commitAggregationMigration,
	migrateAggregationsOnStartup,
	planAggregationMigration,
} from "../aggregation-migration-service";

// Runs under the temp NARRAFORK_HOME that tests/preload.ts sets up; saves never touch a real
// home. Members are configured providers so the catalog can split prefix and model id.

const original = structuredClone(settings);
const narratorIds: string[] = [];
const taskIds: string[] = [];
const hookIds: string[] = [];
const now = new Date().toISOString();

const provider = (id: string, prefix: string) => ({
	id,
	name: prefix,
	prefix,
	apiKey: "",
	baseUrl: `https://${prefix}.example/v1`,
	defaultModel: "m",
	protocol: "completions-compatible" as const,
});

function configure(agent: Partial<NarraForkSettings["agent"]>) {
	saveSettings({
		...settings,
		customApiProviders: [provider("aggMigA", "pa"), provider("aggMigB", "pb")],
		openaiProviders: undefined,
		anthropicProviders: undefined,
		geminiProviders: undefined,
		agent: {
			...settings.agent,
			modelAggregations: [
				{
					id: "same",
					name: "Opus",
					models: ["pa:claude-opus-4-6", "pb:claude-opus-4.6"],
					routingMode: "priority",
				},
				{
					id: "mixed",
					name: "Mix",
					models: ["pb:gpt-5.5", "pa:claude-opus-4-6"],
					routingMode: "priority",
				},
			],
			...agent,
		},
	});
}

function narrator(model: string | null, pending: string | null = null): string {
	const id = generateId();
	narratorIds.push(id);
	db.insert(narrators)
		.values({
			id,
			title: "agg",
			cwd: "/tmp",
			model,
			pendingModelRestore: pending,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return id;
}

const modelOf = (id: string) =>
	db
		.select({ model: narrators.model, pending: narrators.pendingModelRestore })
		.from(narrators)
		.where(eq(narrators.id, id))
		.get();

beforeEach(() => configure({}));

afterEach(() => {
	saveSettings(structuredClone(original));
	if (narratorIds.length)
		db.delete(narrators)
			.where(inArray(narrators.id, narratorIds.splice(0)))
			.run();
	if (taskIds.length)
		db.delete(scheduledTasks)
			.where(inArray(scheduledTasks.id, taskIds.splice(0)))
			.run();
	if (hookIds.length)
		db.delete(hooks)
			.where(inArray(hooks.id, hookIds.splice(0)))
			.run();
});

describe("aggregation migration", () => {
	test("settings fields, pools and fixed tiers move; deleted aggregations stay", async () => {
		configure({
			defaultModel: "__agg__:same",
			summaryModel: "__agg__:mixed:pa:claude-opus-4-6",
			translationModel: "__agg__:gone",
			subagentModels: { explore: "__agg__:mixed", plan: "" },
			subagentAllowedModels: {
				explore: ["__agg__:same", "pa:claude-opus-4-6", "__agg__:mixed"],
				plan: [],
				general: [],
			},
			subagentModelReasoningEfforts: { explore: { "__agg__:same": "low" } },
		});
		const plan = await planAggregationMigration();
		expect(plan.unresolved).toBe(1);
		await commitAggregationMigration(plan);

		expect(settings.agent.defaultModel).toBe("auto:claude-opus-4-6");
		expect(settings.agent.summaryModel).toBe("pa:claude-opus-4-6");
		expect(settings.agent.translationModel).toBe("__agg__:gone");
		expect(settings.agent.subagentModels.explore).toBe("pb:gpt-5.5");
		// "__agg__:mixed" became "pb:gpt-5.5"; the duplicate concrete entry is kept once.
		expect(settings.agent.subagentAllowedModels.explore).toEqual([
			"auto:claude-opus-4-6",
			"pa:claude-opus-4-6",
			"pb:gpt-5.5",
		]);
		expect(settings.agent.subagentModelReasoningEfforts?.explore).toEqual({
			"auto:claude-opus-4-6": "low",
		});
		// The aggregations stay (read-only in the UI) so `__agg__:gone`-style values still resolve.
		expect(settings.agent.modelAggregations?.map((a) => a.id)).toEqual(["same", "mixed"]);
	});

	test("narrators, scheduled tasks and hooks move; a row changed meanwhile is left alone", async () => {
		const a = narrator("__agg__:same", "__agg__:mixed:pb:gpt-5.5");
		const b = narrator("codex:gpt-5.5");
		const c = narrator("__agg__:gone");
		const raced = narrator("__agg__:mixed");
		const task = generateId();
		taskIds.push(task);
		db.insert(scheduledTasks)
			.values({
				id: task,
				name: "t",
				cronExpr: "* * * * *",
				prompt: "p",
				model: "__agg__:same",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const hook = generateId();
		hookIds.push(hook);
		db.insert(hooks)
			.values({
				id: hook,
				event: "Stop",
				type: "command",
				model: "__agg__:mixed",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const plan = await planAggregationMigration();
		// A user switches this narrator after the plan was made.
		db.update(narrators).set({ model: "pb:gpt-5.5-mini" }).where(eq(narrators.id, raced)).run();
		const applied = await commitAggregationMigration(plan);
		expect(applied).toBe(plan.rows.length - 1);

		expect(modelOf(a)).toEqual({ model: "auto:claude-opus-4-6", pending: "pb:gpt-5.5" });
		expect(modelOf(b)?.model).toBe("codex:gpt-5.5");
		expect(modelOf(c)?.model).toBe("__agg__:gone");
		expect(modelOf(raced)?.model).toBe("pb:gpt-5.5-mini");
		expect(db.select().from(scheduledTasks).where(eq(scheduledTasks.id, task)).get()?.model).toBe(
			"auto:claude-opus-4-6",
		);
		expect(db.select().from(hooks).where(eq(hooks.id, hook)).get()?.model).toBe("pb:gpt-5.5");
	});

	test("a failed settings save puts the rows back", async () => {
		const id = narrator("__agg__:same");
		configure({ defaultModel: "__agg__:same" });
		const plan = await planAggregationMigration();
		const broken = { ...plan, settings: { ...plan.settings } as NarraForkSettings };
		// A settings object without `agent` makes the save throw after the rows were written.
		(broken.settings as { agent?: unknown }).agent = undefined;
		await expect(commitAggregationMigration(broken)).rejects.toThrow();
		expect(modelOf(id)?.model).toBe("__agg__:same");
	});

	test("waits while a provider is still prefixed auto, so auto: values are not written early", async () => {
		const id = narrator("__agg__:same");
		saveSettings({
			...settings,
			customApiProviders: [...(settings.customApiProviders ?? []), provider("aggMigAuto", "auto")],
			openaiProviders: undefined,
			anthropicProviders: undefined,
			geminiProviders: undefined,
		});
		await migrateAggregationsOnStartup();
		expect(modelOf(id)?.model).toBe("__agg__:same");
		expect(settings.agent.modelAggregations?.length).toBe(2);
	});

	test("the startup entry is idempotent and never throws", async () => {
		const id = narrator("__agg__:same");
		await migrateAggregationsOnStartup();
		await migrateAggregationsOnStartup();
		expect(modelOf(id)?.model).toBe("auto:claude-opus-4-6");
	});
});
