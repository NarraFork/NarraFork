import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingRowId } from "../services/plugin-settings-store";
import { buildSnapshotInSubprocess, closeSnapshotBuilds } from "./snapshot-build";
import {
	PROVIDER_SETTINGS_TRANSFER_LIMITS,
	type ProviderSettingsTransferTarget,
	SNAPSHOT_TABLES,
} from "./snapshot-protocol";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

const input = {
	sourcePath: "/source.sqlite",
	outputPath: "/snapshot.sqlite",
	requests: true,
	sessions: true,
};

async function providerSource(targets: ProviderSettingsTransferTarget[], configText = "") {
	const root = await mkdtemp(join(tmpdir(), "nf-provider-snapshot-"));
	paths.push(root);
	const sourcePath = join(root, "source.sqlite"),
		outputPath = join(root, "snapshot.sqlite");
	const source = new Database(sourcePath);
	try {
		for (const table of [...SNAPSHOT_TABLES.requests, ...SNAPSHOT_TABLES.sessions])
			source.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
		source.run(`CREATE TABLE plugin_provider_settings (
			id TEXT PRIMARY KEY,plugin_id TEXT,contribution_id TEXT,target_kind TEXT,target_id TEXT,
			installation_id TEXT,state TEXT,schema_version INTEGER,schema_fingerprint TEXT,
			binding_fingerprint TEXT,revision INTEGER,config_text TEXT,secrets_envelope TEXT,
			key_id TEXT,created_at TEXT,updated_at TEXT
		)`);
		const now = new Date().toISOString();
		const insert = source.query(
			"INSERT INTO plugin_provider_settings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		);
		source.transaction(() => {
			for (const { kind, id } of targets) {
				const address = {
					pluginId: "test.portability",
					contributionId: "settings",
					targetKind: kind,
					targetId: id,
				};
				insert.run(
					settingRowId(address),
					address.pluginId,
					address.contributionId,
					kind,
					id,
					"old-installation",
					configText ? "active" : "deleted",
					1,
					"a".repeat(64),
					"b".repeat(64),
					1,
					configText,
					null,
					null,
					now,
					now,
				);
			}
		})();
	} finally {
		source.close();
	}
	return { sourcePath, outputPath, requests: false, sessions: false };
}

describe("dedicated snapshot process", () => {
	test("real process copies selected tables without mutating source", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-snapshot-worker-"));
		paths.push(root);
		const sourcePath = join(root, "source.sqlite");
		const outputPath = join(root, "output.sqlite");
		const source = new Database(sourcePath);
		for (const table of [...SNAPSHOT_TABLES.requests, ...SNAPSHOT_TABLES.sessions]) {
			source.run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
			source.run(`INSERT INTO ${table} VALUES ('retained')`);
		}
		source.close();
		await buildSnapshotInSubprocess({ ...input, sourcePath, outputPath });
		const snapshot = new Database(outputPath, { readonly: true });
		try {
			for (const table of [...SNAPSHOT_TABLES.requests, ...SNAPSHOT_TABLES.sessions])
				expect(snapshot.query(`SELECT id FROM ${table}`).get()).toEqual({ id: "retained" });
		} finally {
			snapshot.close();
		}
		const verify = new Database(sourcePath, { readonly: true });
		expect(verify.query(`SELECT id FROM ${SNAPSHOT_TABLES.requests[0]}`).get()).toEqual({
			id: "retained",
		});
		verify.close();
	});

	test("provider snapshots include all four kinds and orphan tombstones without a core target filter", async () => {
		const targets: ProviderSettingsTransferTarget[] = [
			{ kind: "custom-api", id: "orphan-custom" },
			{ kind: "nug", id: "orphan-nug" },
			{ kind: "platform", id: "codex:credential:old-account" },
			{ kind: "platform", id: "codex:pool" },
			{ kind: "platform", id: "commandcode:singleton" },
			{ kind: "executable-plugin", id: "old-provider-generation" },
		];
		const fixture = await providerSource(targets);
		expect(await buildSnapshotInSubprocess({ ...fixture, providers: {} })).toEqual({
			ok: true,
			providerSettingsCount: targets.length,
			providerSettingsSealed: false,
		});
		const snapshot = new Database(fixture.outputPath, { readonly: true });
		try {
			const rows = snapshot
				.query("SELECT target_kind AS kind,target_id AS id,state FROM plugin_provider_settings")
				.all();
			for (const target of targets) expect(rows).toContainEqual({ ...target, state: "deleted" });
		} finally {
			snapshot.close();
		}
	});

	test("unmapped old-installation tombstones are retained by import staging", async () => {
		const fixture = await providerSource([
			{ kind: "executable-plugin", id: "retired-generation" },
			{ kind: "platform", id: "codex:credential:missing-credential" },
		]);
		expect(
			await buildSnapshotInSubprocess({
				...fixture,
				providerImport: { mappings: [], expectedCount: 2 },
			}),
		).toEqual({ ok: true, providerSettingsCount: 2, providerSettingsSkipped: 0 });
		const stage = new Database(fixture.outputPath, { readonly: true });
		try {
			const rows = stage
				.query("SELECT target_id,state,installation_id FROM plugin_provider_settings")
				.all() as Array<{ target_id: string; state: string; installation_id: string }>;
			expect(rows.map((row) => row.target_id).sort()).toEqual([
				"codex:credential:missing-credential",
				"retired-generation",
			]);
			for (const row of rows) {
				expect(row.state).toBe("deleted");
				expect(row.installation_id).toMatch(/^import-/);
			}
		} finally {
			stage.close();
		}
	});

	test("many-to-one mappings report the skipped extension without hiding a source record", async () => {
		const fixture = await providerSource([
			{ kind: "custom-api", id: "first" },
			{ kind: "custom-api", id: "second" },
		]);
		expect(
			await buildSnapshotInSubprocess({
				...fixture,
				providerImport: {
					mappings: [
						{ kind: "custom-api", from: "first", to: "local" },
						{ kind: "custom-api", from: "second", to: "local" },
					],
					expectedCount: 2,
				},
			}),
		).toEqual({ ok: true, providerSettingsCount: 1, providerSettingsSkipped: 1 });
	});

	test("export rejects more than 512 retained records rather than truncating them", async () => {
		const fixture = await providerSource(
			Array.from({ length: PROVIDER_SETTINGS_TRANSFER_LIMITS.records + 1 }, (_, i) => ({
				kind: "executable-plugin" as const,
				id: `old-generation-${i}`,
			})),
		);
		await expect(buildSnapshotInSubprocess({ ...fixture, providers: {} })).rejects.toThrow(
			"record limit exceeded",
		);
	});

	test("export rejects the combined 4 MiB budget across otherwise valid retained records", async () => {
		const configText = JSON.stringify({
			owner: "b".repeat(64),
			schemaVersion: 1,
			schemaFingerprint: "a".repeat(64),
			revision: 1,
			values: { first: "x".repeat(4096), second: "y".repeat(4096), third: "z".repeat(4096) },
			secrets: {},
		});
		const fixture = await providerSource(
			Array.from({ length: PROVIDER_SETTINGS_TRANSFER_LIMITS.records }, (_, i) => ({
				kind: "platform" as const,
				id: `codex:credential:old-${i}`,
			})),
			configText,
		);
		await expect(buildSnapshotInSubprocess({ ...fixture, providers: {} })).rejects.toThrow(
			"byte limit exceeded",
		);
	});

	test("creation failure and missing reports fail closed", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("spawn denied");
		});
		try {
			await expect(buildSnapshotInSubprocess(input)).rejects.toThrow("spawn denied");
			for (const job of [
				{
					...input,
					requests: false,
					sessions: false,
					providers: { passphrase: "fixture export passphrase" },
				},
				{
					...input,
					requests: false,
					sessions: false,
					providerImport: { mappings: [], expectedCount: 0 },
				},
				{ ...input, requests: false, sessions: false, providerClear: true },
			])
				await expect(buildSnapshotInSubprocess(job)).rejects.toThrow("spawn denied");
		} finally {
			spawn.mockRestore();
		}
		const original = Bun.spawn;
		const noReport = spyOn(Bun, "spawn").mockImplementation(
			(_command, options?) =>
				original([process.execPath, "-e", "process.exit(0)"], options as never) as ReturnType<
					typeof Bun.spawn
				>,
		);
		try {
			await expect(buildSnapshotInSubprocess(input)).rejects.toThrow("no report");
		} finally {
			noReport.mockRestore();
		}
	});

	test("an older child reporting only ok cannot hide skipped provider transfer work", async () => {
		const original = Bun.spawn;
		const stub = spyOn(Bun, "spawn").mockImplementation(
			(_command, options?) =>
				original(
					[process.execPath, "-e", "process.stdout.write(JSON.stringify({ok:true}));"],
					options as never,
				) as ReturnType<typeof Bun.spawn>,
		);
		try {
			await expect(
				buildSnapshotInSubprocess({
					...input,
					requests: false,
					sessions: false,
					providerClear: true,
				}),
			).rejects.toThrow("incomplete provider transfer report");
		} finally {
			stub.mockRestore();
		}
	});

	test("child reports must account for every imported or skipped source extension", async () => {
		const original = Bun.spawn;
		const stub = spyOn(Bun, "spawn").mockImplementation(
			(_command, options?) =>
				original(
					[
						process.execPath,
						"-e",
						"process.stdout.write(JSON.stringify({ok:true,providerSettingsCount:1,providerSettingsSkipped:0}));",
					],
					options as never,
				) as ReturnType<typeof Bun.spawn>,
		);
		try {
			await expect(
				buildSnapshotInSubprocess({
					...input,
					requests: false,
					sessions: false,
					providerImport: { mappings: [], expectedCount: 2 },
				}),
			).rejects.toThrow("incomplete provider transfer report");
		} finally {
			stub.mockRestore();
		}
	});

	test("real execution timeout and output overflow terminate without copying inline", async () => {
		const original = Bun.spawn;
		let mode = "hang";
		const procs: ReturnType<typeof Bun.spawn>[] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation((_command, options?) => {
			const code =
				mode === "hang"
					? "await Bun.sleep(60000)"
					: "process.stdout.write('x'.repeat(256*1024)); await Bun.sleep(60000)";
			const proc = original([process.execPath, "-e", code], options as never) as ReturnType<
				typeof Bun.spawn
			>;
			procs.push(proc);
			return proc;
		});
		try {
			await expect(buildSnapshotInSubprocess({ ...input, timeoutMs: 100 })).rejects.toThrow(
				"stopped",
			);
			mode = "overflow";
			await expect(buildSnapshotInSubprocess(input)).rejects.toThrow("stopped");
			expect(procs).toHaveLength(2);
			for (const proc of procs) expect(await proc.exited).not.toBe(0);
		} finally {
			spawn.mockRestore();
		}
	});

	test("close rejects queued jobs and cannot release slots before delayed real exit ACK", async () => {
		const resources: { kills: number; finish(): void }[] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			const exited = Promise.withResolvers<number>();
			let stdout!: ReadableStreamDefaultController<Uint8Array>;
			const resource = {
				kills: 0,
				finish() {
					stdout.close();
					exited.resolve(0);
				},
			};
			resources.push(resource);
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						stdout = controller;
					},
				}),
				exited: exited.promise,
				kill() {
					resource.kills++;
				},
			} as unknown as ReturnType<typeof Bun.spawn>;
		});
		const jobs = Array.from({ length: 11 }, () => buildSnapshotInSubprocess(input));
		for (const job of jobs) void job.catch(() => {});
		try {
			await turn();
			expect(resources).toHaveLength(2);
			await expect(jobs[10]).rejects.toMatchObject({ code: "TASK_QUEUE_FULL" });
			let closed = false;
			const closing = closeSnapshotBuilds().then(() => {
				closed = true;
			});
			await turn();
			expect(resources.every((resource) => resource.kills === 1)).toBe(true);
			expect(closed).toBe(false);
			expect(resources).toHaveLength(2);
			for (const resource of resources) resource.finish();
			await closing;
			expect(closed).toBe(true);
			expect((await Promise.allSettled(jobs)).every((job) => job.status === "rejected")).toBe(true);
			await expect(buildSnapshotInSubprocess(input)).rejects.toMatchObject({
				code: "TASK_QUEUE_CLOSED",
			});
		} finally {
			spawn.mockRestore();
		}
	});
});
