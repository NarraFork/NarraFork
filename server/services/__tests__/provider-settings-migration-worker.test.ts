import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerHandle } from "@server/lib/worker-runtime/lifecycle";
import { TaskQueue } from "@server/lib/worker-runtime/queue";
import { providerSettingsContributionSchema } from "@shared/provider-settings";
import { settingRowId } from "../plugin-settings-store";
import { ProviderSettingsConfigPolicy } from "../provider-settings-config-policy";
import { openProviderSetting } from "../provider-settings-data";
import {
	closeProviderSettingsMigrations,
	prepareProviderSettingsMigration,
} from "../provider-settings-migration-client";

const oldHome = process.env.NARRAFORK_HOME;
let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "nf-settings-worker-"));
	process.env.NARRAFORK_HOME = home;
});
afterEach(() => {
	process.env.NARRAFORK_HOME = oldHome;
	rmSync(home, { recursive: true, force: true });
});
const context = {
	pluginId: "com.example.worker",
	installationId: "install-1",
	target: { kind: "custom-api" as const, id: "provider-1" },
	identityRevision: "identity-1",
	providerRoot: "https://fixture.invalid",
};
const declaration = providerSettingsContributionSchema.parse({
	id: "test",
	schemaVersion: 1,
	title: "Test",
	targetKinds: ["custom-api"],
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: { token: { type: "string", writeOnly: true } },
	},
});
const view = new ProviderSettingsConfigPolicy(declaration).view(context);
const request = {
	schemaVersion: 1,
	schemaFingerprint: view.schemaFingerprint,
	expectedRevision: 0,
	expectedBindingRevision: view.bindingRevision,
	values: {},
	secrets: { token: { operation: "set", value: "fictional-worker-token" } },
};
test("real migration worker prepares only bounded encrypted data", async () => {
	const mutation = await prepareProviderSettingsMigration(context, declaration, request);
	expect(JSON.stringify(mutation)).not.toContain("fictional-worker-token");
	const row = {
		...mutation.address,
		...mutation.value,
		id: settingRowId(mutation.address),
		revision: 1,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	expect(openProviderSetting(row).secrets.token).toBe("fictional-worker-token");
});
test("worker creation refusal never encrypts or creates a key inline", async () => {
	const create = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		throw Error("fixture worker disabled");
	});
	try {
		await expect(prepareProviderSettingsMigration(context, declaration, request)).rejects.toThrow();
		expect(existsSync(join(home, "secret.key"))).toBe(false);
	} finally {
		create.mockRestore();
	}
});
test("cancelled startup terminates its actual worker without an inline retry", async () => {
	const original = WorkerHandle.thread.bind(WorkerHandle);
	const handles: ReturnType<typeof WorkerHandle.thread>[] = [];
	const create = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		const handle = original("setInterval(()=>{},1000)", { eval: true });
		handles.push(handle);
		return handle;
	});
	try {
		await expect(
			prepareProviderSettingsMigration(context, declaration, request, AbortSignal.timeout(50)),
		).rejects.toThrow();
		expect(existsSync(join(home, "secret.key"))).toBe(false);
		expect(handles).toHaveLength(1);
		await expect(handles[0].exited).resolves.toBeNumber();
	} finally {
		create.mockRestore();
		for (const handle of handles) await handle.close();
	}
});

test.each([
	"crash",
	"timeout",
] as const)("worker %s after handshake never encrypts inline", async (failure) => {
	const original = WorkerHandle.thread.bind(WorkerHandle);
	const handles: ReturnType<typeof WorkerHandle.thread>[] = [];
	const sent: unknown[] = [];
	const create = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		const handle = original(
			`const { parentPort } = require('node:worker_threads');
parentPort.on('message', input => {
	if (input.action === 'ping') parentPort.postMessage({ ready: true });
	else if (${JSON.stringify(failure)} === 'crash') process.exit(7);
});`,
			{ eval: true },
		);
		handles.push(handle);
		const post = handle.resource.postMessage.bind(handle.resource);
		spyOn(handle.resource, "postMessage").mockImplementation((input) => {
			sent.push(input);
			post(input);
		});
		return handle;
	});
	const acquire = TaskQueue.prototype.acquire;
	const admit = spyOn(TaskQueue.prototype, "acquire").mockImplementation(function (
		this: TaskQueue,
		options,
	) {
		return acquire.call(this, { ...options, deadlineAt: Date.now() + 1000 });
	});
	try {
		await expect(prepareProviderSettingsMigration(context, declaration, request)).rejects.toThrow();
		expect(admit).toHaveBeenCalledTimes(1);
		expect(sent.some((input) => !!input && typeof input === "object" && "request" in input)).toBe(
			true,
		);
		expect(existsSync(join(home, "secret.key"))).toBe(false);
		expect(handles).toHaveLength(1);
		await expect(handles[0].exited).resolves.toBeNumber();
	} finally {
		admit.mockRestore();
		create.mockRestore();
		for (const handle of handles) await handle.close();
	}
});

test("shutdown cancels startup and queued migrations, then rejects new work", async () => {
	const original = WorkerHandle.thread.bind(WorkerHandle);
	const handles: ReturnType<typeof WorkerHandle.thread>[] = [];
	let started!: () => void;
	const startup = new Promise<void>((resolve) => {
		started = resolve;
	});
	const create = spyOn(WorkerHandle, "thread").mockImplementation(() => {
		const handle = original("setInterval(()=>{},1000)", { eval: true });
		handles.push(handle);
		started();
		return handle;
	});
	try {
		const pending = Array.from({ length: 3 }, () =>
			prepareProviderSettingsMigration(context, declaration, request),
		);
		const settled = Promise.allSettled(pending);
		await startup;
		await closeProviderSettingsMigrations();
		expect((await settled).every((result) => result.status === "rejected")).toBe(true);
		expect(handles).toHaveLength(1);
		await expect(handles[0].exited).resolves.toBeNumber();
		expect(existsSync(join(home, "secret.key"))).toBe(false);
		await expect(prepareProviderSettingsMigration(context, declaration, request)).rejects.toThrow();
	} finally {
		create.mockRestore();
		for (const handle of handles) await handle.close();
	}
});
