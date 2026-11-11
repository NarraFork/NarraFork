import { afterAll, expect, mock, spyOn, test } from "bun:test";

// Finish the isolated test database's source-mode startup before simulating a
// compiled update service; this test never starts or replaces a real server.
await import("../../db");

mock.module("../../lib/runtime-target", () => ({
	IS_LOCAL_RUNTIME: true,
	RUNTIME_BUILD_ID: "local-runtime-test",
	isCompiledRuntime: () => true,
}));
mock.module("@server/generated/build-info", () => ({
	buildVersion: "0.0.0-local-test",
	buildCommit: "frozen",
}));

const { applyUpdate, downloadUpdate, getUpdateInstructions, getUpdateStatus } = await import(
	"../update-service"
);

afterAll(() => mock.restore());

test("local compiled builds cannot download or restart into a release binary", async () => {
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("self-update must not spawn in a local runtime");
	});
	const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("self-update must not fetch in a local runtime"),
	);
	try {
		// An otherwise incomplete request proves this guard runs before update source,
		// prepared-binary verification or scheduling can touch runtime files.
		await expect(downloadUpdate({} as Parameters<typeof downloadUpdate>[0])).resolves.toMatchObject(
			{
				success: false,
				error: expect.stringContaining("rebuilt from source"),
			},
		);
		await expect(applyUpdate()).resolves.toMatchObject({
			success: false,
			code: "NOT_COMPILED_BINARY",
			error: expect.stringContaining("rebuilt from source"),
		});
		expect(getUpdateInstructions("/ignored/release")).toEqual({
			manual: true,
			message: "Local runtime builds must be rebuilt from source, not self-updated",
		});
		const status = await getUpdateStatus();
		expect(status.canAutoRestart).toBe(false);
		expect(status.scheduled).toBe(false);
		expect(spawn).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
		fetch.mockRestore();
	}
});
