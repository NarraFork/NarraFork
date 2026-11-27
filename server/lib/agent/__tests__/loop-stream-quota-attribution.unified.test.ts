import { expect, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";

const credentials = seedUnifiedCredentials();
await import("./loop-stream-quota-attribution.test");

test("stream quota attribution ran against credentials.json", () => {
	expect(credentials.written()).toBe(true);
});
