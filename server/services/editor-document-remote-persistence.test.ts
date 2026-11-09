import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	EditorOperationResult,
	EditorRawDocumentDescriptor,
	EditorSaveResult,
	EditorUploadDescriptor,
} from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const binary = resolve(
	import.meta.dir,
	`../../.narrafork/editor-phase8-executor${process.platform === "win32" ? ".exe" : ""}`,
);
interface Info {
	pid: number;
	online: boolean;
	operations: {
		id: string;
		sourceId: string;
		settlement: string;
		workspaceLeaseId: string | null;
		snapshotRevision: number | null;
	}[];
	leases: { id: string; status: string }[];
	nativeCalls: { apply: number; query: number; ack: number; helperStarts: number; network: number };
}
// Same isolated executable Host fixture as the real browser cold-recovery test.
// The executor is an independent, prebuilt --server peer, never a Host helper.
test.each([
	"terminal-and-ack",
	"lost-apply-cold",
	"settlement-cold",
] as const)("real remote persistence without Host helper: %s", async (scenario) => {
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "remote-persistence-"));
	const home = join(root, "host-home"),
		peerHome = join(root, "peer-home"),
		workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(peerHome), mkdir(workspace)]);
	const target = join(workspace, "file.txt");
	await writeFile(target, "before");
	const peerToken = `rdev_${randomUUID().replaceAll("-", "")}`;
	const config = {
		workspace,
		userId: randomUUID(),
		narratorId: randomUUID(),
		secret: `fixture-${randomUUID()}`,
		port: 0,
		remote: { deviceId: randomUUID(), tokenHash: hash(peerToken) },
	};
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let peer: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let hostReaders: Promise<void>[] = [],
		peerReaders: Promise<void>[] = [];
	let logs = "",
		logFailure: unknown;
	let auth = "",
		origin = "";
	const pids: number[] = [];
	const drain = async (stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void) => {
		const reader = stream.getReader();
		let total = 0,
			pending = "";
		try {
			for (;;) {
				const value = await reader.read();
				if (value.done) break;
				total += value.value.length;
				if (total > 64 * 1024) throw new Error("Persistence fixture log budget");
				pending += new TextDecoder().decode(value.value);
				for (;;) {
					const end = pending.indexOf("\n");
					if (end < 0) break;
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					onLine?.(line);
					if (!line.startsWith("EDITOR_HOST_READY ")) logs = `${logs}\n${line}`.slice(-8192);
				}
			}
		} finally {
			reader.releaseLock();
		}
	};
	async function startHost() {
		let ready!: (value: { port: number; token: string; pid: number }) => void,
			fail!: (error: unknown) => void;
		const announced = new Promise<{ port: number; token: string; pid: number }>((yes, no) => {
			ready = yes;
			fail = no;
		});
		const owned = Bun.spawn(
			[process.execPath, resolve(import.meta.dir, "../routes/editor-host-cold.fixture.ts")],
			{
				cwd: resolve(import.meta.dir, "../.."),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					NARRAFORK_HOME: join(home, ".narrafork"),
					NARRAFORK_TEST: "1",
					NARRAFORK_ALLOW_MULTIPLE: "1",
					NF_READ_BACKEND: "sqlite",
					NF_WRITE_BACKEND: "sqlite",
					XDG_CACHE_HOME: join(home, "cache"),
				},
			},
		);
		child = owned;
		owned.stdin.write(JSON.stringify(config));
		owned.stdin.end();
		hostReaders = [
			drain(owned.stdout, (line) => {
				if (line.startsWith("EDITOR_HOST_READY ")) ready(JSON.parse(line.slice(18)));
			}),
			drain(owned.stderr),
		].map((task) =>
			task.catch((error) => {
				logFailure = error;
				fail(error);
				owned.kill();
			}),
		);
		void owned.exited.then((code) => fail(new Error(`Host exited ${code}: ${logs}`)));
		const timer = setTimeout(() => {
			fail(new Error(`Host startup timed out: ${logs}`));
			owned.kill();
		}, 30_000);
		try {
			const result = await announced;
			config.port = result.port;
			auth = result.token;
			origin = `http://127.0.0.1:${result.port}`;
			pids.push(result.pid);
			return result;
		} finally {
			clearTimeout(timer);
		}
	}
	async function stopHost() {
		const owned = child;
		child = undefined;
		if (!owned) return;
		owned.kill("SIGKILL");
		await owned.exited;
		await Promise.all(hostReaders);
	}
	async function request(path: string, init: RequestInit = {}) {
		return fetch(`${origin}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${auth}`, ...init.headers },
			signal: AbortSignal.timeout(30_000),
		});
	}
	const info = async (): Promise<Info> => {
		const response = await request("/fixture-info");
		expect(response.ok).toBe(true);
		return response.json();
	};
	async function waitOnline() {
		const deadline = Date.now() + 15_000;
		for (;;) {
			if ((await info()).online) return;
			if (Date.now() >= deadline || peer?.exitCode !== null)
				throw new Error(`Peer failed to connect: ${logs}`);
			await Bun.sleep(10);
		}
	}
	async function fault(mode: string) {
		const response = await request(`/fixture-fault?mode=${mode}`, { method: "POST" });
		expect(response.ok).toBe(true);
		await response.body?.cancel();
	}
	const endpoint = `/api/narrators/${config.narratorId}`;
	async function save(bytes: Uint8Array, revision: number) {
		const opened = await request(`${endpoint}/editor-documents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: target,
				deviceId: config.remote.deviceId,
				origin: "legacy",
				protocol: "raw-v2",
				encodingHint: "utf-8",
			}),
		});
		expect(opened.ok).toBe(true);
		const document = (await opened.json()) as EditorRawDocumentDescriptor;
		expect(document.capabilities).toMatchObject({ rawSave: true, durableApply: true });
		const created = await request(`${endpoint}/editor-documents/${document.docId}/uploads`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				protocol: "raw-v2",
				hashKind: "raw-sha256",
				encoding: "utf-8",
				bom: "none",
				baseHash: document.baseHash,
				snapshotRevision: revision,
			}),
		});
		expect(created.ok).toBe(true);
		const upload = (await created.json()) as EditorUploadDescriptor;
		for (let offset = 0, seq = 0; offset < bytes.length; offset += 65536, seq++) {
			const part = bytes.slice(offset, offset + 65536);
			const response = await request(
				`${endpoint}/editor-documents/${document.docId}/uploads/${upload.uploadId}/chunks/${seq}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/octet-stream",
						"x-editor-offset": String(offset),
						"x-editor-bytes": String(part.length),
						"x-editor-digest": hash(part),
					},
					body: Uint8Array.from(part),
				},
			);
			expect(response.ok).toBe(true);
			await response.body?.cancel();
		}
		const seal = {
			protocol: "raw-v2",
			hashKind: "raw-sha256",
			bytes: bytes.length,
			rawDigest: hash(bytes),
			textDigest: hash(bytes),
			formatDigest: hash(new Uint8Array()),
			textLength: bytes.length,
			newlines: 0,
		};
		const sealed = await request(
			`${endpoint}/editor-documents/${document.docId}/uploads/${upload.uploadId}/seal`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(seal),
			},
		);
		expect(sealed.ok).toBe(true);
		await sealed.body?.cancel();
		const committed = await request(
			`${endpoint}/editor-documents/${document.docId}/uploads/${upload.uploadId}/commit`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		const body = (await committed.json()) as EditorSaveResult & {
			code?: string;
			data?: { operationId?: string };
		};
		await request(`${endpoint}/editor-documents/${document.docId}`, { method: "DELETE" });
		if (!upload.operationId) throw new Error("Missing pre-dispatch operation identity");
		return { operationId: upload.operationId, ok: committed.ok, body };
	}
	async function query(operationId: string) {
		const response = await request(`${endpoint}/editor-operations/${operationId}`);
		if (!response.ok) {
			const reader = response.body?.getReader();
			let body = "";
			try {
				const chunk = await reader?.read();
				if (chunk?.value) body = new TextDecoder().decode(chunk.value.subarray(0, 4096));
			} finally {
				await reader?.cancel();
				reader?.releaseLock();
			}
			throw new Error(`Operation query failed (${response.status}): ${body}\n${logs}`);
		}
		return (await response.json()) as EditorOperationResult;
	}
	try {
		await expect(lstat(join(home, ".narrafork", "editor-native-operations"))).rejects.toMatchObject(
			{ code: "ENOENT" },
		);
		await expect(lstat(join(home, ".narrafork", "bin", "distribution"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await readFile(binary); // Existing controlled build is required; no test-time install/build.
		await startHost();
		peer = Bun.spawn(
			[
				binary,
				"--server",
				`ws://127.0.0.1:${config.port}/ws/device`,
				"--device",
				config.remote.deviceId,
				"--token-stdin",
				"--cwd",
				workspace,
				"--allow-root",
				workspace,
				"--disable-shell",
			],
			{
				cwd: root,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH,
					HOME: peerHome,
					USERPROFILE: peerHome,
					XDG_CACHE_HOME: join(peerHome, "cache"),
					LOCALAPPDATA: join(peerHome, "cache"),
					LANG: "C.UTF-8",
				},
			},
		);
		peer.stdin.write(`${peerToken}\n`);
		peer.stdin.end();
		peerReaders = [drain(peer.stdout), drain(peer.stderr)].map((task) =>
			task.catch((error) => {
				logFailure = error;
				peer?.kill();
			}),
		);
		await waitOnline();
		if (scenario === "terminal-and-ack") {
			const content = Buffer.alloc(20 * 1024 * 1024, 65);
			const first = await save(content, Number.MAX_SAFE_INTEGER);
			expect(first.ok).toBe(true);
			expect(first.body).toMatchObject({
				status: "saved",
				hashKind: "raw-sha256",
				hash: hash(content),
				snapshotRevision: Number.MAX_SAFE_INTEGER,
			});
			const savedInfo = await info();
			expect(
				savedInfo.operations,
				`Cold recovery requires SQLite evidence: ${JSON.stringify(first.body)}\n${logs}`,
			).toContainEqual(
				expect.objectContaining({
					sourceId: first.operationId,
					snapshotRevision: Number.MAX_SAFE_INTEGER,
				}),
			);
			expect(savedInfo.nativeCalls).toMatchObject({
				apply: 1,
				query: 0,
				ack: 1,
				helperStarts: 0,
				network: 0,
			});
			await fault("ack");
			const tiny = await save(Buffer.from("abc"), 23);
			expect(tiny.ok).toBe(true);
			const beforeQuery = await info();
			expect(await query(tiny.operationId)).toMatchObject({
				status: "saved",
				result: { snapshotRevision: 23 },
			});
			const afterQuery = await info();
			expect(afterQuery.nativeCalls.apply).toBe(2);
			expect(afterQuery.nativeCalls.query).toBe(0);
			expect(afterQuery.nativeCalls.ack).toBe(beforeQuery.nativeCalls.ack + 1);
			const empty = await save(new Uint8Array(), 24);
			expect(empty.ok).toBe(true);
			expect(await readFile(target)).toHaveLength(0);
			const purge = await request("/fixture-purge-worker-meta", { method: "POST" });
			expect(purge.ok).toBe(true);
			await purge.body?.cancel();
			await stopHost();
			await startHost();
			await waitOnline();
			expect(await query(first.operationId)).toMatchObject({
				status: "saved",
				result: {
					hash: hash(content),
					bytes: content.length,
					snapshotRevision: Number.MAX_SAFE_INTEGER,
				},
			});
			expect((await info()).nativeCalls).toMatchObject({
				apply: 0,
				query: 0,
				helperStarts: 0,
				network: 0,
			});
		} else {
			await fault(scenario === "lost-apply-cold" ? "lost-apply" : "settlement");
			const bytes = Buffer.from("written"),
				saved = await save(bytes, 37);
			// The real IO outcome is reported separately from history: a lost reply is
			// unknown, while a history failure after a committed receipt is still a save.
			if (scenario === "settlement-cold")
				expect(saved.body).toMatchObject({
					status: "saved",
					diskOutcome: "applied",
					historyStatus: "unavailable",
				});
			else expect(saved.ok).toBe(false);
			expect(await readFile(target)).toEqual(bytes);
			await waitOnline();
			const pending = await info();
			expect(pending.nativeCalls.apply).toBe(1);
			if (scenario === "settlement-cold")
				expect(pending.operations[0]?.settlement).not.toBe("settled");
			// No workspace barrier and no fabricated lease: the exact executor operation is the key.
			expect(pending.leases).toEqual([]);
			expect(pending.operations[0]?.workspaceLeaseId).toBeNull();
			expect(pending.operations[0]?.snapshotRevision).toBe(37);
			for (const mode of ["not_found", "uncertain"]) {
				await fault(mode);
				expect(await query(saved.operationId)).toMatchObject({ status: "uncertain" });
				expect((await info()).leases).toEqual(pending.leases);
			}
			const purge = await request("/fixture-purge-worker-meta", { method: "POST" });
			expect(purge.ok).toBe(true);
			await purge.body?.cancel();
			await stopHost();
			await startHost();
			await waitOnline();
			await fault("ack");
			expect(await query(saved.operationId)).toMatchObject({
				status: "saved",
				result: { hash: hash(bytes), snapshotRevision: 37 },
			});
			const settled = await info();
			expect(settled.nativeCalls).toMatchObject({
				apply: 0,
				query: 1,
				ack: 1,
				helperStarts: 0,
				network: 0,
			});
			expect(settled.leases).toEqual([]);
			await stopHost();
			await startHost();
			await waitOnline();
			// The recorded effect stays immutably unknown; each cold query re-reads the
			// executor's retained exact-op receipt and never reapplies.
			expect(await query(saved.operationId)).toMatchObject({
				status: "saved",
				result: { snapshotRevision: 37 },
			});
			expect((await info()).nativeCalls).toMatchObject({ apply: 0, query: 1, ack: 1 });
			const next = await save(Buffer.from("next"), 38);
			expect(next.ok).toBe(true);
			expect((await info()).nativeCalls.apply).toBe(1);
			await rename(workspace, `${workspace}-retired`);
			const changed = await request("/fixture-change-root", { method: "POST" });
			expect(changed.ok).toBe(true);
			await changed.body?.cancel();
			expect(await query(saved.operationId)).toMatchObject({
				status: "saved",
				result: { hash: hash(bytes), snapshotRevision: 37 },
			});
			const revoked = await request("/fixture-revoke", { method: "POST" });
			expect(revoked.ok).toBe(true);
			await revoked.body?.cancel();
			const denied = await request(`${endpoint}/editor-operations/${saved.operationId}`);
			expect(denied.status).toBe(403);
			await denied.body?.cancel();
		}
		const final = await info();
		expect(final.nativeCalls.helperStarts).toBe(0);
		expect(final.nativeCalls.network).toBe(0);
		await expect(lstat(join(home, ".narrafork", "editor-native-operations"))).rejects.toMatchObject(
			{ code: "ENOENT" },
		);
		await expect(lstat(join(home, ".narrafork", "bin", "distribution"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		if (logFailure) throw logFailure;
		console.info(
			"EDITOR_REMOTE_PERSISTENCE",
			JSON.stringify({
				scenario,
				platform: process.platform,
				arch: process.arch,
				hostProcesses: pids,
				operations: final.operations.length,
				calls: final.nativeCalls,
				noReapply: true,
				sqliteSnapshotAfterWorkerRemoval: true,
			}),
		);
	} finally {
		peer?.kill();
		await peer?.exited;
		await Promise.all(peerReaders);
		await stopHost();
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);
