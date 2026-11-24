import { expect, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";

const credentials = seedUnifiedCredentials();
await import("./template-auto-routing.test");

test("template routing ran against credentials.json", () => {
	expect(credentials.written()).toBe(true);
});
