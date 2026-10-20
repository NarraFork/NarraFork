import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getEventLoopLagSnapshot,
	startEventLoopMonitor,
	stopEventLoopMonitor,
} from "./event-loop-monitor";
import { createDiagnosticFileWriter, DiagnosticWriter } from "./request-diagnostic-writer";
import {
	type DiagnosticRecord,
	diagnosticAwait,
	diagnosticGitScope,
	diagnosticRoute,
	diagnosticSql,
	diagnosticSync,
	RequestDiagnostics,
} from "./request-diagnostics";

function harness() {
	let time = 0;
	const records: DiagnosticRecord[] = [];
	const diagnostics = new RequestDiagnostics(
		(record) => records.push(record),
		() => time,
	);
	diagnostics.start();
	return {
		diagnostics,
		records,
		set: (value: number) => {
			time = value;
		},
		outcome: () => ({ status: 200, cancelled: false }),
	};
}

describe("bounded request diagnostics", () => {
	for (const outcome of ["success", "error", "cancelled"] as const) {
		test(`modifications phases preserve ${outcome} and keep authorization outside handler`, async () => {
			const h = harness();
			const value = { byFile: [] };
			const failure = new Error("private-path-and-content");
			const controller = new AbortController();
			const order: string[] = [];
			const request = h.diagnostics.request(
				"/api/narrators/private/git/modifications",
				async () => {
					await diagnosticAwait("git.authorize", async () => {
						h.set(300);
					});
					diagnosticGitScope("0123456789abcdef");
					diagnosticGitScope("/private/path");
					return diagnosticAwait("git.modifications", async () => {
						return diagnosticAwait("modifications.view", async () => {
							order.push("start");
							await Promise.resolve();
							h.set(1500);
							order.push("settle");
							if (outcome === "cancelled") controller.abort(failure);
							controller.signal.throwIfAborted();
							if (outcome === "error") throw failure;
							return value;
						});
					});
				},
				() => ({ status: outcome === "success" ? 200 : 500, cancelled: controller.signal.aborted }),
			);
			if (outcome === "success") expect(await request).toBe(value);
			else {
				let caught: unknown;
				try {
					await request;
				} catch (error) {
					caught = error;
				}
				expect(caught).toBe(failure);
			}
			expect(order).toEqual(["start", "settle"]);
			h.diagnostics.tick(1501, 0);
			expect(h.records).toHaveLength(1);
			const record = h.records[0];
			expect(record.scopeId).toBe("0123456789abcdef");
			expect(record.phases["git.authorize.await"].totalMs).toBe(300);
			expect(record.phases["git.modifications.await"].totalMs).toBe(1200);
			expect(record.phases["modifications.view.await"].totalMs).toBe(1200);
			expect(record.cancelled).toBe(outcome === "cancelled");
			expect(JSON.stringify(record)).not.toContain("private");
			h.diagnostics.stop();
		});
	}

	test("monitor stop clears its sampling timer", async () => {
		try {
			startEventLoopMonitor({ intervalMs: 2 });
			await Bun.sleep(15);
			expect(getEventLoopLagSnapshot().sampleCount).toBeGreaterThan(0);
			stopEventLoopMonitor();
			const stopped = getEventLoopLagSnapshot().sampleCount;
			await Bun.sleep(10);
			expect(getEventLoopLagSnapshot().sampleCount).toBe(stopped);
		} finally {
			stopEventLoopMonitor();
		}
	});
	test("asynchronous wall time does not imply loop blocking", async () => {
		const h = harness();
		await h.diagnostics.request(
			"/api/git/private?secret",
			async () => {
				await diagnosticAwait("baseline.before", async () => {
					for (let i = 1; i <= 12; i++) {
						await Promise.resolve();
						h.set(i * 100);
						h.diagnostics.tick(i * 100, 0);
					}
				});
			},
			h.outcome,
		);
		h.set(1300);
		h.diagnostics.tick(1300, 0);
		expect(h.records[0].wallMs).toBe(1200);
		expect(h.records[0].loop.maxLagMs).toBe(0);
		expect(h.records[0].loop.coverage).toBe("complete");
		expect(h.records[0].phases["baseline.before.await"].totalMs).toBe(1200);
		expect(h.records[0].slowSync).toEqual([]);
		h.diagnostics.stop();
	});
	test("completed request waits for tick and identifies slow synchronous operation", async () => {
		const h = harness();
		await h.diagnostics.request(
			"/api/chapters/secret/git/modifications",
			async () => {
				diagnosticSync("evidence.sync", () => diagnosticSql("effect", () => h.set(1200)));
			},
			h.outcome,
		);
		expect(h.records).toHaveLength(0);
		h.set(1201);
		h.diagnostics.tick(1201, 1101);
		const record = h.records[0];
		expect(record.loop.maxLagMs).toBe(1101);
		expect(record.loop.delayStartMs).toBe(100);
		expect(record.slowSync[0]).toMatchObject({
			name: "sql.effect",
			startMs: 0,
			endMs: 1200,
			durationMs: 1200,
		});
		expect(record.sqlOperations["sql.effect"]).toEqual({
			count: 1,
			totalMs: 1200,
			maxMs: 1200,
			slowCount: 1,
		});
		expect(record.loop.attribution).toBe("unattributed");
		expect(JSON.stringify(record)).not.toContain("secret");
		h.diagnostics.stop();
	});
	test("delay starting after request completion is not correlated", async () => {
		const h = harness();
		await h.diagnostics.request(
			"/api/git",
			async () => {
				for (let i = 1; i <= 12; i++) {
					h.set(i * 100);
					h.diagnostics.tick(i * 100, 0);
				}
				h.set(1250);
			},
			h.outcome,
		);
		h.set(2400);
		h.diagnostics.tick(2400, 1100);
		expect(h.records[0].loop.maxLagMs).toBe(0);
		h.diagnostics.stop();
	});
	test("ALS isolates concurrent requests and records throwing SQL", async () => {
		const h = harness();
		let release = () => {};
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = h.diagnostics.request(
			"/api/git",
			async () => {
				await wait;
				expect(() =>
					diagnosticSql("scope", () => {
						h.set(1500);
						throw new Error("private SQL parameters");
					}),
				).toThrow();
			},
			h.outcome,
		);
		await h.diagnostics.request(
			"/api/projects",
			async () => {
				diagnosticSql("summaries", () => h.set(100));
				h.set(1200);
			},
			() => ({ status: 499, cancelled: true }),
		);
		release();
		await first;
		h.set(1600);
		h.diagnostics.tick(1600, 1500);
		expect(h.records).toHaveLength(2);
		expect(h.records[0].sqlOperations["sql.scope"]).toBeUndefined();
		expect(h.records[1].sqlOperations["sql.summaries"]).toBeUndefined();
		expect(h.records[1].sql.slowCount).toBe(1);
		expect(h.records[0].cancelled).toBe(true);
		expect(h.records[0].requestId).not.toBe(h.records[1].requestId);
		expect(JSON.stringify(h.records)).not.toContain("private SQL");
		h.diagnostics.stop();
	});
	test("ring overwrite and stopped monitor disclose incomplete coverage", async () => {
		const h = harness();
		await h.diagnostics.request(
			"/api/git",
			async () => {
				for (let i = 1; i <= 610; i++) {
					h.set(i * 100);
					h.diagnostics.tick(i * 100, 0);
				}
			},
			h.outcome,
		);
		h.set(61100);
		h.diagnostics.tick(61100, 0);
		expect(h.records[0].loop.coverage).toBe("partial");
		expect(h.records[0].loop.samples).toBeLessThanOrEqual(600);
		h.diagnostics.stop();
		h.set(72000);
		await h.diagnostics.request("/api/projects", async () => h.set(74000), h.outcome);
		expect(h.records[1].loop.truncated).toBe(true);
	});
	test("same-category rate limit counts suppression and pending overflow", async () => {
		const h = harness();
		for (let i = 0; i < 260; i++)
			await h.diagnostics.request("/api/git", async () => h.set(i + 1), h.outcome);
		h.set(2000);
		h.diagnostics.tick(2000, 1900);
		expect(h.records).toHaveLength(1);
		expect(h.records[0].pendingDropped).toBe(4);
		h.set(13000);
		await h.diagnostics.request("/api/git", async () => h.set(15000), h.outcome);
		h.set(15100);
		h.diagnostics.tick(15100, 0);
		expect(h.records[1].suppressed).toBe(155);
		h.diagnostics.stop();
	});
	test("global rate cap across fixed categories", async () => {
		const h = harness();
		for (let round = 0; round < 4; round++) {
			h.set(round * 12000);
			for (const route of [
				"git",
				"chapters",
				"narrators",
				"projects",
				"auth",
				"health",
				"settings",
				"storage",
				"devices",
				"unknown",
			]) {
				await h.diagnostics.request(
					`/api/${route}`,
					async () => diagnosticSql("scope", () => h.set(round * 12000 + 1000)),
					h.outcome,
				);
			}
			h.set(round * 12000 + 1100);
			h.diagnostics.tick(round * 12000 + 1100, 1000);
		}
		expect(h.records.length).toBeLessThanOrEqual(30);
		h.diagnostics.stop();
	});
	test("fully populated aggregates fit the log record budget", async () => {
		const h = harness();
		let now = 0;
		await h.diagnostics.request(
			"/api/git",
			async () => {
				for (const name of [
					"scope",
					"effect",
					"operation",
					"projection",
					"blobs",
					"summaries",
					"observations",
				] as const)
					diagnosticSql(name, () => {
						now += 123.456;
						h.set(now);
					});
				diagnosticGitScope("0123456789abcdef");
				for (const name of [
					"git.authorize",
					"git.modifications",
					"modifications.actor-access",
					"modifications.status",
					"modifications.scopes",
					"modifications.view",
					"modifications.redact",
					"modifications.identity",
					"modifications.history",
					"modifications.actors",
					"modifications.current-diff",
					"baseline.before",
					"baseline.after",
					"blob.verify",
					"actor.resolve",
					"yield",
					"worker.startup",
					"worker.response",
					"worker.cleanup",
				] as const)
					await diagnosticAwait(name, async () => {
						now += 123.456;
						h.set(now);
					});
				for (const name of ["evidence.sync", "consistency.sync"] as const)
					diagnosticSync(name, () => {
						now += 123.456;
						h.set(now);
					});
			},
			h.outcome,
		);
		h.diagnostics.tick(now + 100, now);
		expect(Object.keys(h.records[0].phases)).toHaveLength(21);
		expect(Buffer.byteLength(`${JSON.stringify(h.records[0])}\n`)).toBeLessThanOrEqual(4096);
		h.diagnostics.stop();
	});
	test("route labels contain no user data", () => {
		expect(diagnosticRoute("/api/chapters/secret/git/modifications")).toBe("git.modifications");
		expect(diagnosticRoute("/api/private-token/file.sql")).toBe("other");
	});
});

describe("asynchronous diagnostic writer", () => {
	test("file rotation bounds disk usage and keeps private permissions", async () => {
		const home = await mkdtemp(join(tmpdir(), "request-diagnostic-"));
		try {
			const writer = createDiagnosticFileWriter(home);
			const line = `${"x".repeat(4095)}\n`;
			for (let batch = 0; batch < 100; batch++) {
				for (let row = 0; row < 16; row++) writer.write(line);
				await writer.flush();
			}
			expect(writer.dropped).toBe(0);
			const names = await readdir(home);
			expect(names.sort()).toEqual([
				"request-diagnostics.jsonl",
				"request-diagnostics.jsonl.1",
				"request-diagnostics.jsonl.2",
			]);
			for (const name of names) {
				const metadata = await stat(join(home, name));
				expect(metadata.size).toBeLessThanOrEqual(2 * 1024 * 1024);
				if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	test.skipIf(process.platform === "win32")("refuses symlink log destinations", async () => {
		const home = await mkdtemp(join(tmpdir(), "request-diagnostic-"));
		try {
			const target = join(home, "target");
			await writeFile(target, "private");
			await symlink(target, join(home, "request-diagnostics.jsonl"));
			const writer = createDiagnosticFileWriter(home);
			writer.write("{}\n");
			await writer.flush();
			expect(writer.dropped).toBe(1);
			expect(await readFile(target, "utf8")).toBe("private");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	test("queue and line limits drop diagnostics without blocking callers", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const batches: string[] = [];
		const writer = new DiagnosticWriter(async (batch) => {
			await blocked;
			batches.push(batch);
		});
		for (let i = 0; i < 100; i++) writer.write(`${"x".repeat(4095)}\n`);
		writer.write("x".repeat(4097));
		expect(writer.dropped).toBe(37);
		release();
		await writer.flush();
		expect(batches.join("").length).toBe(256 * 1024);
	});
	test("write failures are contained and subsequent batches continue", async () => {
		let calls = 0;
		const writer = new DiagnosticWriter(async () => {
			calls++;
			throw new Error("disk unavailable");
		});
		writer.write("{}\n");
		await writer.flush();
		writer.write("{}\n");
		await writer.flush();
		expect(writer.dropped).toBe(2);
		expect(calls).toBe(2);
	});
});
