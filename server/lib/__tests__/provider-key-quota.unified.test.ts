import { expect, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";

// The same cases on an instance whose model keys live in credentials.json.
const credentials = seedUnifiedCredentials();
await import("./provider-key-quota.test");

test("ran against credentials.json", () => {
	expect(credentials.written()).toBe(true);
});
