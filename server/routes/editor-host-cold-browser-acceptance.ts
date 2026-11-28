import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import type * as Fixture from "../../scripts/smoke-editor-raw-fixture";
import { generateId } from "../lib/id";

type RawWindow = Window & { rawFixture: typeof Fixture };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Actual two-process Host crash, not a service/store reconstruction in a live VM. */
export async function editorHostColdBrowserAcceptance(options: {
	root: string;
	project: string;
	manifest: string;
	distributionUrl: string;
	browser: Browser;
	original: Uint8Array;
}) {
	const home = join(options.root, "cold-host-home"),
		workspace = join(options.root, "cold-host-workspace");
	await mkdir(home, { recursive: true });
	await mkdir(workspace, { recursive: true });
	const target = join(workspace, "twenty.txt");
	await writeFile(target, options.original);
	const config = {
		workspace,
		manifest: options.manifest,
		distributionUrl: options.distributionUrl,
		userId: generateId(),
		narratorId: generateId(),
		secret: `isolated-${randomUUID()}`,
		port: 0,
	};
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let readers: Promise<void>[] = [];
	let logs = "",
		readFailure: unknown;
	async function start() {
		let ready!: (value: { port: number; token: string; pid: number }) => void,
			failed!: (error: unknown) => void;
		const announced = new Promise<{ port: number; token: string; pid: number }>((yes, no) => {
			ready = yes;
			failed = no;
		});
		const process = Bun.spawn(
			[
				globalThis.process.execPath,
				join(options.project, "server/routes/editor-host-cold.fixture.ts"),
			],
			{
				cwd: options.project,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: globalThis.process.env.PATH,
					LANG: "C.UTF-8",
					TZ: "UTC",
					NODE_ENV: "test",
					NARRAFORK_TEST: "1",
					HOME: home,
					USERPROFILE: home,
					NARRAFORK_HOME: join(home, ".narrafork"),
					NARRAFORK_ORIGINAL_HOME: globalThis.process.env.NARRAFORK_ORIGINAL_HOME,
					TMPDIR: home,
					TMP: home,
					TEMP: home,
					XDG_CACHE_HOME: join(home, "cache"),
					NF_WRITE_BACKEND: "sqlite",
					NF_READ_BACKEND: "sqlite",
				},
			},
		);
		child = process;
		process.stdin.write(JSON.stringify(config));
		process.stdin.end();
		const read = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
			const reader = stream.getReader();
			let bytes = 0,
				pending = "";
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (bytes > 64 * 1024) throw new Error("Cold Host fixture log budget exceeded");
					pending += new TextDecoder().decode(chunk.value);
					for (;;) {
						const end = pending.indexOf("\n");
						if (end < 0) break;
						const line = pending.slice(0, end);
						pending = pending.slice(end + 1);
						if (stdout && line.startsWith("EDITOR_HOST_READY ")) ready(JSON.parse(line.slice(18)));
						else logs = `${logs}\n${line}`.slice(-8192);
					}
				}
			} finally {
				reader.releaseLock();
			}
		};
		readers = [read(process.stdout, true), read(process.stderr, false)].map((work) =>
			work.catch((error) => {
				readFailure = error;
				failed(error);
				process.kill("SIGKILL");
			}),
		);
		void process.exited.then((code) => failed(new Error(`Cold Host exited ${code}: ${logs}`)));
		const timer = setTimeout(() => {
			failed(new Error(`Cold Host startup timeout: ${logs}`));
			process.kill("SIGKILL");
		}, 30_000);
		try {
			const info = await announced;
			config.port = info.port;
			return info;
		} finally {
			clearTimeout(timer);
		}
	}
	async function stop() {
		const owned = child;
		child = undefined;
		if (!owned) return;
		owned.kill("SIGKILL");
		await owned.exited;
		await Promise.all(readers);
	}
	const page = await options.browser.newPage();
	try {
		const first = await start(),
			origin = `http://127.0.0.1:${first.port}`;
		await page.goto(origin, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => !!(window as unknown as RawWindow).rawFixture, {
			timeout: 30_000,
		});
		await page.evaluate((path) => (window as unknown as RawWindow).rawFixture.open(path), target);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.dualViews());
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().views.views === 2,
			{ timeout: 15_000 },
		);
		const armed = await fetch(`${origin}/fixture-fault`, {
			method: "POST",
			headers: { Authorization: `Bearer ${first.token}` },
			signal: AbortSignal.timeout(5000),
		});
		expect(armed.ok).toBe(true);
		await armed.body?.cancel();
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.edit("Z"));
		const unknown = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.saveRaw(),
		);
		expect(unknown.session?.phase).toBe("unknown");
		const committed = Buffer.concat([Buffer.from("Z"), options.original]);
		expect(hash(await readFile(target))).toBe(hash(committed));
		await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.rawBatch([
				{
					range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
					text: "L",
				},
			]),
		);
		const dirty = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		const before = (await (
			await fetch(`${origin}/fixture-info`, {
				headers: { Authorization: `Bearer ${first.token}` },
				signal: AbortSignal.timeout(5000),
			})
		).json()) as {
			operations: { id: string }[];
			helpers: { processes: number };
			nativeCalls: { apply: number; query: number };
			faultCounts: { historyFailures: number; droppedReplies: number };
		};
		expect(before.operations).toHaveLength(1);
		expect(before.faultCounts).toEqual({ historyFailures: 0, droppedReplies: 1 });
		expect(before.nativeCalls).toMatchObject({ apply: 0, query: 0, helperStarts: 0, network: 0 });
		expect(before.helpers.processes).toBe(0);
		await stop();
		const second = await start();
		expect(second.pid).not.toBe(first.pid);
		expect(second.port).toBe(first.port);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.reconnectHost());
		await page.waitForFunction(
			() => {
				const state = (window as unknown as RawWindow).rawFixture.state();
				return state.connected && state.session?.phase === "idle" && !state.session.invalidated;
			},
			{ timeout: 30_000 },
		);
		const recovered = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.state(),
		);
		expect(recovered.lifetime).toBe(dirty.lifetime);
		expect(recovered.session?.version).toEqual(dirty.session?.version);
		expect(recovered.session?.baseHash).toBe(hash(committed));
		expect(recovered.dirty).toBe(true);
		const edited = Buffer.concat([Buffer.from("L"), options.original]);
		const encoded = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.encodeRaw(),
		);
		expect(encoded.rawDigest).toBe(hash(edited));
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.undo());
		expect(
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.fingerprint()),
		).toBe(hash(committed));
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.redo());
		expect(
			await page.evaluate(() => (window as unknown as RawWindow).rawFixture.fingerprint()),
		).toBe(hash(edited));
		const after = (await (
			await fetch(`${origin}/fixture-info`, {
				headers: { Authorization: `Bearer ${second.token}` },
				signal: AbortSignal.timeout(5000),
			})
		).json()) as { operations: { id: string }[]; nativeCalls: { apply: number; query: number } };
		expect(after.operations).toEqual(before.operations);
		expect(after.nativeCalls).toMatchObject({ apply: 0, query: 0, helperStarts: 0, network: 0 });
		expect(hash(await readFile(target))).toBe(hash(committed));
		const nextSave = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.saveRaw(),
		);
		expect(nextSave.session?.phase).toBe("idle");
		expect(nextSave.dirty).toBe(false);
		expect(hash(await readFile(target))).toBe(hash(edited));
		const next = (await (
			await fetch(`${origin}/fixture-info`, {
				headers: { Authorization: `Bearer ${second.token}` },
				signal: AbortSignal.timeout(5000),
			})
		).json()) as { operations: { id: string }[]; nativeCalls: { apply: number } };
		expect(next.operations).toHaveLength(2);
		expect(next.nativeCalls).toMatchObject({ apply: 0, query: 0, helperStarts: 0, network: 0 });
		if (readFailure) throw readFailure;
		console.info(
			"EDITOR_HOST_COLD_CHROMIUM",
			JSON.stringify({
				bytes: committed.length,
				hostProcesses: [first.pid, second.pid],
				samePort: first.port,
				originalOperation: before.operations[0]?.id,
				operationsBefore: before.operations.length,
				operationsAfterQuery: after.operations.length,
				nextExplicitSaveOperations: next.operations.length,
				nativeApplyBeforeCrash: before.nativeCalls.apply,
				nativeApplyAfterQuery: after.nativeCalls.apply,
				nativeApplyAfterExplicitSave: next.nativeCalls.apply,
				dirtyBodyUndoAndFormatPreserved: true,
				freshAuthenticatedQuery: true,
				nextWriteUnblocked: true,
				reapply: 0,
			}),
		);
		// A separate real Host mutation succeeds at the FD layer, then recording its
		// effect fails. The successful reply is still delivered; history is not a save gate.
		// Never manufacture an unproven cold operation by editing settled SQL.
		const pendingArmed = await fetch(`${origin}/fixture-fault?pending=1`, {
			method: "POST",
			headers: { Authorization: `Bearer ${second.token}` },
			signal: AbortSignal.timeout(5000),
		});
		expect(pendingArmed.ok).toBe(true);
		await pendingArmed.body?.cancel();
		// Capture the commit receipt inside the page. Reading it back over CDP
		// (`Network.getResponseBody`) is unreliable here: Chrome may evict the buffered
		// body while the save's multi-MiB traffic runs ("No data found for resource"),
		// even when the read starts as soon as the response arrives.
		await page.evaluate(() => {
			const target = window as unknown as {
				fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
				commitReceipt?: Promise<{ ok: boolean; receipt: unknown }>;
			};
			const original = target.fetch.bind(window);
			target.fetch = async (input, init) => {
				const response = await original(input, init);
				const url = input instanceof Request ? input.url : String(input);
				const method = (
					init?.method ?? (input instanceof Request ? input.method : "GET")
				).toUpperCase();
				if (url.endsWith("/commit") && method === "POST" && !target.commitReceipt) {
					target.fetch = original;
					const copy = response.clone();
					target.commitReceipt = copy.json().then((receipt) => ({ ok: copy.ok, receipt }));
				}
				return response;
			};
		});
		await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.rawBatch([
				{
					range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
					text: "Q",
				},
			]),
		);
		type SaveReceipt = {
			operationId: string;
			status: string;
			diskOutcome: string;
			historyStatus: string;
		};
		const savedWithHistoryGap = await page.evaluate(() =>
			(window as unknown as RawWindow).rawFixture.saveRaw(),
		);
		const saveResult = await page.evaluate(() => {
			const captured = (
				window as unknown as { commitReceipt?: Promise<{ ok: boolean; receipt: unknown }> }
			).commitReceipt;
			if (!captured) throw new Error("save did not POST a commit");
			return captured;
		});
		expect(saveResult.ok).toBe(true);
		const saveReceipt = saveResult.receipt as SaveReceipt;
		expect(saveReceipt).toMatchObject({
			status: "saved",
			diskOutcome: "applied",
			historyStatus: "disabled",
		});
		expect(savedWithHistoryGap.session?.phase).toBe("idle");
		expect(savedWithHistoryGap.dirty).toBe(false);
		const pendingBytes = Buffer.concat([Buffer.from("Q"), options.original]);
		expect(hash(await readFile(target))).toBe(hash(pendingBytes));
		type PendingInfo = {
			operations: { id: string; sourceId: string; settlement: string }[];
			leases: { id: string; status: string }[];
			nativeCalls: {
				apply: number;
				query: number;
				ack: number;
				helperStarts: number;
				network: number;
			};
			faultCounts: { historyFailures: number; droppedReplies: number };
		};
		const info = async (token: string): Promise<PendingInfo> => {
			const response = await fetch(`${origin}/fixture-info`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(5000),
			});
			expect(response.ok).toBe(true);
			return response.json();
		};
		const pendingBefore = await info(second.token);
		expect(pendingBefore.operations).toHaveLength(3);
		const unresolved = pendingBefore.operations.filter(
			(operation) => operation.settlement !== "settled",
		);
		expect(unresolved).toHaveLength(1);
		expect(unresolved[0]?.sourceId).toBe(saveReceipt.operationId);
		expect(pendingBefore.faultCounts).toEqual({ historyFailures: 1, droppedReplies: 0 });
		expect(pendingBefore.leases).toEqual([]);
		await stop();
		const third = await start();
		expect(third.pid).not.toBe(second.pid);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.reconnectHost());
		await page.waitForFunction(
			() => (window as unknown as RawWindow).rawFixture.state().connected,
			{ timeout: 30_000 },
		);
		const coldQuery = await fetch(
			`${origin}/api/narrators/${config.narratorId}/editor-operations/${saveReceipt.operationId}`,
			{
				headers: { Authorization: `Bearer ${third.token}` },
				signal: AbortSignal.timeout(5000),
			},
		);
		expect(coldQuery.ok, await coldQuery.clone().text()).toBe(true);
		const coldReceipt = (await coldQuery.json()) as { status: string; operationId: string };
		// The old process confirmed the write, but its effect never persisted. A fresh
		// process cannot infer that proof from matching current bytes or the descriptor.
		expect(coldReceipt).toMatchObject({
			status: "uncertain",
			operationId: saveReceipt.operationId,
		});
		const retained = await page.evaluate(() => (window as unknown as RawWindow).rawFixture.state());
		expect(retained.lifetime).toBe(savedWithHistoryGap.lifetime);
		expect(retained.session?.version).toEqual(savedWithHistoryGap.session?.version);
		expect(retained.session?.baseHash).toBe(hash(pendingBytes));
		expect(retained.dirty).toBe(false);
		// The already-delivered saved reply remains valid for this live draft. A clean
		// save gesture and the cold metadata query must not replay the old write.
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.saveRaw());
		const pendingAfter = await info(third.token);
		expect(pendingAfter.operations).toEqual(pendingBefore.operations);
		expect(pendingAfter.leases).toEqual(pendingBefore.leases);
		expect(pendingAfter.nativeCalls).toEqual({
			apply: 0,
			query: 0,
			ack: 0,
			helperStarts: 0,
			network: 0,
		});
		expect(hash(await readFile(target))).toBe(hash(pendingBytes));
		console.info(
			"EDITOR_HOST_PENDING_COLD_CHROMIUM",
			JSON.stringify({
				hostProcesses: [second.pid, third.pid],
				operations: pendingAfter.operations.length,
				pendingOperation: unresolved[0]?.id,
				savedReply: saveReceipt.status,
				historyStatus: saveReceipt.historyStatus,
				coldQueryStatus: coldReceipt.status,
				sameCurrentDiskDoesNotProveSaved: true,
				noWorkspaceBarrier: pendingAfter.leases.length === 0,
				reapply: 0,
				helperStarts: 0,
				network: 0,
			}),
		);
		await page.evaluate(() => (window as unknown as RawWindow).rawFixture.close());
	} finally {
		await page.close();
		await stop();
	}
}
