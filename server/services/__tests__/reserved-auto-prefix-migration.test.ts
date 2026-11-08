import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import { resolveEffectiveModel, saveSettings, settings } from "../../lib/settings";
import { migrateReservedAutoPrefixOnStartup } from "../provider-prefix-migration-service";

// `auto` became the reserved prefix of auto:<model>. A provider created earlier under that
// prefix is renamed on startup, and every reference follows it.

// tests/preload.ts points NARRAFORK_HOME at a fresh temp directory, so saves stay isolated.
const saved = {
	customApiProviders: structuredClone(settings.customApiProviders),
	nugProviders: structuredClone(settings.nugProviders),
	defaultModel: settings.agent.defaultModel,
	hiddenModels: structuredClone(settings.agent.hiddenModels),
};
const narratorIds: string[] = [];

afterEach(() => {
	saveSettings({
		...settings,
		customApiProviders: saved.customApiProviders,
		nugProviders: saved.nugProviders,
		openaiProviders: undefined,
		anthropicProviders: undefined,
		geminiProviders: undefined,
		agent: {
			...settings.agent,
			defaultModel: saved.defaultModel,
			hiddenModels: saved.hiddenModels,
		},
	});
	for (const id of narratorIds.splice(0)) db.delete(narrators).where(eq(narrators.id, id)).run();
});

describe("reserved auto prefix", () => {
	test("does nothing when no provider uses it", async () => {
		expect(await migrateReservedAutoPrefixOnStartup()).toEqual([]);
	});

	test("renames the provider and moves settings and narrator references", async () => {
		const others = (saved.customApiProviders ?? []).filter((p) => p.prefix !== "auto");
		saveSettings({
			...settings,
			customApiProviders: [
				...others,
				{
					id: "legacyAutoRelay",
					name: "Relay",
					prefix: "auto",
					apiKey: "",
					baseUrl: "https://relay.example/v1",
					defaultModel: "m",
					protocol: "completions-compatible",
				},
				{
					id: "takenAuto2",
					name: "Taken",
					prefix: "auto-2",
					apiKey: "",
					baseUrl: "https://other.example/v1",
					defaultModel: "m",
					protocol: "completions-compatible",
				},
			],
			openaiProviders: undefined,
			anthropicProviders: undefined,
			geminiProviders: undefined,
			agent: {
				...settings.agent,
				defaultModel: "auto:my-model",
				hiddenModels: ["auto:hidden-model"],
			},
		});
		const id = generateId();
		narratorIds.push(id);
		const now = new Date().toISOString();
		db.insert(narrators)
			.values({
				id,
				title: "uses legacy auto",
				cwd: "/tmp",
				model: "auto:my-model",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		// Before the rename the value is a plain provider value, not auto routing.
		expect(resolveEffectiveModel("auto:my-model")).toBe("auto:my-model");

		const changes = await migrateReservedAutoPrefixOnStartup();
		expect(changes).toEqual([{ id: "legacyAutoRelay", from: "auto", to: "auto-3" }]);
		expect(settings.customApiProviders?.find((p) => p.id === "legacyAutoRelay")?.prefix).toBe(
			"auto-3",
		);
		expect(settings.openaiProviders?.find((p) => p.id === "legacyAutoRelay")?.prefix).toBe(
			"auto-3",
		);
		expect(settings.agent.defaultModel).toBe("auto-3:my-model");
		expect(settings.agent.hiddenModels).toEqual(["auto-3:hidden-model"]);
		const row = db
			.select({ model: narrators.model })
			.from(narrators)
			.where(eq(narrators.id, id))
			.get();
		expect(row?.model).toBe("auto-3:my-model");
		expect(await migrateReservedAutoPrefixOnStartup()).toEqual([]);
	});
});
