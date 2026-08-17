/**
 * useNarratorLod.migration.test.ts — the stored-level scale migration (v1 → v2).
 *
 * v1 was a 1..6 scale whose L3 folded a completed tool batch into a "tool calls ×N"
 * summary block. That level was removed (it read as neither folded nor detailed), so
 * v2 is 1..5. Stored levels must therefore be REWRITTEN, not reinterpreted: a stored
 * `3` means the removed summary level under v1 and "all cards collapsed to headers"
 * under v2, so nothing in the value itself says which scale it belongs to.
 *
 * The schema marker is that record, and these tests pin both halves: the mapping,
 * and the fact that it runs exactly once (a second read must not shift the values
 * again, which would walk every narrator's level down to L1 over time).
 *
 * Asserted through `readOpeningLod` — the hook's own (and only) entry into the
 * migration — so no React tree is needed.
 */

import { afterEach, describe, expect, it } from "bun:test";

const DEFAULT_KEY = "narrafork_lod_default";
const SCHEMA_KEY = "narrafork_lod_schema";
const narratorKey = (id: string) => `narrafork_lod:${id}`;

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** Install a fresh in-memory localStorage, returning the backing store. */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
	const store = new Map<string, string>(Object.entries(seed));
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
			clear: () => store.clear(),
			key: (index: number) => [...store.keys()][index] ?? null,
			get length() {
				return store.size;
			},
		},
	});
	return store;
}

afterEach(() => {
	if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
	else Reflect.deleteProperty(globalThis as object, "localStorage");
});

describe("stored LOD migration (v1 1..6 → v2 1..5)", () => {
	it("maps a v1 level onto the v2 scale by SHAPE, not by number", async () => {
		const { migrateStoredLodV1 } = await import("./useNarratorLod");
		// 6 (all expanded) → 5, 5 (recent expanded) → 4, 4 (all headers) → 3.
		expect(migrateStoredLodV1(6)).toBe(5);
		expect(migrateStoredLodV1(5)).toBe(4);
		expect(migrateStoredLodV1(4)).toBe(3);
		// The removed summary level has no v2 counterpart; "all headers" is its
		// nearest survivor, so it lands on the same 3 the old L4 does.
		expect(migrateStoredLodV1(3)).toBe(3);
		// The merged activity fold is unchanged, so its two levels keep their numbers.
		expect(migrateStoredLodV1(2)).toBe(2);
		expect(migrateStoredLodV1(1)).toBe(1);
	});

	it("rewrites every stored level once and records the schema", async () => {
		const store = installStorage({
			[DEFAULT_KEY]: "6",
			[narratorKey("n-a")]: "5",
			[narratorKey("n-b")]: "3",
			[narratorKey("n-c")]: "1",
			// An unrelated key must be left completely alone.
			narrafork_oled: "true",
		});
		const { readOpeningLod } = await import("./useNarratorLod");

		expect(readOpeningLod("n-a")).toBe(4);

		expect(store.get(DEFAULT_KEY)).toBe("5");
		expect(store.get(narratorKey("n-a"))).toBe("4");
		expect(store.get(narratorKey("n-b"))).toBe("3");
		expect(store.get(narratorKey("n-c"))).toBe("1");
		expect(store.get("narrafork_oled")).toBe("true");
		expect(store.get(SCHEMA_KEY)).toBe("2");
	});

	it("does not migrate twice (a second read must not shift the values again)", async () => {
		const store = installStorage({ [narratorKey("n-a")]: "6" });
		const { readOpeningLod } = await import("./useNarratorLod");
		expect(readOpeningLod("n-a")).toBe(5);
		expect(readOpeningLod("n-a")).toBe(5);
		expect(store.get(narratorKey("n-a"))).toBe("5");
	});

	it("leaves an already-migrated store untouched", async () => {
		const store = installStorage({
			[SCHEMA_KEY]: "2",
			[narratorKey("n-a")]: "5",
			[DEFAULT_KEY]: "3",
		});
		const { readOpeningLod } = await import("./useNarratorLod");
		expect(readOpeningLod("n-a")).toBe(5);
		expect(store.get(narratorKey("n-a"))).toBe("5");
		expect(store.get(DEFAULT_KEY)).toBe("3");
	});

	it("falls back to the global default, then to DEFAULT_RENDER_LOD", async () => {
		const { readOpeningLod } = await import("./useNarratorLod");
		const { DEFAULT_RENDER_LOD } = await import("../components/narrator/RenderLodCtx");

		// A narrator with no memory of its own opens at the (migrated) global default.
		installStorage({ [DEFAULT_KEY]: "6" });
		expect(readOpeningLod("unknown")).toBe(5);

		// Nothing stored at all → the built-in default.
		installStorage();
		expect(readOpeningLod("unknown")).toBe(DEFAULT_RENDER_LOD);

		// Unparseable values are ignored rather than clamped to a level.
		installStorage({ [SCHEMA_KEY]: "2", [narratorKey("n-x")]: "not-a-level" });
		expect(readOpeningLod("n-x")).toBe(DEFAULT_RENDER_LOD);
	});

	it("clamps a stored value that lies outside the new scale", async () => {
		installStorage({ [SCHEMA_KEY]: "2", [narratorKey("n-a")]: "9" });
		const { readOpeningLod } = await import("./useNarratorLod");
		expect(readOpeningLod("n-a")).toBe(5);
	});
});
