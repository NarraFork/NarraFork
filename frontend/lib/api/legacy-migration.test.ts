import { beforeEach, expect, mock, test } from "bun:test";

const request = mock(async (_path: string, _options?: RequestInit) => ({}));
mock.module("./client", () => ({ request }));
const { legacyMigrationApi } = await import("./legacy-migration");
beforeEach(() => request.mockClear());
test("preview is read-only and uses the dedicated migration route", async () => {
	await legacyMigrationApi.preview("p/a");
	expect(request).toHaveBeenCalledWith("/projects/p%2Fa/legacy-migration/preview");
});
test("chapter mapping uses the independently authorized read-only target route", async () => {
	await legacyMigrationApi.chapterTarget("c/a");
	expect(request).toHaveBeenCalledWith("/legacy-chapters/c%2Fa/target");
});
test("sync disable is an independent explicit POST", async () => {
	await legacyMigrationApi.disableSync("p");
	expect(request).toHaveBeenCalledWith("/projects/p/legacy-sync/disable", { method: "POST" });
});
test("migration submits revision and explicit confirmation, never the project delete API", async () => {
	await legacyMigrationApi.migrate("p", "rev");
	expect(request).toHaveBeenCalledWith("/projects/p/legacy-migration", {
		method: "POST",
		body: JSON.stringify({ revision: "rev", confirm: true }),
	});
});
