/**
 * Bulk migration for narrators pinned to an unusable model.
 *
 * These tests use the real database and the real settings singleton so the scan
 * exercises the same `resolveProviderAndModel` / `getVisibleModels` behaviour the
 * server uses. Each test creates uniquely-tagged narrators and removes them again,
 * so nothing leaks between tests or into other suites.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { ValidationError } from "../../lib/errors";
import { deleteNugCachedModels, setNugCachedModels } from "../../lib/nug-model-cache";
import { settings } from "../../lib/settings";
import {
	applyModelMigration,
	hasBrokenModelMigrationUndo,
	migrateBrokenModelNarrators,
	scanBrokenModelNarrators,
	undoLastBrokenModelMigration,
} from "../broken-model-migration-service";

const TAG = `broken-model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdIds: string[] = [];
const settingsSnapshot = structuredClone(settings);
const settingsKeys = Object.keys(settings) as Array<keyof typeof settings>;

function restoreSettings(): void {
	for (const key of settingsKeys) {
		// biome-ignore lint/suspicious/noExplicitAny: generic key/value restoration in test helper
		(settings as any)[key] = structuredClone(settingsSnapshot)[key];
	}
}

/** A working OpenAI-compatible provider whose catalog contains exactly `models`. */
function useProvider(prefix: string, models: string[]): void {
	settings.openaiProviders = [
		{
			id: `${prefix}-id`,
			name: prefix,
			prefix,
			apiKey: "test-key",
			baseUrl: "https://example.invalid/v1",
			defaultModel: models[0] ?? "model-a",
		},
	];
	settings.agent.customModels = models.map((model) => ({
		value: `${prefix}:${model}`,
		label: model,
		provider: prefix,
	}));
	settings.agent.hiddenModels = [];
}

async function createNarrator(input: {
	suffix: string;
	model: string | null;
	type?: "primary" | "subagent";
	status?: "idle" | "archived";
	pendingModelRestore?: string | null;
}): Promise<string> {
	const id = `${TAG}-${input.suffix}`;
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		type: input.type ?? "primary",
		variant: input.type === "subagent" ? "subagent:explore" : "primary",
		traits: ["standalone"],
		title: `title-${input.suffix}`,
		model: input.model,
		pendingModelRestore: input.pendingModelRestore ?? null,
		permissionMode: "default",
		status: input.status ?? "idle",
		createdAt: now,
		updatedAt: now,
	});
	createdIds.push(id);
	return id;
}

async function readNarrator(id: string) {
	const row = await db.query.narrators.findFirst({
		where: (n, { eq }) => eq(n.id, id),
		columns: { model: true, pendingModelRestore: true },
	});
	if (!row) throw new Error(`narrator ${id} not found`);
	return row;
}

/** All flagged narrators in this test's tag, flattened across groups. */
async function scanOurs(options?: { includeArchived?: boolean }) {
	const scan = await scanBrokenModelNarrators(options);
	return {
		...scan,
		groups: scan.groups
			.map((group) => ({
				...group,
				narrators: group.narrators.filter((n) => n.id.startsWith(TAG)),
			}))
			.filter((group) => group.narrators.length > 0),
	};
}

beforeEach(() => {
	restoreSettings();
});

afterEach(async () => {
	if (createdIds.length > 0) {
		await db.delete(narrators).where(inArray(narrators.id, createdIds));
		createdIds.length = 0;
	}
	// Drain any undo record this test wrote so the next one starts clean.
	if (hasBrokenModelMigrationUndo()) {
		await undoLastBrokenModelMigration().catch(() => {});
	}
	deleteNugCachedModels("nug-test-id");
});

afterAll(() => {
	restoreSettings();
});

describe("broken model scan classification", () => {
	test("flags a model whose provider prefix no longer exists", async () => {
		useProvider("good", ["model-a"]);
		const id = await createNarrator({ suffix: "gone", model: "cun:some-model" });

		const scan = await scanOurs();

		expect(scan.groups).toHaveLength(1);
		expect(scan.groups[0]).toMatchObject({
			providerPrefix: "cun",
			reason: "provider_missing",
		});
		expect(scan.groups[0].narrators.map((n) => n.id)).toEqual([id]);
		expect(scan.totalBroken).toBeGreaterThanOrEqual(1);
	});

	test("ignores meta references, which follow global settings rather than a provider", async () => {
		useProvider("good", ["model-a"]);
		await createNarrator({ suffix: "meta-default", model: "__default__" });
		await createNarrator({ suffix: "meta-summary", model: "__summary__" });
		await createNarrator({ suffix: "meta-agg", model: "__agg__:balanced" });
		await createNarrator({ suffix: "meta-prefixed", model: "good:__default__" });
		await createNarrator({ suffix: "meta-null", model: null });

		expect((await scanOurs()).groups).toHaveLength(0);
	});

	test("ignores a model that resolves and is in the catalog", async () => {
		useProvider("good", ["model-a"]);
		await createNarrator({ suffix: "fine", model: "good:model-a" });

		expect((await scanOurs()).groups).toHaveLength(0);
	});

	test("flags an uncatalogued model as a suspicion, not definite breakage", async () => {
		useProvider("good", ["model-a"]);
		await createNarrator({ suffix: "unlisted", model: "good:hand-typed-model" });

		const scan = await scanOurs();

		expect(scan.groups).toHaveLength(1);
		expect(scan.groups[0].reason).toBe("model_not_listed");
		// Counted as suspect so the UI can leave it unselected.
		expect(scan.totalSuspect).toBeGreaterThanOrEqual(1);
	});

	test("does not flag a NUG model that is merely temporarily unavailable", async () => {
		// A model flagged available:false is a transient outage already handled by the
		// availability poller, which suspends the narrator until it recovers. Migrating
		// it away would fight that recovery path.
		settings.nugProviders = [
			{
				id: "nug-test-id",
				name: "nug-test",
				prefix: "nugtest",
				baseUrl: "https://example.invalid",
				apiKey: "test-key",
				defaultModel: "antigravity:down-model",
			},
		];
		settings.agent.customModels = [];
		setNugCachedModels("nug-test-id", [
			{ id: "antigravity:down-model", channel: "antigravity", model: "down-model", available: false },
		]);
		await createNarrator({ suffix: "nug-down", model: "nugtest:antigravity:down-model" });

		expect((await scanOurs()).groups).toHaveLength(0);
	});

	test("excludes subagents, whose model is a derived task snapshot", async () => {
		useProvider("good", ["model-a"]);
		await createNarrator({ suffix: "sub", model: "cun:some-model", type: "subagent" });

		expect((await scanOurs()).groups).toHaveLength(0);
	});

	test("excludes archived narrators unless explicitly requested", async () => {
		useProvider("good", ["model-a"]);
		const id = await createNarrator({
			suffix: "archived",
			model: "cun:some-model",
			status: "archived",
		});

		expect((await scanOurs()).groups).toHaveLength(0);

		const withArchived = await scanOurs({ includeArchived: true });
		expect(withArchived.groups[0]?.narrators.map((n) => n.id)).toEqual([id]);
	});

	test("reports a broken pendingModelRestore so migration can clear it", async () => {
		useProvider("good", ["model-a"]);
		await createNarrator({
			suffix: "pending",
			model: "cun:some-model",
			pendingModelRestore: "cun:other-model",
		});

		const scan = await scanOurs();
		expect(scan.groups[0].narrators[0].hasBrokenPendingRestore).toBe(true);
	});

	test("groups by provider prefix and lists definite breakage first", async () => {
		useProvider("good", ["model-a"]);
		await createNarrator({ suffix: "unlisted", model: "good:hand-typed" });
		await createNarrator({ suffix: "gone-a", model: "cun:m" });
		await createNarrator({ suffix: "gone-b", model: "zzz:m" });

		const scan = await scanOurs();

		expect(scan.groups.map((g) => [g.reason, g.providerPrefix])).toEqual([
			["provider_missing", "cun"],
			["provider_missing", "zzz"],
			["model_not_listed", "good"],
		]);
	});
});

describe("broken model migration", () => {
	test("refuses a target model that is itself unusable", async () => {
		useProvider("good", ["model-a"]);
		const id = await createNarrator({ suffix: "gone", model: "cun:some-model" });

		await expect(
			migrateBrokenModelNarrators({ targetModel: "alsogone:m", narratorIds: [id] }),
		).rejects.toThrow(ValidationError);
		// The narrator must be left untouched by a rejected migration.
		expect((await readNarrator(id)).model).toBe("cun:some-model");
	});

	test("migrates selected narrators and clears a broken pendingModelRestore", async () => {
		useProvider("good", ["model-a"]);
		const id = await createNarrator({
			suffix: "gone",
			model: "cun:some-model",
			pendingModelRestore: "cun:other-model",
		});

		const result = await migrateBrokenModelNarrators({
			targetModel: "good:model-a",
			narratorIds: [id],
		});

		expect(result).toMatchObject({ migrated: 1, skipped: 0, undoAvailable: true });
		// Without clearing pendingModelRestore, restorePendingModelOverrides() would
		// write the broken model back on the next restart.
		expect(await readNarrator(id)).toEqual({
			model: "good:model-a",
			pendingModelRestore: null,
		});
	});

	test("leaves untouched narrators out of the migration", async () => {
		useProvider("good", ["model-a"]);
		const broken = await createNarrator({ suffix: "gone", model: "cun:some-model" });
		const healthy = await createNarrator({ suffix: "fine", model: "good:model-a" });

		const result = await migrateBrokenModelNarrators({
			targetModel: "good:model-a",
			narratorIds: [broken, healthy],
		});

		// The healthy narrator is not in the broken set, so it is skipped rather than rewritten.
		expect(result).toMatchObject({ migrated: 1, skipped: 1 });
	});

	test("skips a narrator changed after the scan instead of failing the batch", async () => {
		useProvider("good", ["model-a"]);
		const racing = await createNarrator({ suffix: "racing", model: "cun:some-model" });
		const stable = await createNarrator({ suffix: "stable", model: "zzz:some-model" });

		const scan = await scanOurs();
		const candidates = scan.groups.flatMap((group) => group.narrators);
		expect(candidates).toHaveLength(2);

		// Simulate the user re-picking a model between the scan and the confirm. Driving the
		// durable step directly is the only deterministic way to land a change inside that window.
		await db
			.update(narrators)
			.set({ model: "yyy:changed-by-user" })
			.where(inArray(narrators.id, [racing]));

		const applied = applyModelMigration(candidates, "good:model-a");

		// Only the stale row is skipped; the rest of the batch still commits.
		expect(applied.skipped).toBe(1);
		expect(applied.entries.map((entry) => entry.id)).toEqual([stable]);
		expect((await readNarrator(stable)).model).toBe("good:model-a");
		expect((await readNarrator(racing)).model).toBe("yyy:changed-by-user");
	});

	test("requires at least one narrator", async () => {
		useProvider("good", ["model-a"]);
		await expect(
			migrateBrokenModelNarrators({ targetModel: "good:model-a", narratorIds: [] }),
		).rejects.toThrow(ValidationError);
	});
});

describe("broken model migration undo", () => {
	test("restores the previous model and pendingModelRestore", async () => {
		useProvider("good", ["model-a"]);
		const id = await createNarrator({
			suffix: "gone",
			model: "cun:some-model",
			pendingModelRestore: "cun:other-model",
		});
		await migrateBrokenModelNarrators({ targetModel: "good:model-a", narratorIds: [id] });

		const undone = await undoLastBrokenModelMigration();

		expect(undone).toMatchObject({ restored: 1, skipped: 0 });
		expect(await readNarrator(id)).toEqual({
			model: "cun:some-model",
			pendingModelRestore: "cun:other-model",
		});
	});

	test("leaves a narrator the user re-picked after the migration alone", async () => {
		useProvider("good", ["model-a", "model-b"]);
		const id = await createNarrator({ suffix: "gone", model: "cun:some-model" });
		await migrateBrokenModelNarrators({ targetModel: "good:model-a", narratorIds: [id] });

		// The user's newer choice must win over an undo of the bulk migration.
		await db
			.update(narrators)
			.set({ model: "good:model-b" })
			.where(inArray(narrators.id, [id]));

		const undone = await undoLastBrokenModelMigration();

		expect(undone).toMatchObject({ restored: 0, skipped: 1 });
		expect((await readNarrator(id)).model).toBe("good:model-b");
	});

	test("keeps only the most recent migration undoable", async () => {
		useProvider("good", ["model-a", "model-b"]);
		const id = await createNarrator({ suffix: "gone", model: "cun:some-model" });
		await migrateBrokenModelNarrators({ targetModel: "good:model-a", narratorIds: [id] });
		// good:model-a resolves and is catalogued, so a second pass needs a fresh break.
		await db
			.update(narrators)
			.set({ model: "zzz:still-broken" })
			.where(inArray(narrators.id, [id]));
		await migrateBrokenModelNarrators({ targetModel: "good:model-b", narratorIds: [id] });

		await undoLastBrokenModelMigration();

		// Undo rewinds only the second migration, never further back.
		expect((await readNarrator(id)).model).toBe("zzz:still-broken");
		expect(hasBrokenModelMigrationUndo()).toBe(false);
	});

	test("reports a missing undo record instead of silently succeeding", async () => {
		expect(hasBrokenModelMigrationUndo()).toBe(false);
		await expect(undoLastBrokenModelMigration()).rejects.toThrow(ValidationError);
	});
});
