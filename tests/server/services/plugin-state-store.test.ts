import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerHandle } from "@server/lib/worker-runtime/lifecycle";
import { createPluginStateRecord, PluginStateStore } from "@server/services/plugin-state-store";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-state-"));
	tempRoots.push(root);
	return root;
}

function permissionBits(mode: number): number {
	return mode & 0o777;
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("PluginStateStore", () => {
	test("atomically persists state and journal with mode 0600", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore(root);
		const state = createPluginStateRecord("com.example.atomic");
		state.current = { version: "1.0.0", hash: "a".repeat(64) };
		state.compatibility = "compatible";
		await store.setState(state);
		const operation = await store.beginOperation({
			pluginId: state.pluginId,
			operation: "install",
			context: { to: state.current },
		});
		await store.updateOperation(operation.id, { status: "running" });
		await store.updateOperation(operation.id, { status: "succeeded" });

		expect(
			JSON.parse(await readFile(store.statePath, "utf8")).plugins[state.pluginId].current,
		).toEqual(state.current);
		expect(JSON.parse(await readFile(store.journalPath, "utf8")).operations[0].status).toBe(
			"succeeded",
		);
		if (process.platform !== "win32") {
			expect(permissionBits((await stat(store.statePath)).mode)).toBe(0o600);
			expect(permissionBits((await stat(store.journalPath)).mode)).toBe(0o600);
		}
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("importing state storage in a Worker does not register a package protocol listener", async () => {
		const moduleUrl = new URL("../../../server/services/plugin-state-store.ts", import.meta.url)
			.href;
		const handle = WorkerHandle.thread(
			`const { parentPort } = require("node:worker_threads");
			(async () => {
				const before = parentPort.listenerCount("message");
				await import(${JSON.stringify(moduleUrl)});
				parentPort.postMessage({ before, after: parentPort.listenerCount("message") });
				parentPort.close();
			})().catch(error => { throw error; });`,
			{ eval: true },
		);
		try {
			const [result] = await once(handle.resource, "message");
			expect(result).toEqual({ before: 0, after: 0 });
			expect(await handle.exited).toBe(0);
			await handle.close();
		} finally {
			await handle.close();
		}
	}, 10_000);

	test("applies the object-key budget independently to bundled bootstrap entries", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore({ root, limits: { maxObjectKeys: 8 } });
		for (let index = 0; index < 12; index++) {
			await store.setBundledBootstrap(`com.example.budget-${index}`, {
				status: "removed",
				version: "1.0.0",
				archiveSha256: null,
				defaultChoice: "revoked",
				inheritedFrom: "com.example.legacy",
			});
		}
		const restored = new PluginStateStore({ root, limits: { maxObjectKeys: 8 } });
		expect((await restored.getBundledBootstrap("com.example.budget-11"))?.defaultChoice).toBe(
			"revoked",
		);
		expect(
			(await restored.getDiagnostics()).some((item) => item.code === "PLUGIN_STATE_CORRUPT"),
		).toBe(false);
		const document = JSON.parse(await readFile(store.statePath, "utf8"));
		document.bundledBootstrap["com.example.budget-0"].oversized = Object.fromEntries(
			Array.from({ length: 9 }, (_, index) => [`key-${index}`, index]),
		);
		await writeFile(store.statePath, JSON.stringify(document));
		const corrupt = new PluginStateStore({ root, limits: { maxObjectKeys: 8 } });
		expect(
			(await corrupt.getDiagnostics()).some((item) => item.code === "PLUGIN_STATE_CORRUPT"),
		).toBe(true);
	});

	test("keeps writing a journal whose operations together exceed one value's key budget", async () => {
		/*
		 * Regression: the object-key budget bounds ONE value, but a journal is a container of
		 * unrelated operations. Counting them cumulatively made a healthy journal unwritable
		 * once enough ordinary operations had been recorded — well below `maxOperations` — and
		 * every later plugin operation failed with "Plugin metadata contains too many object
		 * keys". The budget below is sized so that one operation fits comfortably while a
		 * dozen of them do not.
		 */
		const root = await makeTempRoot();
		const store = new PluginStateStore({ root, limits: { maxObjectKeys: 60 } });
		const pluginId = "com.example.journal-budget";
		await store.setState(createPluginStateRecord(pluginId));
		for (let index = 0; index < 12; index += 1) {
			const operation = await store.beginOperation({
				pluginId,
				operation: "install",
				context: { to: { version: "1.0.0", hash: "d".repeat(64) } },
			});
			await store.updateOperation(operation.id, { status: "succeeded" });
		}

		const journal = JSON.parse(await readFile(store.journalPath, "utf8"));
		expect(journal.operations).toHaveLength(12);
	});

	test("migrates legacy package-hash authority identities on read", async () => {
		const root = await makeTempRoot();
		await mkdir(root, { recursive: true });
		const pluginId = "com.example.legacy-authority";
		const legacy = createPluginStateRecord(pluginId);
		legacy.current = { version: "1.0.0", hash: "b".repeat(64) };
		const rawLegacy = structuredClone(legacy) as unknown as Record<string, unknown>;
		delete rawLegacy.authorityInstallationId;
		await writeFile(
			join(root, "state.json"),
			JSON.stringify({
				version: 1,
				plugins: { [pluginId]: rawLegacy },
				diagnostics: [],
				updatedAt: legacy.updatedAt,
			}),
		);

		const store = new PluginStateStore(root);
		expect((await store.getState(pluginId))?.authorityInstallationId).toBe(legacy.current.hash);
	});

	test("keeps the previous document when an atomic rename fails", async () => {
		const root = await makeTempRoot();
		const initial = new PluginStateStore(root);
		await initial.updateState("com.example.atomic", { desiredState: "disabled" });
		const before = await readFile(initial.statePath, "utf8");
		const failing = new PluginStateStore({
			root,
			renameFile: async () => {
				throw new Error("simulated atomic rename failure");
			},
		});

		await expect(
			failing.updateState("com.example.atomic", { desiredState: "enabled" }),
		).rejects.toThrow("simulated atomic rename failure");
		expect(await readFile(initial.statePath, "utf8")).toBe(before);
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("does not reuse a failed state or journal candidate on the next write", async () => {
		const root = await makeTempRoot();
		let failNextRename = false;
		const store = new PluginStateStore({
			root,
			renameFile: async (from, to) => {
				if (failNextRename) {
					failNextRename = false;
					throw new Error("simulated one-shot rename failure");
				}
				await rename(from, to);
			},
		});
		await store.updateState("com.example.cow", { desiredState: "disabled" });
		failNextRename = true;
		await expect(store.updateState("com.example.cow", { desiredState: "enabled" })).rejects.toThrow(
			"simulated one-shot rename failure",
		);
		await store.updateState("com.example.cow", { compatibility: "compatible" });
		expect((await store.getState("com.example.cow"))?.desiredState).toBe("disabled");
		expect((await store.getState("com.example.cow"))?.compatibility).toBe("compatible");
		const reloaded = new PluginStateStore(root);
		expect((await reloaded.getState("com.example.cow"))?.desiredState).toBe("disabled");

		const operation = await store.beginOperation({
			pluginId: "com.example.cow",
			operation: "upgrade",
		});
		failNextRename = true;
		await expect(store.updateOperation(operation.id, { status: "running" })).rejects.toThrow(
			"simulated one-shot rename failure",
		);
		await store.updateOperation(operation.id, { context: { phase: "retry" } });
		expect((await store.getOperation(operation.id))?.status).toBe("pending");
		expect((await store.getOperation(operation.id))?.context.phase).toBe("retry");
		expect((await new PluginStateStore(root).getOperation(operation.id))?.status).toBe("pending");
	});

	test("recovers corrupt files fail-closed and preserves raw diagnostics", async () => {
		const root = await makeTempRoot();
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "state.json"), "{not-json", { mode: 0o644 });
		await writeFile(
			join(root, "journal.json"),
			JSON.stringify({ version: 999, operations: [], diagnostics: [], updatedAt: "bad" }),
			{ mode: 0o644 },
		);
		const store = new PluginStateStore(root);
		const snapshot = await store.initialize();

		expect(snapshot.states).toEqual([]);
		expect(snapshot.operations).toEqual([]);
		expect(snapshot.diagnostics.map((item) => item.code).sort()).toEqual([
			"PLUGIN_JOURNAL_CORRUPT",
			"PLUGIN_STATE_CORRUPT",
		]);
		const files = await readdir(root);
		expect(files.some((name) => name.startsWith("state.json.corrupt-"))).toBe(true);
		expect(files.some((name) => name.startsWith("journal.json.corrupt-"))).toBe(true);
		expect(JSON.parse(await readFile(store.statePath, "utf8")).plugins).toEqual({});
		expect(JSON.parse(await readFile(store.journalPath, "utf8")).operations).toEqual([]);
		if (process.platform !== "win32") {
			expect(permissionBits((await stat(store.statePath)).mode)).toBe(0o600);
			expect(permissionBits((await stat(store.journalPath)).mode)).toBe(0o600);
		}
	});

	test("serializes concurrent plugin updates without losing records", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore(root);
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.updateState(`com.example.concurrent${index}`, {
					desiredState: index % 2 === 0 ? "enabled" : "disabled",
				}),
			),
		);

		expect(await store.listStates()).toHaveLength(20);
		const reloaded = new PluginStateStore(root);
		expect(await reloaded.listStates()).toHaveLength(20);
	});

	test("supports every lifecycle operation and terminal journal status", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore(root);
		const operations = [
			"install",
			"enable",
			"disable",
			"activate",
			"deactivate",
			"upgrade",
			"rollback",
			"uninstall",
		] as const;
		for (const [index, operation] of operations.entries()) {
			const entry = await store.beginOperation({
				pluginId: "com.example.journal",
				operation,
			});
			await store.updateOperation(entry.id, { status: "running" });
			await store.updateOperation(entry.id, {
				status: index === operations.length - 1 ? "rolled_back" : "succeeded",
			});
		}

		const journal = await store.listOperations("com.example.journal");
		expect(journal.map((entry) => entry.operation)).toEqual([...operations]);
		expect(journal.every((entry) => entry.completedAt !== undefined)).toBe(true);
		expect(journal.at(-1)?.status).toBe("rolled_back");
	});

	test("enforces file and JSON string limits before replacing durable data", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore({
			root,
			limits: { maxStateBytes: 2_048, maxStringBytes: 32 },
		});
		await store.updateState("com.example.limits", { desiredState: "disabled" });
		const before = await readFile(store.statePath, "utf8");

		await expect(
			store.updateState("com.example.limits", {
				grants: {
					count: 1,
					capabilities: [`capability.${"x".repeat(64)}`],
					revision: 1,
				},
			}),
		).rejects.toThrow(/oversized string|size limit/i);
		expect(await readFile(store.statePath, "utf8")).toBe(before);

		if (process.platform !== "win32") {
			await chmod(store.statePath, 0o644);
			await new PluginStateStore(root).initialize();
			expect(permissionBits((await stat(store.statePath)).mode)).toBe(0o600);
		}
	});
});

describe("bundled plugin bootstrap ledger", () => {
	test("loads old files and preserves default-install history after removing installed state", async () => {
		const root = await makeTempRoot();
		const pluginId = "io.narrafork.provider-quota";
		const state = createPluginStateRecord(pluginId);
		await writeFile(
			join(root, "state.json"),
			JSON.stringify({
				version: 1,
				plugins: { [pluginId]: state },
				diagnostics: [],
				updatedAt: state.updatedAt,
			}),
		);
		const store = new PluginStateStore(root);
		expect(await store.getBundledBootstrap(pluginId)).toBeUndefined();
		const record = await store.setBundledBootstrap(pluginId, {
			status: "seeded",
			version: "1.0.1",
			archiveSha256: "c".repeat(64),
		});
		expect(await store.removeState(pluginId)).toBe(true);
		await store.replaceStates([]);
		const reloaded = new PluginStateStore(root);
		expect(await reloaded.getBundledBootstrap(pluginId)).toEqual(record);
		expect(await reloaded.listStates()).toEqual([]);
		record.status = "removed";
		expect((await reloaded.getBundledBootstrap(pluginId))?.status).toBe("seeded");
	});

	test("failed atomic ledger writes do not leak a candidate into durable or cached state", async () => {
		const root = await makeTempRoot();
		const initial = new PluginStateStore(root);
		await initial.replaceStates([]);
		const before = await readFile(initial.statePath, "utf8");
		const failing = new PluginStateStore({
			root,
			renameFile: async () => {
				throw new Error("ledger rename failed");
			},
		});
		await expect(
			failing.setBundledBootstrap("com.example.bundle", {
				status: "initializing",
				version: "1.0.1",
				archiveSha256: "d".repeat(64),
			}),
		).rejects.toThrow("ledger rename failed");
		expect(await readFile(initial.statePath, "utf8")).toBe(before);
		expect(await failing.getBundledBootstrap("com.example.bundle")).toBeUndefined();
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("corrupt bootstrap metadata is recovered fail-closed with durable diagnostics", async () => {
		for (const bad of [
			{ status: "retry-forever", version: "1.0.1", archiveSha256: null },
			{ status: "seeded", version: "../escape", archiveSha256: null },
			{ status: "removed", version: "1.0.1", archiveSha256: "not-a-hash" },
		]) {
			const root = await makeTempRoot();
			const updatedAt = new Date().toISOString();
			await writeFile(
				join(root, "state.json"),
				JSON.stringify({
					version: 1,
					plugins: {},
					diagnostics: [],
					updatedAt,
					bundledBootstrap: { "com.example.bundle": { ...bad, updatedAt } },
				}),
			);
			const store = new PluginStateStore(root);
			expect(await store.getBundledBootstrap("com.example.bundle")).toBeUndefined();
			expect(
				(await store.getDiagnostics()).some((item) => item.code === "PLUGIN_STATE_CORRUPT"),
			).toBe(true);
		}
	});

	test("retired default choices and replacement refusal provenance survive state removal", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore(root);
		const legacyId = "com.narrafork.apikey-quota";
		const replacementId = "io.narrafork.provider-quota";
		await store.updateState(legacyId, { desiredState: "enabled" });
		const legacy = await store.setBundledBootstrap(legacyId, {
			status: "adopted",
			version: "1.0.0",
			archiveSha256: null,
			defaultChoice: "enabled",
		});
		const refusal = await store.setBundledBootstrap(replacementId, {
			status: "removed",
			version: "1.0.2",
			archiveSha256: null,
			defaultChoice: "revoked",
			inheritedFrom: legacyId,
		});
		await store.removeState(legacyId);
		await store.replaceStates([]);
		const reloaded = new PluginStateStore(root);
		expect(await reloaded.getBundledBootstrap(legacyId)).toEqual(legacy);
		expect(await reloaded.getBundledBootstrap(replacementId)).toEqual(refusal);
		refusal.defaultChoice = "disabled";
		expect((await reloaded.getBundledBootstrap(replacementId))?.defaultChoice).toBe("revoked");
	});

	test("inherited enabled grants and invalid choice provenance cannot be persisted", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore(root);
		for (const invalid of [
			{ status: "removed", defaultChoice: "enabled", inheritedFrom: "com.narrafork.apikey-quota" },
			{ status: "seeded", defaultChoice: "disabled", inheritedFrom: "com.narrafork.apikey-quota" },
			{ status: "removed", defaultChoice: "disabled", inheritedFrom: "../escape" },
			{ status: "removed", defaultChoice: "automatic-retry" },
		] as const) {
			await expect(
				store.setBundledBootstrap("io.narrafork.provider-quota", {
					version: "1.0.2",
					archiveSha256: null,
					...invalid,
				} as Parameters<PluginStateStore["setBundledBootstrap"]>[1]),
			).rejects.toThrow("bootstrap record is invalid");
		}
		expect(await store.getBundledBootstrap("io.narrafork.provider-quota")).toBeUndefined();
	});

	test("optional source bindings round-trip without changing legacy lifecycle or config fields", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore(root);
		const pluginId = "com.example.source-binding";
		const state = createPluginStateRecord(pluginId);
		state.desiredState = "enabled";
		await store.upsert(state);
		expect((await new PluginStateStore(root).getState(pluginId))?.sourceBinding).toBeUndefined();
		const sourceBinding = {
			revision: 2,
			mode: "configured" as const,
			source: {
				type: "github" as const,
				owner: "owner",
				repo: "repo",
				assetName: "plugin-{version}.nfplugin",
			},
			autoUpdate: true,
		};
		await store.updateState(pluginId, {
			sourceBinding,
			providerConfigs: { relay: { value: "saved" } },
		});
		const persisted = await new PluginStateStore(root).getState(pluginId);
		expect(persisted?.desiredState).toBe("enabled");
		expect(persisted?.sourceBinding).toEqual(sourceBinding);
		expect(persisted?.providerConfigs).toEqual({ relay: { value: "saved" } });
		expect(JSON.parse(await readFile(store.statePath, "utf8")).version).toBe(1);
	});

	test("a damaged optional source disables updates only, without recovering healthy state as corrupt", async () => {
		for (const binding of [
			{
				revision: 4,
				mode: "configured",
				source: { type: "website", updateApi: "javascript:bad" },
				autoUpdate: true,
			},
			{ revision: 4, mode: "configured", source: null, autoUpdate: true },
			{
				revision: 4,
				mode: "none",
				source: { type: "local", builtinId: "com.example.source" },
				autoUpdate: false,
			},
		]) {
			const root = await makeTempRoot();
			const pluginId = "com.example.source";
			const state = {
				...createPluginStateRecord(pluginId),
				desiredState: "enabled",
				sourceBinding: binding,
				providerConfigs: { relay: { value: "saved" } },
			};
			await writeFile(
				join(root, "state.json"),
				JSON.stringify({
					version: 1,
					plugins: { [pluginId]: state },
					diagnostics: [],
					updatedAt: state.updatedAt,
				}),
			);
			const store = new PluginStateStore(root);
			const restored = await store.getState(pluginId);
			expect(restored?.desiredState).toBe("enabled");
			expect(restored?.providerConfigs).toEqual(state.providerConfigs);
			expect(restored?.sourceBinding).toEqual({
				revision: 4,
				mode: "none",
				source: null,
				autoUpdate: false,
			});
			expect(
				(await store.getDiagnostics()).some((item) => item.code === "PLUGIN_STATE_CORRUPT"),
			).toBe(false);
		}
	});

	test("bounds the ledger and permits updating an existing entry at capacity", async () => {
		const root = await makeTempRoot();
		const store = new PluginStateStore(root);
		for (let index = 0; index < 64; index++) {
			await store.setBundledBootstrap(`com.example.bundle-${index}`, {
				status: "adopted",
				version: "1.0.1",
				archiveSha256: null,
			});
		}
		await expect(
			store.setBundledBootstrap("com.example.too-many", {
				status: "seeded",
				version: "1.0.1",
				archiveSha256: null,
			}),
		).rejects.toThrow("bootstrap count exceeds the limit");
		await store.setBundledBootstrap("com.example.bundle-0", {
			status: "removed",
			version: "1.0.1",
			archiveSha256: null,
		});
		expect(
			(await new PluginStateStore(root).getBundledBootstrap("com.example.bundle-0"))?.status,
		).toBe("removed");
	}, 15_000);
});
