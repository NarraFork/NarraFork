import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type PluginUpdateErrorCode, pluginSourceSchema } from "@shared/plugin-source";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { WorkerCleanupError, WorkerHandle } from "../../lib/worker-runtime/lifecycle";
import { downloadPluginArchive, PluginSourceCleanupError } from "../plugin-source-download";
import { PluginSourceFailure, sourceAbortable } from "../plugin-source-resolvers";
import type { PluginSourceServiceOptions } from "../plugin-source-service";
import { PluginSourceUpdateCache } from "../plugin-source-update-cache";
import {
	SOURCE_PLUGIN_ID,
	sourceBytes,
	sourceDeferred,
	sourceDrain,
	sourceServiceFixture,
} from "./plugin-source-fixtures";

let root: string;
let fixture: ReturnType<typeof sourceServiceFixture>;
const additional: ReturnType<typeof sourceServiceFixture>[] = [];
beforeEach(async () => {
	const parent = getNarraforkPath("source-service-tests");
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(join(parent, "run-"));
	fixture = sourceServiceFixture(root);
});
afterEach(async () => {
	await fixture.service.stop();
	for (const item of additional.splice(0)) await item.service.stop();
	await rm(root, { recursive: true, force: true });
});
async function available() {
	const check = await fixture.service.check(SOURCE_PLUGIN_ID);
	expect((await fixture.service.waitForJob(check.jobId))?.status).toBe("succeeded");
	const view = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
	if (!view.candidateId) throw new Error("Expected a candidate");
	return {
		id: view.candidateId,
		revision: (await fixture.service.getSource(SOURCE_PLUGIN_ID)).binding.revision,
	};
}
async function failure(promise: Promise<unknown>, code: PluginUpdateErrorCode) {
	try {
		await promise;
		throw new Error("Expected failure");
	} catch (error) {
		expect(error).toBeInstanceOf(PluginSourceFailure);
		expect((error as PluginSourceFailure).code).toBe(code);
	}
}

describe("plugin source cache and opaque candidates", () => {
	test("source and update GETs are cache-only; an old plugin without source is fully inert", async () => {
		expect((await fixture.service.getUpdates(SOURCE_PLUGIN_ID)).status).toBe("idle");
		expect((await fixture.service.getSource(SOURCE_PLUGIN_ID)).binding.autoUpdate).toBe(false);
		fixture.manager.install(SOURCE_PLUGIN_ID, null);
		expect((await fixture.service.getUpdates(SOURCE_PLUGIN_ID)).status).toBe("no_source");
		await failure(fixture.service.check(SOURCE_PLUGIN_ID), "no_source");
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	test("concurrent check callers coalesce before and after async identity reads", async () => {
		const jobs = await Promise.all([
			fixture.service.check(SOURCE_PLUGIN_ID),
			fixture.service.check(SOURCE_PLUGIN_ID),
			fixture.service.check(SOURCE_PLUGIN_ID),
		]);
		expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
		const first = jobs[0];
		if (!first) throw new Error("Expected a coalesced job");
		await fixture.service.waitForJob(first.jobId);
		expect(fixture.fetch).toHaveBeenCalledTimes(1);
	});

	test("the cached candidate hides URLs and is bound to current hash, UUID and source revision", async () => {
		await available();
		const view = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		expect(view).toMatchObject({
			status: "available",
			installedVersion: "1.0.0",
			latest: { version: "1.2.3", size: sourceBytes.byteLength },
		});
		expect(view.candidateId).toMatch(/^[\da-f-]{36}$/);
		expect(JSON.stringify(view)).not.toMatch(/https:|Authorization|installationId|currentHash/);
		const before = fixture.fetch.mock.calls.length;
		await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		expect(fixture.fetch.mock.calls.length).toBe(before);
	});

	test("cached update views drop a retired job without losing source availability", async () => {
		const original = await fixture.service.check(SOURCE_PLUGIN_ID);
		expect((await fixture.service.waitForJob(original.jobId))?.status).toBe("succeeded");
		const other = "io.example.other";
		fixture.manager.install(other);
		for (let index = 0; index < 256; index++) {
			fixture.advance(10000);
			const check = await fixture.service.check(other);
			expect((await fixture.service.waitForJob(check.jobId))?.status).toBe("succeeded");
		}
		expect(fixture.service.getJob(original.jobId)).toBeNull();
		const view = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		expect(view.jobId).toBeUndefined();
		expect(view.installedVersion).toBe("1.0.0");
		expect((await fixture.service.getSource(SOURCE_PLUGIN_ID)).binding.source).not.toBeNull();
		const renewed = await fixture.service.check(SOURCE_PLUGIN_ID);
		expect((await fixture.service.waitForJob(renewed.jobId))?.status).toBe("succeeded");
	}, 30000);

	test("manual checks have a ten-second floor independent of list polling", async () => {
		await available();
		await failure(fixture.service.check(SOURCE_PLUGIN_ID), "rate_limited");
		fixture.advance(10_000);
		const check = await fixture.service.check(SOURCE_PLUGIN_ID);
		await fixture.service.waitForJob(check.jobId);
		expect(fixture.fetch).toHaveBeenCalledTimes(2);
	});

	test("upstream Retry-After also defers manual checks rather than allowing ten-second hammering", async () => {
		fixture.fetch.mockResolvedValue(
			new Response(null, { status: 429, headers: { "retry-after": "120" } }),
		);
		const check = await fixture.service.check(SOURCE_PLUGIN_ID);
		await fixture.service.waitForJob(check.jobId);
		fixture.advance(10_000);
		await failure(fixture.service.check(SOURCE_PLUGIN_ID), "rate_limited");
		expect(fixture.fetch).toHaveBeenCalledTimes(1);
	});

	test("same or older releases never produce a downgrade candidate", async () => {
		for (const version of ["1.0.0", "0.9.9", "1.0.0+new-build"]) {
			fixture.latest(version);
			fixture.advance(10_000);
			const check = await fixture.service.check(SOURCE_PLUGIN_ID);
			await fixture.service.waitForJob(check.jobId);
			const view = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
			expect(view.status).toBe("up_to_date");
			expect(view.candidateId).toBeUndefined();
		}
	});

	test("expired and fabricated candidates cannot supply an arbitrary download URL", async () => {
		const candidate = await available();
		fixture.advance(15 * 60_000 + 1);
		await failure(
			fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision),
			"source_changed",
		);
		await failure(
			fixture.service.apply(SOURCE_PLUGIN_ID, crypto.randomUUID(), candidate.revision),
			"source_changed",
		);
		expect(fixture.fetch).toHaveBeenCalledTimes(1);
		expect(fixture.manager.updateFromSource).not.toHaveBeenCalled();
	});

	test("source changes and same-hash reinstall UUIDs invalidate old candidates", async () => {
		const candidate = await available();
		await fixture.service.setSource(
			SOURCE_PLUGIN_ID,
			pluginSourceSchema.parse({
				type: "github",
				owner: "example",
				repo: "plugins",
				assetName: "plugin.nfplugin",
			}),
			candidate.revision,
		);
		await failure(
			fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision),
			"source_changed",
		);
		fixture.manager.install(SOURCE_PLUGIN_ID);
		fixture.advance(10_000);
		const replacement = await available();
		fixture.manager.install(SOURCE_PLUGIN_ID);
		await failure(
			fixture.service.apply(SOURCE_PLUGIN_ID, replacement.id, replacement.revision),
			"installation_changed",
		);
		expect(fixture.manager.updateFromSource).not.toHaveBeenCalled();
	});

	test("check deadlines cover abort-ignoring fetches and hide raw errors", async () => {
		const timed = sourceServiceFixture(root, { checkTimeoutMs: 15 });
		additional.push(timed);
		timed.fetch.mockImplementation(() => new Promise(() => {}));
		const check = await timed.service.check(SOURCE_PLUGIN_ID);
		expect(await timed.service.waitForJob(check.jobId)).toMatchObject({
			status: "failed",
			error: "request_failed",
		});
		const view = await timed.service.getUpdates(SOURCE_PLUGIN_ID);
		expect(view.error).toBe("request_failed");
		expect(view.candidateId).toBeUndefined();
	});
});

describe("plugin source update jobs", () => {
	test("streams and verifies a real staged archive before delegating the bound manager update", async () => {
		const candidate = await available();
		const installation = await fixture.manager.getStatus(SOURCE_PLUGIN_ID);
		const apply = await fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision);
		expect(await fixture.service.waitForJob(apply.jobId)).toMatchObject({
			status: "succeeded",
			phase: "completed",
			downloadedBytes: sourceBytes.byteLength,
			cancellable: false,
		});
		expect(fixture.manager.updateFromSource).toHaveBeenCalledTimes(1);
		expect(fixture.manager.updateFromSource.mock.calls[0]?.[1]).toMatchObject({
			expectedCurrent: installation?.current,
			expectedInstallationId: installation?.installationId,
			expectedSourceRevision: 0,
			expectedVersion: "1.2.3",
			automatic: false,
		});
		expect((await fixture.manager.getStatus(SOURCE_PLUGIN_ID))?.current?.version).toBe("1.2.3");
		expect(await readdir(root)).toEqual([]);
	});

	test("a hash mismatch fails before manager CAS and leaves current untouched", async () => {
		const candidate = await available();
		fixture.fetch.mockImplementation(
			async () => new Response(new Uint8Array(sourceBytes.byteLength)),
		);
		const apply = await fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision);
		expect(await fixture.service.waitForJob(apply.jobId)).toMatchObject({
			status: "failed",
			error: "hash_mismatch",
		});
		expect(fixture.manager.updateFromSource).not.toHaveBeenCalled();
		expect((await fixture.manager.getStatus(SOURCE_PLUGIN_ID))?.current?.version).toBe("1.0.0");
	});

	test("a stalled summary write cannot exceed the check deadline or trigger automatic apply", async () => {
		const writing = sourceDeferred<void>();
		const timed = sourceServiceFixture(root, {
			checkTimeoutMs: 20,
			summaries: {
				get: async () => null,
				save: () => writing.promise,
				remove: async () => {},
				flush: async () => {},
			},
		});
		additional.push(timed);
		const job = await timed.service.check(SOURCE_PLUGIN_ID, { automatic: true });
		expect(await timed.service.waitForJob(job.jobId)).toMatchObject({
			status: "failed",
			error: "request_failed",
		});
		const view = await timed.service.getUpdates(SOURCE_PLUGIN_ID);
		expect(view.candidateId).toBeUndefined();
		expect(timed.manager.updateFromSource).not.toHaveBeenCalled();
		let stopped = false;
		const stopping = timed.service.stop().then(() => {
			stopped = true;
		});
		await sourceDrain();
		expect(stopped).toBe(false);
		writing.resolve();
		await stopping;
	});

	test("source mutation and uninstall cancel a hanging check and late results are discarded", async () => {
		fixture.service.start();
		await sourceDrain();
		const pending = sourceDeferred<Response>();
		fixture.fetch.mockImplementation(() => pending.promise);
		const check = await fixture.service.check(SOURCE_PLUGIN_ID);
		await sourceDrain();
		fixture.manager.uninstall(SOURCE_PLUGIN_ID);
		expect(await fixture.service.waitForJob(check.jobId)).toMatchObject({
			status: "cancelled",
			error: "source_changed",
		});
		pending.resolve(Response.json({ schemaVersion: 1, pluginId: SOURCE_PLUGIN_ID, latest: null }));
		await sourceDrain();
		expect(fixture.manager.installBuiltin).not.toHaveBeenCalled();
		expect(fixture.manager.updateFromSource).not.toHaveBeenCalled();
	});

	test("cancellation remains available while manager validation is before the commit fence", async () => {
		const candidate = await available();
		const gate = sourceDeferred<void>();
		const update = await fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision);
		// The real hash Worker resolves asynchronously; wait for entry into the injected validation hook.
		const entered = sourceDeferred<void>();
		fixture.manager.beforeCommit = async (options) => {
			entered.resolve();
			if (!options.signal) throw new Error("Expected the update cancellation signal");
			await sourceAbortable(gate.promise, options.signal);
		};
		await entered.promise;
		expect(fixture.service.getJob(update.jobId)?.cancellable).toBe(true);
		fixture.service.cancel(update.jobId);
		expect(await fixture.service.waitForJob(update.jobId)).toMatchObject({ status: "cancelled" });
		expect((await fixture.manager.getStatus(SOURCE_PLUGIN_ID))?.current?.version).toBe("1.0.0");
	});

	test("after the actual manager commit fence cancel cannot misreport a successful update", async () => {
		const candidate = await available();
		const gate = sourceDeferred<void>();
		const entered = sourceDeferred<void>();
		fixture.manager.afterCommit = async () => {
			entered.resolve();
			await gate.promise;
		};
		const update = await fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision);
		await entered.promise;
		expect(fixture.service.cancel(update.jobId)).toMatchObject({
			status: "running",
			cancellable: false,
		});
		gate.resolve();
		expect(await fixture.service.waitForJob(update.jobId)).toMatchObject({
			status: "succeeded",
			error: null,
		});
	});

	test("permission/trust growth is manual_required for automatic work and a one-time manual confirmation is explicit", async () => {
		const candidate = await available();
		fixture.manager.beforeCommit = async (options) => {
			if (options.automatic || !options.allowTrustChange)
				throw new PluginSourceFailure("manual_required");
		};
		const automatic = await fixture.service.apply(
			SOURCE_PLUGIN_ID,
			candidate.id,
			candidate.revision,
			{ automatic: true },
		);
		expect(await fixture.service.waitForJob(automatic.jobId)).toMatchObject({
			status: "manual_required",
			error: "manual_required",
		});
		expect((await fixture.service.getUpdates(SOURCE_PLUGIN_ID)).status).toBe("manual_required");
		expect((await fixture.manager.getStatus(SOURCE_PLUGIN_ID))?.current?.version).toBe("1.0.0");
		const manual = await fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision, {
			allowTrustChange: true,
		});
		expect((await fixture.service.waitForJob(manual.jobId))?.status).toBe("succeeded");
	});

	test("only two checks run concurrently and excess checks remain queued", async () => {
		fixture.fetch.mockImplementation(() => new Promise(() => {}));
		for (let i = 0; i < 4; i++) fixture.manager.install(`io.example.plugin${i}`);
		const checks = await Promise.all(
			Array.from({ length: 4 }, (_, i) => fixture.service.check(`io.example.plugin${i}`)),
		);
		await sourceDrain();
		expect(fixture.fetch).toHaveBeenCalledTimes(2);
		expect(
			checks.filter(({ jobId }) => fixture.service.getJob(jobId)?.status === "queued"),
		).toHaveLength(2);
		expect(fixture.service.hasPendingShutdownWork()).toBe(true);
		await fixture.service.stop();
		expect(fixture.service.hasPendingShutdownWork()).toBe(false);
		for (const check of checks)
			expect((await fixture.service.waitForJob(check.jobId))?.status).toBe("cancelled");
	});

	test("bounded queue rejects backpressure instead of growing unbounded work", async () => {
		const limited = sourceServiceFixture(root, { maxChecks: 1, maxQueued: 1 });
		additional.push(limited);
		limited.fetch.mockImplementation(() => new Promise(() => {}));
		limited.manager.install("io.example.second");
		limited.manager.install("io.example.third");
		await limited.service.check(SOURCE_PLUGIN_ID);
		await sourceDrain();
		await limited.service.check("io.example.second");
		await failure(limited.service.check("io.example.third"), "queue_full");
	});

	test("only one archive download runs at a time", async () => {
		const downloads: string[] = [];
		const download: NonNullable<PluginSourceServiceOptions["download"]> = async (
			_source,
			release,
			options,
		) => {
			downloads.push(release.pluginId);
			await sourceAbortable(new Promise<never>(() => {}), options.signal);
			throw new Error("unreachable");
		};
		const limited = sourceServiceFixture(root, { download });
		additional.push(limited);
		limited.manager.install("io.example.second");
		const candidates: Array<{ pluginId: string; candidateId: string }> = [];
		for (const pluginId of [SOURCE_PLUGIN_ID, "io.example.second"]) {
			const check = await limited.service.check(pluginId);
			await limited.service.waitForJob(check.jobId);
			const candidateId = (await limited.service.getUpdates(pluginId)).candidateId;
			if (!candidateId) throw new Error("Expected an update candidate");
			candidates.push({ pluginId, candidateId });
		}
		const updates = await Promise.all(
			candidates.map(({ pluginId, candidateId }) =>
				limited.service.apply(pluginId, candidateId, 0),
			),
		);
		await sourceDrain();
		expect(downloads).toHaveLength(1);
		expect(
			updates.filter(({ jobId }) => limited.service.getJob(jobId)?.status === "queued"),
		).toHaveLength(1);
	});

	test("explicit builtin installation uses the trusted current NF descriptor, never bootstrap tombstones", async () => {
		const job = await fixture.service.installBuiltin(fixture.local.pluginId);
		expect((await fixture.service.waitForJob(job.jobId))?.status).toBe("succeeded");
		expect(fixture.manager.installBuiltin).toHaveBeenCalledTimes(1);
		expect((await fixture.manager.getStatus(fixture.local.pluginId))?.current?.version).toBe(
			"1.0.3",
		);
		expect(fixture.fetch).not.toHaveBeenCalled();
		await failure(fixture.service.installBuiltin(fixture.local.pluginId), "installation_changed");
	});
});

describe("automatic plugin source scheduling", () => {
	test("default false and no-source plugins never request metadata after startup", async () => {
		fixture.manager.install("io.example.old", null);
		fixture.service.start();
		await fixture.service.runAutomaticChecks();
		fixture.advance(24 * 60 * 60_000);
		await fixture.service.runAutomaticChecks();
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	test("explicit opt-in checks after six hours and applies through the same bounded job path", async () => {
		fixture.service.start();
		await sourceDrain();
		await fixture.service.setAutoUpdate(SOURCE_PLUGIN_ID, true, 0);
		await fixture.service.runAutomaticChecks();
		fixture.advance(6 * 60 * 60_000 - 1);
		await fixture.service.runAutomaticChecks();
		expect(fixture.fetch).not.toHaveBeenCalled();
		fixture.advance(1);
		await fixture.service.runAutomaticChecks();
		const check = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		if (!check.jobId) throw new Error("Expected scheduled job");
		await fixture.service.waitForJob(check.jobId);
		await sourceDrain();
		const apply = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		if (!apply.jobId) throw new Error("Expected automatic apply job");
		await fixture.service.waitForJob(apply.jobId);
		expect(fixture.manager.updateFromSource.mock.calls[0]?.[1].automatic).toBe(true);
	});

	test("automatic checks respect jitter and bounded retry backoff instead of hot polling", async () => {
		const jittered = sourceServiceFixture(root, { random: () => 1 });
		additional.push(jittered);
		jittered.service.start();
		await sourceDrain();
		await jittered.service.setAutoUpdate(SOURCE_PLUGIN_ID, true, 0);
		await jittered.service.runAutomaticChecks();
		jittered.advance(6 * 60 * 60_000);
		await jittered.service.runAutomaticChecks();
		expect(jittered.fetch).not.toHaveBeenCalled();
		jittered.advance(30 * 60_000);
		await jittered.service.runAutomaticChecks();
		const checked = await jittered.service.getUpdates(SOURCE_PLUGIN_ID);
		if (checked.jobId) await jittered.service.waitForJob(checked.jobId);
		expect(jittered.fetch.mock.calls.length).toBeGreaterThanOrEqual(1);

		fixture.service.start();
		await sourceDrain();
		await fixture.service.setAutoUpdate(SOURCE_PLUGIN_ID, true, 0);
		fixture.fetch.mockRejectedValue(new Error("source temporarily unavailable"));
		await fixture.service.runAutomaticChecks();
		fixture.advance(6 * 60 * 60_000);
		await fixture.service.runAutomaticChecks();
		const first = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		if (first.jobId) await fixture.service.waitForJob(first.jobId);
		fixture.advance(59_999);
		await fixture.service.runAutomaticChecks();
		expect(fixture.fetch).toHaveBeenCalledTimes(1);
		fixture.advance(1);
		await fixture.service.runAutomaticChecks();
		const second = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		if (second.jobId) await fixture.service.waitForJob(second.jobId);
		fixture.advance(119_999);
		await fixture.service.runAutomaticChecks();
		expect(fixture.fetch).toHaveBeenCalledTimes(2);
	});

	test("automatic directory scanning rotates beyond the first bounded batch", async () => {
		for (let i = 0; i < 300; i++)
			fixture.manager.install(`io.example.plugin-${String(i).padStart(3, "0")}`);
		fixture.manager.install("io.example.tail");
		await fixture.manager.setAutoUpdate("io.example.tail", true, { expectedRevision: 0 });
		fixture.service.start();
		await sourceDrain();
		await fixture.service.runAutomaticChecks();
		await fixture.service.runAutomaticChecks();
		fixture.advance(6 * 60 * 60_000);
		await fixture.service.runAutomaticChecks();
		await fixture.service.runAutomaticChecks();
		const view = await fixture.service.getUpdates("io.example.tail");
		if (!view.jobId) throw new Error("Expected tail plugin check");
		await fixture.service.waitForJob(view.jobId);
		expect(
			fixture.fetch.mock.calls.some(
				([url]) => new URL(url).searchParams.get("pluginId") === "io.example.tail",
			),
		).toBe(true);
	});

	test("global disable, unsafe HTTP and uninstall cannot be interpreted as automatic reinstall", async () => {
		fixture.service.start();
		await sourceDrain();
		await fixture.service.setAutoUpdate(SOURCE_PLUGIN_ID, true, 0);
		await fixture.service.runAutomaticChecks();
		fixture.manager.enabled = false;
		fixture.advance(24 * 60 * 60_000);
		await fixture.service.runAutomaticChecks();
		expect(fixture.fetch).not.toHaveBeenCalled();
		fixture.manager.enabled = true;
		await fixture.service.setSource(
			SOURCE_PLUGIN_ID,
			pluginSourceSchema.parse({
				type: "website",
				updateApi: "http://127.0.0.1:1234/latest",
				allowInsecureHttp: true,
			}),
			1,
		);
		await failure(fixture.service.setAutoUpdate(SOURCE_PLUGIN_ID, true, 2), "manual_required");
		fixture.manager.uninstall(SOURCE_PLUGIN_ID);
		await fixture.service.runAutomaticChecks();
		expect(fixture.manager.installBuiltin).not.toHaveBeenCalled();
		expect(fixture.fetch).not.toHaveBeenCalled();
	});
});

describe("plugin source shutdown ownership", () => {
	test("committed update results do not wait for summary deletion, but shutdown retains that IO", async () => {
		const removing = sourceDeferred<void>();
		const timed = sourceServiceFixture(root, {
			summaries: {
				get: async () => null,
				save: async () => {},
				remove: () => removing.promise,
				flush: async () => {},
			},
		});
		try {
			const check = await timed.service.check(SOURCE_PLUGIN_ID);
			await timed.service.waitForJob(check.jobId);
			const view = await timed.service.getUpdates(SOURCE_PLUGIN_ID);
			if (!view.candidateId) throw new Error("Expected a candidate");
			const update = await timed.service.apply(SOURCE_PLUGIN_ID, view.candidateId, 0);
			expect(await timed.service.waitForJob(update.jobId)).toMatchObject({ status: "succeeded" });
			expect((await timed.manager.getStatus(SOURCE_PLUGIN_ID))?.current?.version).toBe("1.2.3");
			let stopped = false;
			const stopping = timed.service.stop().then(() => {
				stopped = true;
			});
			await sourceDrain();
			expect(stopped).toBe(false);
			removing.resolve();
			await stopping;
		} finally {
			removing.resolve();
			await timed.service.stop();
		}
	});

	test("a committed job and a timed-out stop do not release a still-running summary rename", async () => {
		const filePath = join(root, "summary.json");
		const release = sourceDeferred<void>();
		let holdRename = false;
		let renaming = false;
		const store = new PluginSourceUpdateCache({
			filePath,
			ioTimeoutMs: 200,
			fs: {
				rename: async (...args) => {
					if (holdRename) {
						renaming = true;
						await release.promise;
					}
					await rename(...args);
				},
			},
		});
		const remove = spyOn(store, "remove");
		const { service, manager } = sourceServiceFixture(root, {
			summaries: store,
			shutdownTimeoutMs: 30,
		});
		try {
			const check = await service.check(SOURCE_PLUGIN_ID);
			expect(await service.waitForJob(check.jobId)).toMatchObject({ status: "succeeded" });
			const view = await service.getUpdates(SOURCE_PLUGIN_ID);
			if (!view.candidateId) throw new Error("Expected a candidate");
			holdRename = true;
			const update = await service.apply(SOURCE_PLUGIN_ID, view.candidateId, 0);
			expect(await service.waitForJob(update.jobId)).toMatchObject({ status: "succeeded" });
			expect((await manager.getStatus(SOURCE_PLUGIN_ID))?.current?.version).toBe("1.2.3");
			const removal = remove.mock.results[0];
			if (removal?.type !== "return") throw new Error("Expected the summary removal");
			await expect(removal.value).rejects.toThrow("summary IO timed out");
			await sourceDrain();
			expect(renaming).toBe(true);
			expect(service.hasPendingShutdownWork()).toBe(true);
			const stopping = service.stop();
			await expect(stopping).rejects.toThrow("Plugin source shutdown timed out");
			expect(service.stop()).toBe(stopping);
			expect(service.hasPendingShutdownWork()).toBe(true);
			release.resolve();
			await expect(store.flush()).rejects.toThrow("summary IO timed out");
			await sourceDrain();
			expect(JSON.parse(await readFile(filePath, "utf8")).entries).toEqual([]);
			expect(service.hasPendingShutdownWork()).toBe(false);
			expect(service.stop()).toBe(stopping);
			expect(service.getJob(update.jobId)?.status).toBe("succeeded");
		} finally {
			release.resolve();
			await store.flush().catch(() => {});
			await service.stop().catch(() => {});
			remove.mockRestore();
		}
	});

	test("staging cleanup failures preserve committed results and fail the shutdown barrier", async () => {
		const cleanupError = new Error("staging cleanup failed");
		const timed = sourceServiceFixture(root, {
			download: async (source, release, options) => {
				const archive = await downloadPluginArchive(source, release, options);
				return {
					path: archive.path,
					cleanup: async () => {
						await archive.cleanup();
						throw cleanupError;
					},
				};
			},
		});
		try {
			const check = await timed.service.check(SOURCE_PLUGIN_ID);
			await timed.service.waitForJob(check.jobId);
			const view = await timed.service.getUpdates(SOURCE_PLUGIN_ID);
			if (!view.candidateId) throw new Error("Expected a candidate");
			const update = await timed.service.apply(SOURCE_PLUGIN_ID, view.candidateId, 0);
			expect(await timed.service.waitForJob(update.jobId)).toMatchObject({ status: "succeeded" });
			expect((await timed.manager.getStatus(SOURCE_PLUGIN_ID))?.current?.version).toBe("1.2.3");
			await expect(timed.service.stop()).rejects.toBe(cleanupError);
			expect(timed.service.hasPendingShutdownWork()).toBe(false);
		} finally {
			await timed.service.stop().catch(() => {});
		}
	});

	test("a failed download retains its Worker exit and removal, not the historical removal error", async () => {
		const exited = sourceDeferred<number>();
		const removed = sourceDeferred<void>();
		const handle = new WorkerHandle({}, exited.promise, () => {});
		const failure = new PluginSourceCleanupError(
			new WorkerCleanupError(handle, new Error("exit not yet confirmed")),
			handle.exited.then(async () => {
				await removed.promise;
				throw new Error("late directory removal failed");
			}),
		);
		const { service } = sourceServiceFixture(root, {
			download: async () => {
				throw failure;
			},
		});
		try {
			const check = await service.check(SOURCE_PLUGIN_ID);
			await service.waitForJob(check.jobId);
			const view = await service.getUpdates(SOURCE_PLUGIN_ID);
			if (!view.candidateId) throw new Error("Expected a candidate");
			const update = await service.apply(SOURCE_PLUGIN_ID, view.candidateId, 0);
			expect(await service.waitForJob(update.jobId)).toMatchObject({
				status: "failed",
				error: "apply_failed",
			});
			const stopping = service.stop();
			let stopped = false;
			void stopping.catch(() => {
				stopped = true;
			});
			await sourceDrain();
			expect(service.hasPendingShutdownWork()).toBe(true);
			exited.resolve(1);
			await sourceDrain();
			expect(stopped).toBe(false);
			expect(service.hasPendingShutdownWork()).toBe(true);
			removed.resolve();
			await expect(stopping).rejects.toBe(failure);
			expect(service.hasPendingShutdownWork()).toBe(false);
		} finally {
			exited.resolve(1);
			removed.resolve();
			await service.stop().catch(() => {});
		}
	});

	test("stop closes admission but retains a source change already inside the manager", async () => {
		const entered = sourceDeferred<void>();
		const release = sourceDeferred<void>();
		const { service, manager } = fixture;
		const change = manager.setSource.bind(manager);
		const setSource = spyOn(manager, "setSource").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return change(...args);
		});
		try {
			expect(service.hasPendingShutdownWork()).toBe(false);
			const changing = service.setSource(SOURCE_PLUGIN_ID, null, 0);
			expect(service.hasPendingShutdownWork()).toBe(true);
			await entered.promise;
			let stopped = false;
			const stopping = service.stop().then(() => {
				stopped = true;
			});
			await failure(service.setAutoUpdate(SOURCE_PLUGIN_ID, true, 0), "cancelled");
			expect(service.hasPendingShutdownWork()).toBe(true);
			expect(stopped).toBe(false);
			release.resolve();
			expect((await changing).binding.revision).toBe(1);
			await stopping;
			expect(service.hasPendingShutdownWork()).toBe(false);
		} finally {
			release.resolve();
			setSource.mockRestore();
		}
	});

	test("repeated stop shares one promise and waits for a committed update result", async () => {
		const candidate = await available();
		const entered = sourceDeferred<void>();
		const commit = sourceDeferred<void>();
		fixture.manager.afterCommit = async () => {
			entered.resolve();
			await commit.promise;
		};
		const job = await fixture.service.apply(SOURCE_PLUGIN_ID, candidate.id, candidate.revision);
		await entered.promise;
		let settled = false;
		const stopping = fixture.service.stop();
		void stopping.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		expect(fixture.service.stop()).toBe(stopping);
		await sourceDrain();
		expect(settled).toBe(false);
		commit.resolve();
		await expect(stopping).resolves.toBeUndefined();
		expect(await fixture.service.waitForJob(job.jobId)).toMatchObject({ status: "succeeded" });
	});

	test("shutdown timeout reports failure and retains a committed update until it settles", async () => {
		const timed = sourceServiceFixture(root, { shutdownTimeoutMs: 20 });
		additional.push(timed);
		const check = await timed.service.check(SOURCE_PLUGIN_ID);
		await timed.service.waitForJob(check.jobId);
		const view = await timed.service.getUpdates(SOURCE_PLUGIN_ID);
		if (!view.candidateId) throw new Error("Expected a candidate");
		const entered = sourceDeferred<void>();
		const commit = sourceDeferred<void>();
		timed.manager.afterCommit = async () => {
			entered.resolve();
			await commit.promise;
		};
		const revision = (await timed.manager.getSource(SOURCE_PLUGIN_ID)).binding.revision;
		const job = await timed.service.apply(SOURCE_PLUGIN_ID, view.candidateId, revision);
		await entered.promise;
		const stopping = timed.service.stop();
		expect(timed.service.stop()).toBe(stopping);
		await expect(stopping).rejects.toThrow("Plugin source shutdown timed out");
		expect(timed.service.getJob(job.jobId)?.status).toBe("running");
		commit.resolve();
		expect(await timed.service.waitForJob(job.jobId)).toMatchObject({ status: "succeeded" });
		await sourceDrain();
		const index = additional.indexOf(timed);
		if (index >= 0) additional.splice(index, 1);
	});
});
