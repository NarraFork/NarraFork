import { expect, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";

// Execute the same real resolver/factory cases on a migrated credential store.
const credentials = seedUnifiedCredentials();
await import("./source-key-pools.test");

test("source key pools wrote credentials.json", () => {
	expect(credentials.written()).toBe(true);
});
