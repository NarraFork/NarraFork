import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { FOLLOW_PARENT_MODEL } from "../../../shared/model-inheritance";
import {
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../../lib/narrator-custom-traits";

const CHILD_ENV = "NARRAFORK_SUBAGENT_MODEL_RESELECT_TEST_CHILD";

// Service module mocks must never escape into another test file's module registry.
if (process.env[CHILD_ENV] !== "1") {
	test("subagent model re-selection: isolated execution", async () => {
		const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_ENV]: "1" };
		delete env.NARRAFORK_HOME;
		const child = Bun.spawn(
			[process.execPath, "test", "--no-env-file", "--isolate", import.meta.path],
			{
				cwd: resolve(import.meta.dir, "../../.."),
				env,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => child.kill(), 45_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
			expect(stderr).toContain("0 fail");
			expect(stderr).toMatch(/[1-9]\d* pass/);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill();
		}
	}, 50_000);
} else {
	const writes: Array<{ id: string; input: Record<string, unknown> }> = [];
	const realSession = { ...(await import("../narrator-session")) };
	mock.module("../narrator-session", () => ({
		...realSession,
		updateNarratorProfileForPlugin: async (id: string, input: Record<string, unknown>) => {
			writes.push({ id, input });
			const row = rows.get(id);
			if (row && typeof input.model === "string") row.model = input.model;
			return { updated: Object.keys(input) };
		},
	}));
	const realTraits = { ...(await import("../trait-layer-service")) };
	mock.module("../trait-layer-service", () => ({
		...realTraits,
		resolveNarratorProjectId: async () => null,
		resolveEffectiveTraits: async (input: { narratorTraits: unknown }) => ({
			traits: input.narratorTraits ?? [],
		}),
	}));
	const realWebsocket = { ...(await import("../../websocket/narrator-ws")) };
	mock.module("../../websocket/narrator-ws", () => ({
		...realWebsocket,
		broadcastToNarrator: () => {},
	}));

	const { settings } = await import("../../lib/settings");
	const { narratorService } = await import("../narrator-service");
	const { selectSubagentModel } = await import("../subagent-model");
	const { activeNarrators, clearNarratorRuntimeModel, recordNarratorRuntimeModel } = await import(
		"../narrator-session-state"
	);
	const {
		isNewSubagentModelSelectionRun,
		markExplicitSubagentModelPin,
		reselectSubagentModelForNewRun,
	} = await import("../subagent-model-switch");

	type Row = {
		id: string;
		type: string;
		model: string | null;
		subagentType?: string | null;
		parentNarratorId?: string | null;
		policySourceNarratorId?: string | null;
		runtimeRegistrationJson?: unknown;
		traits?: unknown;
		reasoningEffort?: string | null;
	};
	const rows = new Map<string, Row>();
	spyOn(narratorService, "getById").mockImplementation((async (id: string) => {
		const row = rows.get(id);
		if (!row) throw new Error(`Narrator ${id} not found`);
		return row;
	}) as unknown as typeof narratorService.getById);

	const PARENT = "reselect-parent";
	const CHILD = "reselect-child";
	const setParent = (model: string | null) =>
		rows.set(PARENT, { id: PARENT, type: "primary", model, traits: [] });
	const setChild = (model: string | null, subagentType = "general", extra: Partial<Row> = {}) =>
		rows.set(CHILD, {
			id: CHILD,
			type: "subagent",
			model,
			subagentType,
			parentNarratorId: PARENT,
			policySourceNarratorId: PARENT,
			runtimeRegistrationJson: null,
			traits: [],
			...extra,
		});

	const original = {
		allowed: settings.agent.subagentAllowedModels,
		efforts: settings.agent.subagentModelReasoningEfforts,
		prefs: settings.agent.subagentModels,
		aggregations: settings.agent.modelAggregations,
		disabled: settings.agent.disabledProviders,
	};
	const setPool = (models: string[], efforts: Record<string, string> = {}) => {
		settings.agent.subagentAllowedModels = { general: models } as never;
		settings.agent.subagentModelReasoningEfforts = { general: efforts } as never;
	};

	beforeEach(() => {
		writes.length = 0;
		rows.clear();
		settings.agent.disabledProviders = [];
		settings.agent.subagentAllowedModels = {} as never;
		settings.agent.subagentModelReasoningEfforts = {} as never;
		settings.agent.subagentModels = {} as never;
	});
	afterEach(() => {
		activeNarrators.delete(PARENT);
		clearNarratorRuntimeModel(PARENT);
		settings.agent.subagentAllowedModels = original.allowed;
		settings.agent.subagentModelReasoningEfforts = original.efforts;
		settings.agent.subagentModels = original.prefs;
		settings.agent.modelAggregations = original.aggregations;
		settings.agent.disabledProviders = original.disabled;
	});
	afterAll(() => mock.restore());

	describe("selectSubagentModel (creation and re-selection rule)", () => {
		const pool = {
			source: "settings" as const,
			poolKey: "general",
			models: [{ model: "provB:m1" }, { model: "provA:m2", reasoningEffort: "high" as const }],
			isExplicitEmpty: false,
		};
		const none = {
			source: "none" as const,
			poolKey: "general",
			models: [],
			isExplicitEmpty: false,
		};

		test("pool: the parent's current model wins when the pool allows it", () => {
			expect(selectSubagentModel({ policy: pool, parentModel: "provA:m2" })).toEqual({
				storedModel: "provA:m2",
				selection: { model: "provA:m2", poolEntry: pool.models[1] },
			});
		});
		test("pool: then the first entry on the parent's provider", () => {
			expect(selectSubagentModel({ policy: pool, parentModel: "provA:other" })?.storedModel).toBe(
				"provA:m2",
			);
		});
		test("pool: otherwise the first entry", () => {
			expect(selectSubagentModel({ policy: pool, parentModel: "provC:x" })?.storedModel).toBe(
				"provB:m1",
			);
		});
		test("no pool: a preference pins, otherwise follow the parent", () => {
			expect(
				selectSubagentModel({ policy: none, parentModel: "provA:x", typePreference: "provC:p" }),
			).toEqual({ storedModel: "provC:p", selection: { model: "provC:p" } });
			expect(selectSubagentModel({ policy: none, parentModel: "provA:x" })).toEqual({
				storedModel: FOLLOW_PARENT_MODEL,
			});
		});
		test("an explicit model stays as is", () => {
			expect(
				selectSubagentModel({ policy: pool, parentModel: "provA:m2", explicitModel: "provB:m1" })
					?.storedModel,
			).toBe("provB:m1");
		});
	});

	describe("isNewSubagentModelSelectionRun", () => {
		test("only a new logical run re-selects", () => {
			expect(isNewSubagentModelSelectionRun({})).toBe(true);
			expect(isNewSubagentModelSelectionRun({ recovered: true })).toBe(false);
			expect(isNewSubagentModelSelectionRun({ resumeRunId: "run-1" })).toBe(false);
			expect(isNewSubagentModelSelectionRun({ admission: {} })).toBe(false);
			expect(isNewSubagentModelSelectionRun({ skipModelReselect: true })).toBe(false);
		});
	});

	describe("reselectSubagentModelForNewRun", () => {
		test("same provider keeps the child's model", async () => {
			setPool(["provA:m1", "provA:m2"]);
			setParent("provA:m2");
			setChild("provA:m1");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
		});

		for (const runtime of ["active", "recorded", "unknown"] as const) {
			test(`a nested helper uses its following worker's ${runtime} provider`, async () => {
				setPool(["provB:m1", "provA:m2", "provA:m3"]);
				rows.set(PARENT, {
					id: PARENT,
					type: "subagent",
					model: FOLLOW_PARENT_MODEL,
					traits: [],
				});
				setChild("provB:m1");
				if (runtime === "active")
					activeNarrators.set(PARENT, { provider: "provA", model: "provA:m3" } as never);
				if (runtime === "recorded")
					recordNarratorRuntimeModel(PARENT, FOLLOW_PARENT_MODEL, "provA", "m3");
				expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(runtime !== "unknown");
				expect(writes).toEqual(
					runtime === "unknown" ? [] : [{ id: CHILD, input: { model: "provA:m3" } }],
				);
			});
		}

		test("another provider re-selects: parent model in the pool, with its fixed tier", async () => {
			setPool(["provB:m1", "provA:m2"], { "provA:m2": "high" });
			setParent("provA:m2");
			setChild("provB:m1");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
			expect(writes).toEqual([
				{ id: CHILD, input: { model: "provA:m2", reasoningEffort: "high" } },
			]);
		});

		test("another provider re-selects: first entry on the parent's provider", async () => {
			setPool(["provB:m1", "provA:m2", "provA:m3"]);
			setParent("provA:other");
			setChild("provB:m1");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
			expect(writes[0]?.input.model).toBe("provA:m2");
		});

		test("another provider re-selects: first entry when none matches; unchanged is not written", async () => {
			setPool(["provB:m1", "provB:m2"]);
			setParent("provC:x");
			setChild("provB:m2");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
			expect(writes[0]?.input.model).toBe("provB:m1");
			writes.length = 0;
			setChild("provB:m1");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
		});

		test("no pool: preference pins, otherwise the child follows its parent", async () => {
			settings.agent.subagentModels = { explore: "provC:pref" } as never;
			setParent("provA:x");
			setChild("provB:manual", "explore");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
			expect(writes[0]?.input.model).toBe("provC:pref");
			writes.length = 0;
			setChild("provB:manual", "general");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
			expect(writes[0]?.input.model).toBe(FOLLOW_PARENT_MODEL);
		});

		test("a manually pinned model on another provider is re-selected too", async () => {
			setPool(["provA:m1", "provB:m9"]);
			setParent("provA:m1");
			// Pinned by hand to an entry on another provider than the parent's current one.
			setChild("provB:m9");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
			expect(writes[0]?.input.model).toBe("provA:m1");
		});

		test("an undeterminable provider keeps the model", async () => {
			const aggId = `reselect-balanced-${crypto.randomUUID()}`;
			settings.agent.modelAggregations = [
				{ id: aggId, name: "B", models: ["provB:x", "provA:y"], routingMode: "balanced" },
			] as never;
			setPool(["provA:m1", "provB:m2"]);
			setParent(`__agg__:${aggId}`);
			setChild("provB:m2");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			setParent("provA:m1");
			setChild(`__agg__:${aggId}`);
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
		});

		test("a missing source or a following child keeps the model", async () => {
			setChild("provB:m1");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			setParent("provA:m1");
			setChild(FOLLOW_PARENT_MODEL);
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
		});

		test("a placement parent without a registered model source never triggers re-selection", async () => {
			setParent("provA:m1");
			setChild("provB:m2", "general", { policySourceNarratorId: null });
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
		});

		test("an explicit Send model is kept for the next run, once", async () => {
			setPool(["provA:m1", "provB:m2"]);
			setParent("provA:m1");
			setChild("provB:m2");
			markExplicitSubagentModelPin(CHILD, "provB:m2");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
			// The pin is one-shot: a later new run applies the ordinary rule.
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
			expect(writes[0]?.input.model).toBe("provA:m1");
		});

		test("an empty allowed pool keeps the existing model", async () => {
			setParent("provA:m1");
			const parent = rows.get(PARENT);
			if (parent)
				parent.traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
					version: 1,
					pools: { general: [] },
				});
			setChild("provB:m2");
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
		});

		test("a missing child is a best-effort no-op", async () => {
			expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(false);
			expect(writes).toEqual([]);
		});

		test("expired explicit pins do not block re-selection", async () => {
			setPool(["provA:m1", "provB:m2"]);
			setParent("provA:m1");
			setChild("provB:m2");
			markExplicitSubagentModelPin(CHILD, "provB:m2");
			const now = Date.now();
			const clock = spyOn(Date, "now").mockReturnValue(now + 10 * 60 * 1000 + 1);
			try {
				expect(await reselectSubagentModelForNewRun(CHILD, null)).toBe(true);
				expect(writes[0]?.input.model).toBe("provA:m1");
			} finally {
				clock.mockRestore();
			}
		});
	});
}
