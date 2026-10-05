import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "@server/lib/settings";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeIdentity,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import iconv from "iconv-lite";
import { FileChangeBlobStore } from "./file-change-blob-store";
import {
	FileChangeReversalCalculator,
	type FileChangeReversalDependencies,
	type FileChangeReversalEffect,
	type FileChangeReversalInput,
	type FileChangeReversalResult,
} from "./file-change-reversal";

let sandbox: string;
let mergeRoot: string;
let store: FileChangeBlobStore;
let identity: FileChangeIdentity;
let counter: number;
let publishes: number;
const SENTINEL = Buffer.from("user-owned file must never be touched\r\n");
const absent: FileChangeState = { kind: "absent" };
const unknown: FileChangeState = { kind: "unknown", reason: "result_unknown" };

beforeEach(async () => {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Isolated test preload required");
	sandbox = await mkdtemp(join(await realpath(tmpdir()), "file-reversal-test-"));
	mergeRoot = join(sandbox, "merge");
	await mkdir(mergeRoot, { mode: 0o700 });
	const userPath = join(sandbox, "user.txt");
	await writeFile(userPath, SENTINEL);
	identity = {
		sourceInstanceId: "source",
		deviceId: "local",
		workspaceInstanceId: "workspace",
		scopeId: "scope",
		pathFlavor: process.platform === "win32" ? "windows" : "posix",
		objectRole: "entry",
		canonicalPath: userPath,
		lexicalPath: userPath,
		displayPath: "user.txt",
	};
	store = new FileChangeBlobStore({ root: join(sandbox, "blobs"), minimumFreeBytes: 0 });
	counter = 0;
	publishes = 0;
});

afterEach(async () => {
	try {
		expect(await readFile(identity.canonicalPath)).toEqual(SENTINEL);
		expect(await readdir(mergeRoot)).toEqual([]);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
});

function calculator(overrides: Partial<FileChangeReversalDependencies> = {}) {
	return new FileChangeReversalCalculator({
		readBlob: (ref, options) => store.readBytes(ref, options),
		publishBlob: (bytes, options) => {
			publishes++;
			return store.putBytes(bytes, options);
		},
		mergeOptions: { temporaryRoot: mergeRoot },
		...overrides,
	});
}

function refFor(bytes: Uint8Array): FileChangeBlobRef {
	return {
		algorithm: "sha256",
		digest: createHash("sha256").update(bytes).digest("hex"),
		sizeBytes: bytes.byteLength,
	};
}

async function regular(
	bytes: string | Uint8Array,
	mode: number | null = 0o644,
): Promise<Extract<FileChangeState, { kind: "regular" }>> {
	const raw = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
	return {
		kind: "regular",
		blob: await store.putBytes(raw, { expectedSize: raw.byteLength }),
		mode,
	};
}

function effect(
	before: FileChangeState,
	after: FileChangeState,
	scopeRevision = ++counter,
	file = identity,
): FileChangeReversalEffect {
	const id = `effect-${++counter}`;
	const mutationId = `mutation-${id}`;
	const requestDigest = createHash("sha256").update(id).digest("hex");
	return {
		id,
		operationId: `operation-${id}`,
		attempt: 1,
		mutationId,
		requestDigest,
		phase: "apply",
		identity: { ...file },
		scopeRevision,
		before,
		intendedAfter: after,
		observedAfter: after,
		outcome: fileChangeStatesEqual(before, after) ? "no_change" : "changed",
		settlement: "settled",
		attribution: "measured",
		executionConfirmed: true,
		executionReceipt: {
			receiptId: `receipt-${id}`,
			mutationId,
			requestDigest,
			confirmed: true,
			outcome: "applied",
			observedAfter: after,
			executionBinding: {
				deviceId: file.deviceId,
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: scopeRevision,
			},
		},
		linesAdded: null,
		linesRemoved: null,
	};
}

function success(result: FileChangeReversalResult) {
	if (!result.ok) throw new Error(`Unexpected refusal: ${result.reason}`);
	return result;
}

async function desiredBytes(result: FileChangeReversalResult): Promise<Buffer> {
	const desired = success(result).desired;
	if (desired.kind !== "regular") throw new Error("Expected a regular desired state");
	return Buffer.from(await store.readBytes(desired.blob));
}

function text(a = "base-a", human = "base-human", b = "base-b", end = "base-end", newline = "\n") {
	return [
		a,
		"context 1",
		"context 2",
		"context 3",
		"context 4",
		human,
		"context 5",
		"context 6",
		"context 7",
		"context 8",
		b,
		"context 9",
		"context 10",
		"context 11",
		"context 12",
		end,
		"",
	].join(newline);
}

async function chain() {
	const base = await regular(text());
	const a = await regular(text("actor-a"));
	const human = await regular(text("actor-a", "human"));
	const b = await regular(text("actor-a", "human", "actor-b"));
	return { base, a, human, b, first: effect(base, a, 10), second: effect(human, b, 30) };
}

describe("raw per-file reverse deltas", () => {
	test("A -> human different hunk -> B: undo B, then A preserves human bytes", async () => {
		const fixture = await chain();
		const core = calculator();
		const undoB = success(
			await core.calculate({ identity, current: fixture.b, effects: [fixture.second] }),
		);
		expect(undoB.desired).toEqual(fixture.human);
		expect(undoB.steps[0]?.method).toBe("restore_before");
		const undoA = await core.calculate({
			identity,
			current: undoB.desired,
			effects: [fixture.first],
		});
		expect(await desiredBytes(undoA)).toEqual(Buffer.from(text("base-a", "human")));
		expect(success(undoA).steps[0]?.method).toBe("merge");
		expect(publishes).toBe(1);
	});

	test("shuffled/duplicate selection uses actual revision, preserving intermediate and late external hunks", async () => {
		const f = await chain();
		// IDs intentionally say nothing about chronology; timestamps are not accepted.
		const current = await regular(text("actor-a", "human", "actor-b", "late-human"));
		const result = await calculator().calculate({
			identity,
			current,
			effects: [f.first, f.second, structuredClone(f.first)],
		});
		expect(await desiredBytes(result)).toEqual(
			Buffer.from(text("base-a", "human", "base-b", "late-human")),
		);
		expect(success(result).steps.map((step) => step.scopeRevision)).toEqual([30, 10]);
		expect(publishes).toBe(1);
	});

	test("two files each use their own before, not a union's earliest baseline", async () => {
		const f = await chain();
		const secondIdentity = {
			...identity,
			canonicalPath: join(sandbox, "other.txt"),
			lexicalPath: join(sandbox, "other.txt"),
			displayPath: "other.txt",
		};
		const theirBaseline = await regular("other actor's baseline\r\n");
		const otherAfter = await regular("selected mutation\r\n");
		const otherEffect = effect(theirBaseline, otherAfter, 40, secondIdentity);
		const core = calculator();
		const one = await core.calculate({ identity, current: f.human, effects: [f.first] });
		const two = await core.calculate({
			identity: secondIdentity,
			current: otherAfter,
			effects: [otherEffect],
		});
		expect(await desiredBytes(one)).toEqual(Buffer.from(text("base-a", "human")));
		expect(success(two).desired).toEqual(theirBaseline);
	});

	test("same revision distinct changes is order_unverified; duplicate mutation aliases are refused", async () => {
		const f = await chain();
		const core = calculator();
		expect(
			await core.calculate({
				identity,
				current: f.b,
				effects: [f.first, { ...f.second, scopeRevision: 10 }],
			}),
		).toMatchObject({ ok: false, reason: "order_unverified" });
		expect(
			await core.calculate({
				identity,
				current: f.a,
				effects: [f.first, { ...f.first, id: "alias" }],
			}),
		).toMatchObject({ ok: false, reason: "duplicate_unverified" });
		expect(
			await core.calculate({
				identity,
				current: f.a,
				effects: [f.first, { ...f.first, scopeRevision: 11 }],
			}),
		).toMatchObject({ ok: false, reason: "duplicate_unverified" });
		expect(publishes).toBe(0);
	});
});

describe("explicit historical snapshot recovery", () => {
	test("text merge conflict is refused by default; snapshot restores earliest selected before", async () => {
		const before = await regular("baseline\r\n");
		const firstAfter = await regular("selected one\r\n");
		const secondBefore = await regular("human between selected changes\r\n");
		const secondAfter = await regular("selected two\r\n");
		const current = await regular("human after selected changes\r\n");
		const first = effect(before, firstAfter, 10);
		const second = effect(secondBefore, secondAfter, 30);
		const noChange = effect(current, current, 40);
		const input = { identity, current, effects: [first, noChange, second] };
		expect(await calculator().calculate(input)).toMatchObject({
			ok: false,
			reason: "merge_conflict",
		});
		const result = success(await calculator().calculate({ ...input, recoveryMode: "snapshot" }));
		expect(result.expected).toEqual(current);
		expect(result.desired).toEqual(before);
		expect(result.steps.map(({ scopeRevision, method }) => [scopeRevision, method])).toEqual([
			[40, "no_change"],
			[30, "restore_snapshot"],
			[10, "restore_snapshot"],
		]);
		expect(await desiredBytes(result)).toEqual(Buffer.from("baseline\r\n"));
		expect(publishes).toBe(0);
	});

	test.each([
		{
			name: "binary",
			bytes: Buffer.from([0x81, 0x40, 0, 13, 10]),
			mode: 0o751,
			reason: "state_conflict",
		},
		{
			name: "GBK",
			bytes: iconv.encode("原始内容\r\n", "gbk"),
			mode: 0o644,
			reason: "merge_conflict",
		},
	])("snapshot restores original %s raw bytes/mode despite divergent current state", async ({
		bytes,
		mode,
		reason,
	}) => {
		const before = await regular(bytes, mode);
		const after = await regular("selected utf8\n");
		const current = await regular("external conflicting bytes\n", 0o600);
		const effects = [effect(before, after, 10)];
		expect(await calculator().calculate({ identity, current, effects })).toMatchObject({
			ok: false,
			reason,
		});
		const result = success(
			await calculator().calculate({ identity, current, effects, recoveryMode: "snapshot" }),
		);
		expect(result.desired).toEqual(before);
		expect(await desiredBytes(result)).toEqual(bytes);
		expect(result.steps[0].method).toBe("restore_snapshot");
		expect(publishes).toBe(0);
	});

	test("snapshot respects absent baseline; no-change-only selection preserves current", async () => {
		const after = await regular("created\n");
		const current = await regular("human changed created file\n");
		const changed = effect(absent, after, 10);
		expect(
			success(
				await calculator().calculate({
					identity,
					current,
					effects: [changed],
					recoveryMode: "snapshot",
				}),
			).desired,
		).toEqual(absent);
		const noChange = effect(after, after, 20);
		expect(
			success(
				await calculator().calculate({
					identity,
					current,
					effects: [noChange],
					recoveryMode: "snapshot",
				}),
			).desired,
		).toEqual(current);
	});

	test("snapshot still rejects missing/corrupt blobs, unmeasured effects and identity changes", async () => {
		const before = await regular("original\n");
		const after = await regular("selected\n");
		const current = await regular("conflicting\n");
		const selected = effect(before, after, 10);
		const input = { identity, current, effects: [selected], recoveryMode: "snapshot" as const };
		expect(
			await calculator({
				readBlob: async () => {
					throw new Error("missing");
				},
			}).calculate(input),
		).toMatchObject({ ok: false, reason: "blob_unavailable" });
		expect(
			await calculator({ readBlob: async (ref) => new Uint8Array(ref.sizeBytes) }).calculate(input),
		).toMatchObject({ ok: false, reason: "blob_integrity" });
		expect(
			await calculator().calculate({
				...input,
				effects: [{ ...selected, executionConfirmed: false }],
			}),
		).toMatchObject({ ok: false, reason: "effect_unverified" });
		expect(
			await calculator().calculate({
				...input,
				effects: [{ ...selected, identity: { ...identity, workspaceInstanceId: "other" } }],
			}),
		).toMatchObject({ ok: false, reason: "identity_mismatch" });
	});
});

describe("complete evidence before all shortcuts", () => {
	test("already-before is explicit but never conceals an unverified earlier effect", async () => {
		const f = await chain();
		const result = success(
			await calculator().calculate({ identity, current: f.base, effects: [f.first] }),
		);
		expect(result.changed).toBe(false);
		expect(result.steps[0]?.method).toBe("already_before");
		let reads = 0;
		const core = calculator({
			readBlob: async () => {
				reads++;
				throw new Error("not reached");
			},
		});
		const invalid = { ...f.first, executionReceipt: null };
		expect(
			await core.calculate({ identity, current: f.human, effects: [f.second, invalid] }),
		).toMatchObject({ ok: false, reason: "effect_unverified" });
		expect(reads).toBe(0);
	});

	test.each([
		["false precise", { executionConfirmed: false }],
		["missing receipt", { executionReceipt: undefined }],
		["null receipt", { executionReceipt: null }],
		["unsettled", { settlement: "applying" }],
		["reconciliation", { settlement: "reconcile_required" }],
		["ambiguous", { attribution: "observed_ambiguous" }],
		["unknown outcome", { outcome: "unknown" }],
		["unknown before", { before: unknown }],
		["unknown intended", { intendedAfter: unknown }],
		["unknown after", { observedAfter: unknown }],
	] as const)("%s cannot be repaired by current == intended", async (_label, patch) => {
		const f = await chain();
		const changed = { ...f.first, ...patch } as FileChangeReversalEffect;
		expect(
			await calculator().calculate({ identity, current: f.a, effects: [changed] }),
		).toMatchObject({ ok: false, reason: "effect_unverified" });
		expect(publishes).toBe(0);
	});

	test("receipt binds mutation, request, device, epoch and actual observation", async () => {
		const f = await chain();
		const original = f.first.executionReceipt;
		if (!original) throw new Error("fixture missing receipt");
		for (const patch of [
			{ mutationId: "different" },
			{ requestDigest: "a".repeat(64) },
			{ confirmed: false },
			{ outcome: "unknown" as const },
			{ outcome: "not_applied" as const },
			{ observedAfter: f.base },
			{ executionBinding: { ...original.executionBinding, deviceId: "remote" } },
			{ executionBinding: { ...original.executionBinding, runtimeGeneration: -1 } },
		]) {
			const invalid = { ...f.first, executionReceipt: { ...original, ...patch } };
			expect(
				await calculator().calculate({ identity, current: f.a, effects: [invalid] }),
			).toMatchObject({ ok: false, reason: "effect_unverified" });
		}
	});

	test("only confirmed not_applied permits unknown/ambiguous no-change, with no fabricated before", async () => {
		const current = await regular("actual current bytes\n");
		const item = effect(unknown, unknown, 0);
		item.outcome = "no_change";
		item.attribution = "unknown";
		if (!item.executionReceipt) throw new Error("fixture missing receipt");
		item.executionReceipt.outcome = "not_applied";
		const core = calculator();
		const result = success(await core.calculate({ identity, current, effects: [item] }));
		expect(result.desired).toEqual(current);
		expect(result.steps[0]?.method).toBe("no_change");
		item.executionReceipt.confirmed = false;
		expect(await core.calculate({ identity, current, effects: [item] })).toMatchObject({
			ok: false,
			reason: "effect_unverified",
		});
	});

	test("measured no-change may share a revision with a real change but must retain its receipt", async () => {
		const f = await chain();
		const noop = effect(f.a, f.a, 10);
		const result = await calculator().calculate({
			identity,
			current: f.a,
			effects: [f.first, noop],
		});
		expect(success(result).desired).toEqual(f.base);
		expect(success(result).steps).toHaveLength(2);
	});

	test.each([
		"sourceInstanceId",
		"deviceId",
		"workspaceInstanceId",
		"scopeId",
		"objectRole",
		"canonicalPath",
	] as const)("does not cross %s", async (field) => {
		const f = await chain();
		f.first.identity = {
			...identity,
			[field]:
				field === "objectRole"
					? "referent"
					: field === "canonicalPath"
						? join(sandbox, "different")
						: "different",
		};
		expect(
			await calculator().calculate({ identity, current: f.a, effects: [f.first] }),
		).toMatchObject({ ok: false, reason: "identity_mismatch" });
	});

	test("display/lexical aliases do not split identity; unknown current and invalid revision refuse", async () => {
		const f = await chain();
		f.first.identity = { ...identity, displayPath: "alias", lexicalPath: join(sandbox, "alias") };
		expect(
			success(await calculator().calculate({ identity, current: f.a, effects: [f.first] })).desired,
		).toEqual(f.base);
		expect(await calculator().calculate({ identity, current: unknown, effects: [] })).toMatchObject(
			{ ok: false, reason: "state_unknown" },
		);
		for (const revision of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
			expect(
				await calculator().calculate({
					identity,
					current: f.a,
					effects: [{ ...f.first, scopeRevision: revision as number }],
				}),
			).toMatchObject({ ok: false, reason: "order_unverified" });
		}
	});

	test("all blobs are required even when current is already before", async () => {
		const f = await chain();
		await rm(join(sandbox, "blobs", "sha256", f.a.blob.digest.slice(0, 2), f.a.blob.digest));
		expect(
			await calculator().calculate({ identity, current: f.base, effects: [f.first] }),
		).toMatchObject({ ok: false, reason: "blob_unavailable" });
	});

	test("read size/hash and published hash/ref alignment are checked independently", async () => {
		const f = await chain();
		for (const bytes of [new Uint8Array(f.a.blob.sizeBytes), new Uint8Array(1)]) {
			expect(
				await calculator({ readBlob: async () => bytes }).calculate({
					identity,
					current: f.a,
					effects: [f.first],
				}),
			).toMatchObject({ ok: false, reason: "blob_integrity" });
		}
		const badPublish = calculator({ publishBlob: async () => f.a.blob });
		expect(
			await badPublish.calculate({ identity, current: f.human, effects: [f.first] }),
		).toMatchObject({ ok: false, reason: "blob_integrity" });
		const phantom = calculator({ publishBlob: async (bytes) => refFor(bytes) });
		expect(
			await phantom.calculate({ identity, current: f.human, effects: [f.first] }),
		).toMatchObject({ ok: false, reason: "blob_unavailable" });
	});
});

describe("raw bytes, object types and mode", () => {
	test.each([
		["binary", new Uint8Array([0, 255, 128, 13, 10, 0, 192])],
		["CRLF", Buffer.from("first\r\nsecond\r\nlast\r")],
		["GBK", new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 13, 10, 0xca, 0xc0, 0xbd, 0xe7])],
	] as const)("%s exact roundtrip ignores current legacyEncoding", async (_label, bytes) => {
		const before = await regular(bytes);
		const after = await regular(new Uint8Array([...bytes, 33, 13, 10]));
		const selected = effect(before, after);
		for (const enabled of [true, false]) {
			settings.agent.legacyEncoding = enabled;
			const result = await calculator().calculate({
				identity,
				current: after,
				effects: [selected],
			});
			expect(await desiredBytes(result)).toEqual(Buffer.from(bytes));
			expect(success(result).desired).toEqual(before);
		}
		expect(publishes).toBe(0);
	});

	test.each([
		"CRLF",
		"GBK",
	] as const)("real Git reverse merge preserves %s bytes and unrelated changes", async (format) => {
		const raw = (a: string, human: string) =>
			Buffer.concat([
				format === "GBK" ? Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 13, 10]) : Buffer.alloc(0),
				Buffer.from(text(a, human, "base-b", "base-end", "\r\n")),
			]);
		const before = await regular(raw("base-a", "base-human"));
		const after = await regular(raw("actor-a", "base-human"));
		const current = await regular(raw("actor-a", "human"));
		const result = await calculator().calculate({
			identity,
			current,
			effects: [effect(before, after)],
		});
		expect(await desiredBytes(result)).toEqual(raw("base-a", "human"));
	});

	test("binary drift cannot use line merging, including NUL after Git's initial probe", async () => {
		for (const suffix of [Buffer.from([0]), Buffer.from([1, 255]), Buffer.from([127])]) {
			const large = Buffer.from(`${"context\n".repeat(1500)}`);
			const before = await regular(Buffer.concat([Buffer.from("before\n"), large, suffix]));
			const after = await regular(Buffer.concat([Buffer.from("after\n"), large, suffix]));
			const current = await regular(
				Buffer.concat([Buffer.from("after\n"), large, Buffer.from("external\n"), suffix]),
			);
			expect(
				await calculator().calculate({ identity, current, effects: [effect(before, after)] }),
			).toMatchObject({ ok: false, reason: "state_conflict" });
		}
	});

	test("conflict after an earlier successful merge publishes no partial desired blob", async () => {
		const f = await chain();
		const current = await regular(text("overlapping human edit", "human", "actor-b", "late-human"));
		const result = await calculator().calculate({
			identity,
			current,
			effects: [f.first, f.second],
		});
		expect(result).toMatchObject({ ok: false, reason: "merge_conflict", effectId: f.first.id });
		expect(publishes).toBe(0);
	});

	test("creation/deletion require exact object state or explicit already-before", async () => {
		const before = await regular("before\n");
		const other = await regular("new unrelated file\n");
		const create = effect(absent, before);
		const deletion = effect(before, absent);
		const core = calculator();
		expect(
			success(await core.calculate({ identity, current: before, effects: [create] })).desired,
		).toEqual(absent);
		expect(
			success(await core.calculate({ identity, current: absent, effects: [deletion] })).desired,
		).toEqual(before);
		expect(
			success(await core.calculate({ identity, current: absent, effects: [create] })).steps[0]
				?.method,
		).toBe("already_before");
		expect(await core.calculate({ identity, current: other, effects: [create] })).toMatchObject({
			ok: false,
			reason: "state_conflict",
		});
		expect(await core.calculate({ identity, current: other, effects: [deletion] })).toMatchObject({
			ok: false,
			reason: "state_conflict",
		});
	});

	test("symlink targets are raw objects, never decoded or passed to Git", async () => {
		const old = await regular(new Uint8Array([0xca, 0xc0, 47, 120]));
		const next = await regular("../elsewhere");
		const other = await regular("../third-party");
		const before: FileChangeState = { kind: "symlink", target: old.blob, mode: 0o777 };
		const after: FileChangeState = { kind: "symlink", target: next.blob, mode: 0o777 };
		const drift: FileChangeState = { kind: "symlink", target: other.blob, mode: 0o777 };
		const selected = effect(before, after);
		const core = calculator();
		expect(
			success(await core.calculate({ identity, current: after, effects: [selected] })).desired,
		).toEqual(before);
		expect(await core.calculate({ identity, current: drift, effects: [selected] })).toMatchObject({
			ok: false,
			reason: "state_conflict",
		});
		expect(await core.calculate({ identity, current: next, effects: [selected] })).toMatchObject({
			ok: false,
			reason: "state_conflict",
		});
		expect(publishes).toBe(0);
	});

	test("unchanged-mode text reversals preserve the current mode, including null", async () => {
		const f = await chain();
		for (const mode of [0o755, null]) {
			const current = { ...f.human, mode };
			const result = await calculator().calculate({ identity, current, effects: [f.first] });
			expect(await desiredBytes(result)).toEqual(Buffer.from(text("base-a", "human")));
			expect(success(result).desired).toMatchObject({ mode });
		}
	});

	test("a mode-changing effect requires the entire expected state, not only matching mode", async () => {
		const before = await regular(text(), 0o644);
		const after = await regular(text("actor-a"), 0o755);
		const selected = effect(before, after);
		const core = calculator();
		expect(
			success(await core.calculate({ identity, current: after, effects: [selected] })).desired,
		).toEqual(before);
		for (const current of [
			{ ...after, mode: 0o700 },
			await regular(text("actor-a", "human"), 0o755),
		]) {
			expect(await core.calculate({ identity, current, effects: [selected] })).toMatchObject({
				ok: false,
				reason: "state_conflict",
			});
		}
	});
});

describe("stable inputs and actual private IO lifetime", () => {
	test("maximum-count snapshots do not serialize the potentially large history before yielding", async () => {
		const longPath = join(sandbox, "x".repeat(2000));
		const largeIdentity = {
			...identity,
			canonicalPath: longPath,
			lexicalPath: longPath,
			displayPath: "x".repeat(2000),
		};
		const effects = Array.from({ length: FILE_CHANGE_LIMITS.historyToolRelatedChanges }, () =>
			effect(absent, absent, 0, largeIdentity),
		);
		const core = calculator();
		const abort = new AbortController();
		const stringify = spyOn(JSON, "stringify");
		let pending: Promise<FileChangeReversalResult>;
		try {
			pending = core.calculate({
				identity: largeIdentity,
				current: absent,
				effects,
				signal: abort.signal,
			});
			// Only the one input identity and scope are serialized synchronously. The
			// 10000 x ~6 KiB effect payload is checked later in yielding batches.
			expect(stringify.mock.calls.length).toBeLessThanOrEqual(10);
		} finally {
			abort.abort();
			stringify.mockRestore();
		}
		expect(await pending).toEqual({ ok: false, reason: "cancelled" });
	});

	test.each([0, -1, 1.5])("attempt %s cannot authorize a reverse delta", async (attempt) => {
		const f = await chain();
		const result = await calculator().calculate({
			identity,
			current: f.a,
			effects: [{ ...f.first, attempt }],
		});
		expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	test("queued identity, current, receipts and selected effects are captured before admission wait", async () => {
		const f = await chain();
		const started = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let gated = false;
		const core = calculator({
			readBlob: async (ref, options) => {
				if (!gated) {
					gated = true;
					started.resolve();
					await gate.promise;
				}
				return store.readBytes(ref, options);
			},
		});
		const occupant = core.calculate({ identity, current: f.a, effects: [f.first] });
		await started.promise;
		const movingIdentity = { ...identity };
		const movingCurrent = structuredClone(f.b);
		const movingEffects = structuredClone([f.first, f.second]);
		const request: FileChangeReversalInput = {
			identity: movingIdentity,
			current: movingCurrent,
			effects: movingEffects,
		};
		const queued = core.calculate(request);
		try {
			movingIdentity.scopeId = "changed-scope";
			movingIdentity.workspaceInstanceId = "changed-workspace";
			movingCurrent.mode = 0o777;
			movingCurrent.blob.digest = f.base.blob.digest;
			const first = movingEffects[0];
			const second = movingEffects[1];
			if (!first || !second?.executionReceipt) throw new Error("fixture missing effects");
			first.before = unknown;
			second.executionReceipt.executionBinding.deviceId = "changed-device";
			movingEffects.splice(1, 1);
			request.effects = [];
			request.current = absent;
		} finally {
			gate.resolve();
		}
		expect(success(await occupant).desired).toEqual(f.base);
		const result = success(await queued);
		expect(result.identity).toEqual(identity);
		expect(result.expected).toEqual(f.b);
		expect(result.steps.map((step) => step.scopeRevision)).toEqual([30, 10]);
		expect(await desiredBytes(result)).toEqual(Buffer.from(text("base-a", "human")));
	});

	test.each([
		"nested effect",
		"replace entry",
		"truncate array",
		"replace array",
	] as const)("prepare yields cannot observe caller %s mutation", async (mutation) => {
		const effects = Array.from({ length: FILE_CHANGE_LIMITS.historyPageItems + 1 }, () =>
			effect(absent, absent, 0),
		);
		const request: FileChangeReversalInput = { identity, current: absent, effects };
		const pending = calculator().calculate(request);
		// Runs after admission's await and before prepare's first setImmediate yield.
		queueMicrotask(() => {
			const last = effects[effects.length - 1];
			if (!last) throw new Error("fixture missing last effect");
			if (mutation === "nested effect") last.executionConfirmed = false;
			if (mutation === "replace entry") effects[effects.length - 1] = { ...last, before: unknown };
			if (mutation === "truncate array") effects.length = 0;
			if (mutation === "replace array") request.effects = [];
		});
		const result = success(await pending);
		expect(result.steps).toHaveLength(FILE_CHANGE_LIMITS.historyPageItems + 1);
		expect(result.changed).toBe(false);
	});

	test("successive timeouts cannot release two genuinely unfinished reads; late settlement unlocks only its scope", async () => {
		const current = await regular("private IO gate\n");
		const held = [Promise.withResolvers<Uint8Array>(), Promise.withResolvers<Uint8Array>()];
		let reads = 0;
		const core = calculator({
			timeoutMs: 200,
			readBlob: (ref, options) => {
				const pending = held[reads++];
				return pending ? pending.promise : store.readBytes(ref, options);
			},
		});
		const other = { ...identity, scopeId: "second", workspaceInstanceId: "second" };
		try {
			const initial = await Promise.all(
				[identity, other].map((file) => core.calculate({ identity: file, current, effects: [] })),
			);
			for (const result of initial) expect(result).toEqual({ ok: false, reason: "timeout" });
			expect(reads).toBe(2);
			const retries = await Promise.all(
				Array.from({ length: 5 }, (_, index) =>
					core.calculate({
						identity: {
							...identity,
							scopeId: `retry-${index}`,
							workspaceInstanceId: `retry-${index}`,
						},
						current,
						effects: [],
					}),
				),
			);
			for (const result of retries) expect(result).toEqual({ ok: false, reason: "timeout" });
			expect(reads).toBe(2);
			const resumed = core.calculate({ identity, current, effects: [] });
			held[0]?.resolve(await store.readBytes(current.blob));
			expect(success(await resumed).desired).toEqual(current);
			expect(reads).toBe(3);
			expect(await core.calculate({ identity: other, current, effects: [] })).toEqual({
				ok: false,
				reason: "timeout",
			});
			expect(reads).toBe(3);
		} finally {
			for (const pending of held) pending.reject(new Error("test private IO settled"));
		}
	});

	test("cancelled publication retains its scope until the provider actually settles", async () => {
		const f = await chain();
		const started = Promise.withResolvers<void>();
		const held = Promise.withResolvers<FileChangeBlobRef>();
		const abort = new AbortController();
		let output: Uint8Array | undefined;
		let reads = 0;
		const core = calculator({
			timeoutMs: 200,
			readBlob: (ref, options) => {
				reads++;
				return store.readBytes(ref, options);
			},
			publishBlob: (bytes) => {
				output = bytes;
				started.resolve();
				return held.promise;
			},
		});
		try {
			const pending = core.calculate({
				identity,
				current: f.human,
				effects: [f.first],
				signal: abort.signal,
			});
			await started.promise;
			abort.abort();
			expect(await pending).toEqual({ ok: false, reason: "cancelled" });
			const beforeProbe = reads;
			expect(await core.calculate({ identity, current: f.a, effects: [] })).toEqual({
				ok: false,
				reason: "timeout",
			});
			expect(reads).toBe(beforeProbe);
			if (!output) throw new Error("fixture missing merge output");
			const resumed = core.calculate({ identity, current: f.a, effects: [] });
			held.resolve(await store.putBytes(output, { expectedSize: output.byteLength }));
			expect(success(await resumed).desired).toEqual(f.a);
		} finally {
			held.reject(new Error("test publication settled"));
		}
	});
});

describe("bounded admission and cancellation", () => {
	test("effect count, single-blob size and total evidence budgets reject before reads", async () => {
		const f = await chain();
		let reads = 0;
		const core = calculator({
			readBlob: async () => {
				reads++;
				throw new Error("must not read");
			},
		});
		expect(
			await core.calculate({
				identity,
				current: f.a,
				effects: Array(FILE_CHANGE_LIMITS.historyToolRelatedChanges + 1).fill(f.first),
			}),
		).toMatchObject({ ok: false, reason: "budget_exceeded" });
		const tooLarge = { ...f.a, blob: { ...f.a.blob, sizeBytes: FILE_CHANGE_LIMITS.blobBytes + 1 } };
		expect(await core.calculate({ identity, current: tooLarge, effects: [] })).toMatchObject({
			ok: false,
			reason: "budget_exceeded",
		});
		const large = (number: number): FileChangeState => ({
			kind: "regular",
			mode: 0o644,
			blob: {
				algorithm: "sha256",
				digest: number.toString(16).padStart(64, "0"),
				sizeBytes: FILE_CHANGE_LIMITS.blobBytes,
			},
		});
		const effects = Array.from({ length: 5 }, (_, n) =>
			effect(large(n * 2 + 1), large(n * 2 + 2), n),
		);
		expect(await core.calculate({ identity, current: absent, effects })).toMatchObject({
			ok: false,
			reason: "budget_exceeded",
		});
		expect(reads).toBe(0);
	});

	test("same digest with inconsistent size fails before IO", async () => {
		const f = await chain();
		const inconsistent = { ...f.a, blob: { ...f.a.blob, sizeBytes: f.a.blob.sizeBytes + 1 } };
		expect(
			await calculator().calculate({ identity, current: inconsistent, effects: [f.first] }),
		).toMatchObject({ ok: false, reason: "blob_integrity" });
	});

	test("pre-abort and in-flight read cancellation cannot return a desired state", async () => {
		const f = await chain();
		const pre = new AbortController();
		pre.abort();
		expect(
			await calculator().calculate({
				identity,
				current: f.a,
				effects: [f.first],
				signal: pre.signal,
			}),
		).toEqual({ ok: false, reason: "cancelled" });
		const abort = new AbortController();
		const started = Promise.withResolvers<void>();
		const core = calculator({
			readBlob: async (_ref, { signal }) => {
				started.resolve();
				return new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				);
			},
		});
		const result = core.calculate({
			identity,
			current: f.a,
			effects: [f.first],
			signal: abort.signal,
		});
		await started.promise;
		abort.abort();
		expect(await result).toEqual({ ok: false, reason: "cancelled" });
		expect(publishes).toBe(0);
	});

	test("deadline bounds a stalled blob callback and cancellation after publish still refuses", async () => {
		const f = await chain();
		const core = calculator({
			timeoutMs: 10,
			readBlob: async (_ref, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
				}),
		});
		expect(await core.calculate({ identity, current: f.a, effects: [f.first] })).toEqual({
			ok: false,
			reason: "timeout",
		});
		const abort = new AbortController();
		const late = calculator({
			publishBlob: async (bytes, options) => {
				const ref = await store.putBytes(bytes, options);
				abort.abort();
				return ref;
			},
		});
		expect(
			await late.calculate({
				identity,
				current: f.human,
				effects: [f.first],
				signal: abort.signal,
			}),
		).toEqual({ ok: false, reason: "cancelled" });
	});

	test("a reused instance limits active scopes to two, serializes same-scope and bounds the queue", async () => {
		const current = await regular("read gate\n");
		const started = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		let totalReads = 0;
		const core = calculator({
			readBlob: async (_ref, { signal }) => {
				active++;
				peak = Math.max(peak, active);
				if (++totalReads === FILE_CHANGE_LIMITS.captureConcurrency) started.resolve();
				try {
					return await new Promise<Uint8Array>((_resolve, reject) =>
						signal.addEventListener("abort", () => reject(new Error("done")), { once: true }),
					);
				} finally {
					active--;
				}
			},
		});
		const controllers: AbortController[] = [];
		const run = (file: FileChangeIdentity) => {
			const abort = new AbortController();
			controllers.push(abort);
			return core.calculate({ identity: file, current, effects: [], signal: abort.signal });
		};
		const pending = [
			run(identity),
			run({ ...identity, scopeId: "other-scope", workspaceInstanceId: "other-workspace" }),
		];
		await started.promise;
		for (let n = 0; n < FILE_CHANGE_LIMITS.captureQueueItems; n++)
			pending.push(run({ ...identity, canonicalPath: join(sandbox, `same-scope-${n}`) }));
		expect(await core.calculate({ identity, current, effects: [] })).toEqual({
			ok: false,
			reason: "queue_full",
		});
		expect(totalReads).toBe(2);
		expect(peak).toBe(FILE_CHANGE_LIMITS.captureConcurrency);
		for (const controller of controllers) controller.abort();
		for (const result of await Promise.all(pending))
			expect(result).toEqual({ ok: false, reason: "cancelled" });
		expect(active).toBe(0);
	});
});
