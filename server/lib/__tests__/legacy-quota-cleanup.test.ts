import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-legacy-quota-cleanup-"));
process.env.NARRAFORK_HOME = testHome;
writeFileSync(join(testHome, "nug-quotas.json"), JSON.stringify({ old: { balance: 1 } }));
writeFileSync(
	join(testHome, "custom-api-quotas.json"),
	JSON.stringify({ old: { quotaBalance: "1", fetchedAt: 1 } }),
);

await import("../nug-quota-cache");
await import("../custom-api-quota-cache");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

test("plaintext NUG and response-quota caches are discarded on startup", async () => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (
			!existsSync(join(testHome, "nug-quotas.json")) &&
			!existsSync(join(testHome, "custom-api-quotas.json"))
		) {
			break;
		}
		await Bun.sleep(1);
	}
	expect(existsSync(join(testHome, "nug-quotas.json"))).toBe(false);
	expect(existsSync(join(testHome, "custom-api-quotas.json"))).toBe(false);
});
