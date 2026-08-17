import { afterEach, describe, expect, test } from "bun:test";
import {
	clearAliasRegistry,
	registerAndPersistSubagentAlias,
	registerTaskAlias,
	setSubagentAliasPersistenceAdapterForTests,
} from "../subagent-alias";

const PARENT_ID = "parent-test";
const NANOID = "UscgG1vLFnxzyKyaUOIfR";

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

// The alias is what every Await/Send/notification now prints, so an alias derived
// from the id itself would put the full nanoid straight back into the prompt. Two
// callers do exactly that: recovery passes `title || subagentId`, and the runner
// passes `alias || title` (both undefined for an untitled subagent).
describe("alias fallback for an unnamed subagent", () => {
	test("registerTaskAlias shortens instead of slugifying the whole id", () => {
		const { alias } = registerTaskAlias(PARENT_ID, NANOID);
		expect(alias).toBe("UscgG1vL");
		// The old behaviour lowercased the whole id, which no longer even matched it.
		expect(alias).not.toBe(NANOID.toLowerCase());
		// Still a usable selector: subagentMatchesSelector accepts an id prefix.
		expect(NANOID.startsWith(alias)).toBe(true);
	});

	test("a desiredAlias equal to the id counts as no name given", () => {
		// Recovery's `title || subagentId` lands here whenever the subagent is untitled.
		const { alias } = registerTaskAlias(PARENT_ID, NANOID, NANOID);
		expect(alias).toBe("UscgG1vL");
	});

	test("a real name still wins over the short id", () => {
		const { alias } = registerTaskAlias(PARENT_ID, NANOID, "Map The Providers");
		expect(alias).toBe("map-the-providers");
	});

	test("persisting an unnamed subagent also avoids the full id", async () => {
		setSubagentAliasPersistenceAdapterForTests({
			async getTakenAliases() {
				return new Set<string>();
			},
			async persistAlias() {},
		});
		const { alias } = await registerAndPersistSubagentAlias(PARENT_ID, NANOID, NANOID);
		expect(alias).toBe("UscgG1vL");
	});
});

describe("alias suffixing terminates", () => {
	test("a persistence adapter that claims everything is taken cannot hang the loop", async () => {
		// The suffix search used to be an unbounded `while (isTaken(alias))`. An adapter
		// answering true for every candidate — a bug, or a corrupt taken-set — would
		// spin the main thread forever instead of degrading to an id-based alias.
		setSubagentAliasPersistenceAdapterForTests({
			async getTakenAliases() {
				return {
					has: () => true,
					// The real return type is a Set; only `has` is consulted.
				} as unknown as Set<string>;
			},
			async persistAlias() {},
		});

		const { alias, conflicted } = await registerAndPersistSubagentAlias(
			PARENT_ID,
			NANOID,
			"map the providers",
		);

		expect(conflicted).toBe(true);
		// Degrades to base + short real id, which is unique by construction.
		expect(alias).toBe(`map-the-providers-${NANOID.slice(0, 8)}`);
		// Never an unbounded counter value.
		expect(alias).not.toMatch(/-\d+$/);
	});

	test("in-memory registration degrades the same way", () => {
		// Saturate the base name and every suffix the loop would try, using real
		// registrations so this exercises the same taken-set the production path reads.
		for (let i = 0; i <= 1000; i++) registerTaskAlias(PARENT_ID, `other-${i}`, "busy");

		const { alias, conflicted } = registerTaskAlias(PARENT_ID, NANOID, "busy");
		expect(conflicted).toBe(true);
		expect(alias).toBe(`busy-${NANOID.slice(0, 8)}`);
	});
});
