import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { DEFAULT_REMOTE_ACCESS } from "../../lib/remote-access-config";
import * as distribution from "../../lib/remote-peer-binaries";
import { saveSettings, settings } from "../../lib/settings";
import { RemoteAccessRuntime } from "../remote-access-runtime";
import { createProductionRemoteBackendHarness } from "./remote-access-harness";

let stop: (() => Promise<void>) | undefined;
let backend: ReturnType<typeof createProductionRemoteBackendHarness> | undefined;
afterEach(async () => {
	await stop?.();
	stop = undefined;
	await backend?.stop();
	backend = undefined;
});
async function until(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Runtime did not converge");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("default-off startup and enabled-but-uninstalled startup never download or launch", async () => {
	backend = createProductionRemoteBackendHarness();
	const installed = spyOn(distribution, "getInstalledRemotePeerBinary").mockResolvedValue(null);
	const install = spyOn(distribution, "ensureRemotePeerBinary").mockRejectedValue(
		new Error("Unexpected download"),
	);
	const spawn = spyOn(Bun, "spawn");
	try {
		settings.remoteAccess = { ...DEFAULT_REMOTE_ACCESS };
		const runtime = new RemoteAccessRuntime();
		stop = runtime.attach({
			dispatch: backend.dispatch,
			lifecycle: backend.lifecycle,
			readiness: backend.readiness,
		});
		await until(async () => (await runtime.status()).state === "disabled");
		expect(spawn).not.toHaveBeenCalled();
		expect(install).not.toHaveBeenCalled();
		saveSettings({
			...structuredClone(settings),
			remoteAccess: {
				...DEFAULT_REMOTE_ACCESS,
				enabled: true,
				signalUrl: "wss://ipc.fixture/normal",
			},
		});
		await until(async () => (await runtime.status()).state === "needs-install");
		expect(spawn).not.toHaveBeenCalled();
		expect(install).not.toHaveBeenCalled();
		await stop();
		stop = undefined;
	} finally {
		installed.mockRestore();
		install.mockRestore();
		spawn.mockRestore();
	}
});

test("persisted config changes wait for the old child lock to disappear before new epoch", async () => {
	backend = createProductionRemoteBackendHarness();
	await mkdir(getNarraforkPath("remote-access"), { mode: 0o700 });
	const installed = spyOn(distribution, "getInstalledRemotePeerBinary").mockResolvedValue({
		path: "runtime-ipc-fixture",
		filename: "fixture",
		version: "0.2.0-alpha.1",
		protocolVersion: 2,
		platform: "linux-amd64",
		size: 1,
		sha256: "a".repeat(64),
	});
	const realSpawn = Bun.spawn.bind(Bun);
	let launches = 0;
	const spawn = spyOn(Bun, "spawn").mockImplementation(((
		command: string[],
		options: Record<string, unknown>,
	) => {
		if (command[0] !== "runtime-ipc-fixture") throw new Error("Unexpected child");
		launches++;
		return realSpawn(
			[process.execPath, join(import.meta.dir, "remote-peer-ipc-child.fixture.ts")],
			options,
		);
	}) as typeof Bun.spawn);
	try {
		settings.remoteAccess = {
			...DEFAULT_REMOTE_ACCESS,
			enabled: true,
			signalUrl: "wss://ipc.fixture/normal",
		};
		const runtime = new RemoteAccessRuntime();
		stop = runtime.attach({
			dispatch: backend.dispatch,
			lifecycle: backend.lifecycle,
			readiness: backend.readiness,
		});
		await until(async () => (await runtime.status()).state === "ready");
		expect(launches).toBe(1);
		saveSettings({
			...structuredClone(settings),
			remoteAccess: { ...settings.remoteAccess, leaseSeconds: 301 },
		});
		await until(async () => launches === 2 && (await runtime.status()).state === "ready");
		expect((await runtime.status()).lastError).toBeNull();
		saveSettings({
			...structuredClone(settings),
			remoteAccess: { ...settings.remoteAccess, enabled: false },
		});
		await stop();
		stop = undefined;
		expect(launches).toBe(2);
		expect((await runtime.status()).state).toBe("disabled");
	} finally {
		installed.mockRestore();
		spawn.mockRestore();
	}
});
