import { afterEach, describe, expect, test } from "bun:test";
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
