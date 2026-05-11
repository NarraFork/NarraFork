import { afterEach, describe, expect, test } from "bun:test";
import {
	clearAliasRegistry,
	registerAndPersistSubagentAlias,
	setSubagentAliasPersistenceAdapterForTests,
} from "../subagent-alias";

const PARENT_ID = "parent-test";

afterEach(() => {
	clearAliasRegistry(PARENT_ID);
	setSubagentAliasPersistenceAdapterForTests();
});

describe("registerAndPersistSubagentAlias", () => {
	test("serializes concurrent registrations within the same parent narrator", async () => {
		const persistedAliases = new Map<string, string>();
		let inFlightReads = 0;
		let maxInFlightReads = 0;

		setSubagentAliasPersistenceAdapterForTests({
			async getTakenAliases(_parentNarratorId, excludeSubagentId) {
				inFlightReads++;
				maxInFlightReads = Math.max(maxInFlightReads, inFlightReads);
				await new Promise((resolve) => setTimeout(resolve, 5));

				const taken = new Set<string>();
				for (const [subagentId, alias] of persistedAliases) {
					if (subagentId !== excludeSubagentId) taken.add(alias);
				}
				inFlightReads--;
				return taken;
			},
			async persistAlias(_parentNarratorId, subagentId, alias) {
				persistedAliases.set(subagentId, alias);
			},
		});

		const [first, second] = await Promise.all([
			registerAndPersistSubagentAlias(PARENT_ID, "subagent-a", "shared alias"),
			registerAndPersistSubagentAlias(PARENT_ID, "subagent-b", "shared alias"),
		]);

		expect(first).toEqual({ alias: "shared-alias", conflicted: false });
		expect(second).toEqual({ alias: "shared-alias-2", conflicted: true });
		expect([...persistedAliases.values()].sort()).toEqual(["shared-alias", "shared-alias-2"]);
		expect(maxInFlightReads).toBe(1);
	});
});
