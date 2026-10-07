import { describe, expect, test } from "bun:test";
import type { FileChangeIdentity } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBackend,
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryOperation,
	RemoteHistoryOperations,
	RemoteHistoryReceipt,
	RemoteHistoryRequest,
	RemoteHistoryState,
} from "@shared/remote-history-protocol";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { RemoteFileChangeRuntime } from "./remote-file-change-runtime";
import {
	isRemoteHistoryNoDispatchError,
	type RemoteHistoryJournal,
	RemoteHistoryNoDispatchError,
	RemoteHistoryService,
	RemoteHistoryUncertainError,
	remoteHistoryDigest,
	remoteHistoryObjectId,
} from "./remote-history-service";
import {
	type RemoteRecoveryAuthority,
	recoverRemoteWorkspaceOperations,
} from "./workspace-remote-recovery";

const binding: RemoteHistoryBinding = {
	sourceInstanceId: "source",
	workspaceInstanceId: "workspace",
	scopeId: "scope",
	root: "/selected/repo",
	rootIdentity: "disk:inode",
	fence: 9,
};
const digest = "a".repeat(64);
const identity: FileChangeIdentity = {
	sourceInstanceId: "source",
	workspaceInstanceId: "workspace",
	scopeId: "scope",
	deviceId: "remote",
	canonicalPath: "/selected/repo/file.txt",
	lexicalPath: "/selected/repo/file.txt",
	displayPath: "file.txt",
	pathFlavor: "posix",
	objectRole: "referent",
};

function fixture() {
	const events: string[] = [];
	const objects: RemoteHistoryObject[] = [];
	const intents: RemoteHistoryRequest[] = [];
	let state: RemoteHistoryReceipt["state"] = "settled";
	let failRemote = false;
	let failIntent = false;
	let calls = 0;
	let bytes: Uint8Array = new Uint8Array();
	let badChunk = false;
	let actual: RemoteHistoryState = { kind: "absent" };
	let receipt: RemoteHistoryReceipt = {
		binding,
		operationId: "op",
		requestDigest: digest,
		payloadDigest: digest,
		kind: "mutate",
		state,
		effects: [],
		startedAt: "2026-01-01T00:00:00Z",
	};
	const backend: RemoteHistoryBackend = {
		supportsRemoteHistory: true,
		async remoteHistory<K extends RemoteHistoryOperation>(
			operation: K,
			request: RemoteHistoryOperations[K]["request"],
		): Promise<RemoteHistoryOperations[K]["result"]> {
			calls++;
			events.push(`remote:${operation}`);
			if (failRemote) throw new Error("disconnected after dispatch");
			if (operation === "inspect")
				return {
					binding,
					observations: [{ path: "file.txt", state: actual }],
					pending: [],
				} as RemoteHistoryOperations[K]["result"];
			if (operation === "objectRead") {
				const input = request as RemoteHistoryOperations["objectRead"]["request"];
				return {
					object: input.object,
					offset: input.offset,
					eof: true,
					contentBase64: Buffer.from(badChunk ? new Uint8Array(bytes.length) : bytes).toString(
						"base64",
					),
				} as RemoteHistoryOperations[K]["result"];
			}
			if (operation === "mutate") {
				const input = request as RemoteHistoryRequest;
				actual = input.changes?.[0]?.desired ?? { kind: "absent" };
				if (actual.kind === "regular") {
					bytes = Buffer.from(input.changes?.[0]?.contentBase64 ?? "", "base64");
					const metadataBytes = Buffer.from(
						JSON.stringify({ mode: actual.mode, owner: "fixture-user", acl: "owner-rw" }),
					);
					const metadataDigest = await remoteHistoryDigest(metadataBytes);
					actual = {
						...actual,
						incarnation: "fixture-native-incarnation",
						metadata: {
							...actual.object,
							digest: metadataDigest,
							sizeBytes: metadataBytes.byteLength,
							objectId: remoteHistoryObjectId(
								binding.scopeId,
								"blob",
								metadataDigest,
								actual.object.path,
							),
						},
					};
				}
				receipt = {
					...receipt,
					operationId: input.operationId,
					requestDigest: input.requestDigest,
					effects: (input.changes ?? []).map((change) => ({
						path: change.path,
						before: change.expected,
						intended: change.desired,
						after: actual,
						outcome: "applied",
					})),
				};
			}
			if (operation === "finalize") state = "finalized";
			if (operation === "compensate") {
				const input = request as RemoteHistoryRequest;
				state = "compensated";
				receipt = {
					...receipt,
					operationId: input.operationId,
					requestDigest: input.requestDigest,
					kind: "compensate",
				};
			}
			return { ...receipt, state } as RemoteHistoryOperations[K]["result"];
		},
	};
	const journal: RemoteHistoryJournal = {
		async putIntent(request) {
			events.push("intent");
			if (failIntent) throw new Error("journal offline");
			intents.push(request);
		},
		async putReceipt() {
			events.push("receipt");
		},
		async markUnknown() {
			events.push("unknown");
		},
		async putObject(object) {
			objects.push(object);
		},
	};
	const history = new RemoteHistoryService(backend, binding, journal);
	return {
		events,
		objects,
		intents,
		backend,
		journal,
		history,
		setState(value: RemoteHistoryReceipt["state"]) {
			state = value;
		},
		setFailure(value: boolean) {
			failRemote = value;
		},
		setIntentFailure(value: boolean) {
			failIntent = value;
		},
		setBytes(value: Uint8Array) {
			bytes = value;
		},
		setBadChunk(value: boolean) {
			badChunk = value;
		},
		calls: () => calls,
	};
}

function authority(
	events: string[],
	commit: "committed" | "not_committed" | "unknown",
): RemoteRecoveryAuthority {
	return {
		async authorize() {
			events.push("authorize");
		},
		async serverCommit() {
			return commit === "committed"
				? { state: commit, commitId: "history-commit" }
				: { state: commit };
		},
		async compensationIntent() {
			return { operationId: "undo-op", requestDigest: digest };
		},
		async acknowledge() {
			events.push("acknowledge");
		},
	};
}

const signal = () => new AbortController().signal;

describe("remote history durable server adapter", () => {
	test("server intent precedes dispatch and disconnect keeps original ID unknown", async () => {
		const f = fixture();
		f.setFailure(true);
		await expect(
			f.history.dispatch("mutate", { binding, operationId: "op", requestDigest: digest }, signal()),
		).rejects.toBeInstanceOf(RemoteHistoryUncertainError);
		expect(f.events).toEqual(["intent", "remote:mutate", "unknown"]);
		expect(f.calls()).toBe(1);
	});

	test("failed durable intent never dispatches target IO", async () => {
		const f = fixture();
		f.setIntentFailure(true);
		await expect(
			f.history.dispatch(
				"restore",
				{ binding, operationId: "op", requestDigest: digest },
				signal(),
			),
		).rejects.toThrow("journal offline");
		expect(f.calls()).toBe(0);
	});

	test("source mismatch cannot open a similarly named workspace", async () => {
		const f = fixture();
		await expect(
			f.history.dispatch("restore", {
				binding: { ...binding, sourceInstanceId: "replacement" },
				operationId: "op",
				requestDigest: digest,
			}),
		).rejects.toThrow("sourceInstanceId mismatch");
		expect(f.calls()).toBe(0);
	});

	test("bounded read verifies complete object digest and physical provenance", async () => {
		const f = fixture();
		const bytes = new TextEncoder().encode("private bytes");
		f.setBytes(bytes);
		const object: RemoteHistoryObject = {
			sourceInstanceId: "source",
			workspaceInstanceId: "workspace",
			scopeId: "scope",
			kind: "blob",
			algorithm: "sha256",
			digest: await remoteHistoryDigest(bytes),
			path: "file.txt",
			objectId: remoteHistoryObjectId(
				binding.scopeId,
				"blob",
				await remoteHistoryDigest(bytes),
				"file.txt",
			),
			sizeBytes: bytes.length,
		};
		expect(await f.history.readObject(object)).toEqual(bytes);
		f.setBadChunk(true);
		await expect(f.history.readObject(object)).rejects.toThrow("integrity mismatch");
		await expect(f.history.readObject({ ...object, scopeId: "other" })).rejects.toThrow(
			"provenance",
		);
	});

	test("TS computes edit and commits history before finalizing target receipt", async () => {
		const f = fixture();
		const runtime = new RemoteFileChangeRuntime(f.history, {
			deviceId: "remote",
			paths: targetPathSemantics("posix"),
			pathFlavor: "posix",
		});
		let constructed = false;
		const result = await runtime.execute({
			identity,
			operationId: "op",
			requestDigest: digest,
			signal: signal(),
			async authorize() {
				f.events.push("authorize");
			},
			construct(before) {
				expect(before.bytes).toBeNull();
				constructed = true;
				return { nextBytes: new TextEncoder().encode("edited in TS"), result: "editor result" };
			},
			async commit(receipt) {
				expect(receipt.effects[0]?.outcome).toBe("applied");
				f.events.push("commit");
				return "history-commit";
			},
		});
		expect(constructed).toBe(true);
		expect(result.result).toBe("editor result");
		expect(result.receipt.state).toBe("finalized");
		expect(f.events.indexOf("intent")).toBeLessThan(f.events.indexOf("remote:mutate"));
		expect(f.events.indexOf("commit")).toBeLessThan(f.events.indexOf("remote:finalize"));
		expect(f.intents[0]?.changes?.[0]).not.toHaveProperty("contentBase64");
		expect(f.objects.every((object) => object.sourceInstanceId === binding.sourceInstanceId)).toBe(
			true,
		);
	});

	test("commit failure retains settled remote evidence without auto release", async () => {
		const f = fixture();
		const runtime = new RemoteFileChangeRuntime(f.history, {
			deviceId: "remote",
			paths: targetPathSemantics("posix"),
			pathFlavor: "posix",
		});
		await expect(
			runtime.execute({
				identity,
				operationId: "op",
				requestDigest: digest,
				signal: signal(),
				async authorize() {},
				construct: () => ({ nextBytes: new Uint8Array([1]), result: null }),
				async commit() {
					throw new Error("history failed");
				},
			}),
		).rejects.toThrow("history failed");
		expect(f.events).not.toContain("remote:finalize");
		expect(f.events).not.toContain("remote:compensate");
	});

	test("root/source qualified identity rejects outside targets", () => {
		const f = fixture();
		const runtime = new RemoteFileChangeRuntime(f.history, {
			deviceId: "remote",
			paths: targetPathSemantics("posix"),
			pathFlavor: "posix",
		});
		expect(() =>
			runtime.relativePath({ ...identity, canonicalPath: "/selected/other/file.txt" }),
		).toThrow("outside");
		expect(() => runtime.relativePath({ ...identity, deviceId: "local" })).toThrow("outside");
	});
});

describe("remote reconnect recovery", () => {
	test("unknown remote intent is not inferred from current disk or TTL", async () => {
		const f = fixture();
		f.setState("intent");
		const result = await recoverRemoteWorkspaceOperations({
			history: f.history,
			authority: authority(f.events, "not_committed"),
			operationIds: ["op"],
			signal: signal(),
		});
		expect(result[0]?.state).toBe("recovery_required");
		expect(f.events).not.toContain("remote:compensate");
		expect(f.events).not.toContain("acknowledge");
	});

	test("known committed history finalizes matching durable remote receipt", async () => {
		const f = fixture();
		const result = await recoverRemoteWorkspaceOperations({
			history: f.history,
			authority: authority(f.events, "committed"),
			operationIds: ["op"],
			signal: signal(),
		});
		expect(result[0]?.state).toBe("finalized");
		expect(f.events).toContain("acknowledge");
	});

	test("unknown server commit does not compensate settled remote operation", async () => {
		const f = fixture();
		const result = await recoverRemoteWorkspaceOperations({
			history: f.history,
			authority: authority(f.events, "unknown"),
			operationIds: ["op"],
			signal: signal(),
		});
		expect(result[0]?.state).toBe("recovery_required");
		expect(f.events).not.toContain("remote:compensate");
	});

	test("uncommitted server transaction uses original durable compensation ID", async () => {
		const f = fixture();
		const result = await recoverRemoteWorkspaceOperations({
			history: f.history,
			authority: authority(f.events, "not_committed"),
			operationIds: ["op"],
			signal: signal(),
		});
		expect(result[0]?.state).toBe("compensated");
		expect(f.intents[0]?.operationId).toBe("undo-op");
		expect(f.events).toContain("acknowledge");
	});
});

function refusalFixture() {
	const f = fixture();
	const object: RemoteHistoryObject = {
		sourceInstanceId: binding.sourceInstanceId,
		workspaceInstanceId: binding.workspaceInstanceId,
		scopeId: binding.scopeId,
		path: "file.txt",
		digest,
		sizeBytes: 3,
		algorithm: "sha256",
		kind: "blob",
		objectId: remoteHistoryObjectId(binding.scopeId, "blob", digest, "file.txt"),
	};
	const before: RemoteHistoryState = {
		kind: "regular",
		object,
		metadata: { ...object },
		incarnation: "native-original-inode",
		mode: 0o640,
	};
	const request: RemoteHistoryRequest = {
		binding,
		operationId: "refuse",
		requestDigest: digest,
		changes: [{ path: "file.txt", expected: before, desired: { kind: "absent" } }],
	};
	const receipt: RemoteHistoryReceipt = {
		binding,
		operationId: request.operationId,
		requestDigest: digest,
		payloadDigest: digest,
		kind: "mutate",
		state: "rejected",
		reason: "unsupported_cross_filesystem",
		startedAt: "2026-01-01T00:00:00Z",
		finishedAt: "2026-01-01T00:00:01Z",
		effects: [
			{
				path: "file.txt",
				before: structuredClone(before),
				intended: { kind: "absent" },
				outcome: "pending",
			},
		],
	};
	f.backend.remoteHistory = async () => receipt as never;
	return { ...f, request, receipt };
}

describe("source-qualified pre-dispatch refusal proof", () => {
	test("durable exact refusal is known no-dispatch, not Unknown or completed", async () => {
		const f = refusalFixture();
		let error: unknown;
		try {
			await f.history.dispatch("mutate", f.request);
		} catch (cause) {
			error = cause;
		}
		expect(isRemoteHistoryNoDispatchError(error)).toBe(true);
		if (!isRemoteHistoryNoDispatchError(error)) throw new Error("missing verified refusal");
		expect(error.receipt.state).toBe("rejected");
		expect(error.receipt.effects[0]?.outcome).toBe("pending");
		expect(f.events).toEqual(["intent", "receipt"]);
		expect(Object.isFrozen(error)).toBe(true);
		expect(Reflect.set(error, "receipt", {})).toBe(false);
		expect(error.statusCode).toBe(409);
		expect(error.code).toBe("UNSUPPORTED_CROSS_FILESYSTEM");
		expect(Object.isFrozen(error.receipt)).toBe(true);
		expect(Object.isFrozen(error.receipt.binding)).toBe(true);
		expect(Object.isFrozen(error.receipt.effects[0]?.before)).toBe(true);
	});

	test("unrecorded refusal remains uncertain with original intent retained", async () => {
		const f = refusalFixture();
		f.journal.putReceipt = async () => {
			throw new Error("journal unavailable");
		};
		await expect(f.history.dispatch("mutate", f.request)).rejects.toBeInstanceOf(
			RemoteHistoryUncertainError,
		);
		expect(f.events).toEqual(["intent", "unknown"]);
	});

	for (const mutate of [
		(r: RemoteHistoryReceipt) => {
			r.binding = { ...binding, sourceInstanceId: "foreign-source" };
		},
		(r: RemoteHistoryReceipt) => {
			r.binding = { ...binding, fence: binding.fence + 1 };
		},
		(r: RemoteHistoryReceipt) => {
			r.binding = { ...binding, rootIdentity: "foreign-inode" };
		},
		(r: RemoteHistoryReceipt) => {
			r.operationId = "other-op";
		},
		(r: RemoteHistoryReceipt) => {
			r.requestDigest = "b".repeat(64);
		},
		(r: RemoteHistoryReceipt) => {
			r.kind = "restore";
		},
		(r: RemoteHistoryReceipt) => {
			r.reason = "wrapped unsupported_cross_filesystem";
		},
		(r: RemoteHistoryReceipt) => {
			r.effects[0].outcome = "dispatching";
		},
		(r: RemoteHistoryReceipt) => {
			r.effects[0].after = { kind: "absent" };
		},
		(r: RemoteHistoryReceipt) => {
			r.effects[0].path = "other.txt";
		},
		(r: RemoteHistoryReceipt) => {
			r.effects = [];
		},
		(r: RemoteHistoryReceipt) => {
			r.serverCommitId = "fake-completed";
		},
		(r: RemoteHistoryReceipt) => {
			if (r.effects[0].before.kind === "regular")
				r.effects[0].before.incarnation = "foreign-same-bytes-inode";
		},
		(r: RemoteHistoryReceipt) => {
			if (r.effects[0].before.kind === "regular") r.effects[0].before.incarnation = undefined;
		},
		(r: RemoteHistoryReceipt) => {
			if (r.effects[0].before.kind === "regular") r.effects[0].before.metadata = undefined;
		},
		(r: RemoteHistoryReceipt) => {
			if (r.effects[0].before.kind === "regular") r.effects[0].before.mode = 0o600;
		},
		(r: RemoteHistoryReceipt) => {
			if (r.effects[0].before.kind === "regular" && r.effects[0].before.metadata)
				r.effects[0].before.metadata.sourceInstanceId = "foreign-native-backup";
		},
	]) {
		test(`mismatched refusal retains Unknown: ${mutate.toString()}`, async () => {
			const f = refusalFixture();
			mutate(f.receipt);
			await expect(f.history.dispatch("mutate", f.request)).rejects.toBeInstanceOf(
				RemoteHistoryUncertainError,
			);
			expect(f.events).toContain("unknown");
			expect(f.events).not.toContain("receipt");
		});
	}

	test("matching error text is never a no-dispatch proof", async () => {
		const f = refusalFixture();
		f.backend.remoteHistory = async () => {
			throw new Error("unsupported_cross_filesystem");
		};
		await expect(f.history.dispatch("mutate", f.request)).rejects.toBeInstanceOf(
			RemoteHistoryUncertainError,
		);
		expect(f.events).toContain("unknown");
		expect(isRemoteHistoryNoDispatchError(new Error("unsupported_cross_filesystem"))).toBe(false);
		expect(() => new RemoteHistoryNoDispatchError(f.receipt, Symbol("fake"))).toThrow(
			"Verified refusal proof required",
		);
		expect(
			isRemoteHistoryNoDispatchError(Object.create(RemoteHistoryNoDispatchError.prototype)),
		).toBe(false);
	});

	test("lost rejected reply recovers only from its original private intent without redispatch", async () => {
		const f = refusalFixture();
		const calls: string[] = [];
		f.journal.getIntent = async (id) => {
			const request = f.intents.find((request) => request.operationId === id);
			return request ? { kind: "mutate", request: structuredClone(request) } : null;
		};
		f.backend.remoteHistory = async (kind) => {
			calls.push(kind);
			if (kind === "mutate") throw new Error("reply lost after durable native rejection");
			return f.receipt as never;
		};
		await expect(f.history.dispatch("mutate", f.request)).rejects.toBeInstanceOf(
			RemoteHistoryUncertainError,
		);
		expect(f.events).toEqual(["intent", "unknown"]);
		const receipt = await f.history.status(f.request.operationId);
		const recovered = await f.history.proveNoDispatch(receipt);
		expect(isRemoteHistoryNoDispatchError(recovered)).toBe(true);
		expect(recovered.receipt.state).toBe("rejected");
		expect(Object.isFrozen(recovered.receipt)).toBe(true);
		expect(calls).toEqual(["mutate", "status"]);
		expect(f.events).toEqual(["intent", "unknown", "receipt", "receipt"]);
	});

	for (const missing of ["legacy", "intent"] as const)
		test(`status refusal without ${missing} never poisons Unknown terminal`, async () => {
			const f = refusalFixture();
			if (missing === "intent") f.journal.getIntent = async () => null;
			await expect(f.history.status(f.request.operationId)).rejects.toThrow("intent");
			expect(f.events).not.toContain("receipt");
		});

	for (const change of [
		(r: RemoteHistoryRequest) => {
			r.binding = { ...r.binding, sourceInstanceId: "foreign" };
		},
		(r: RemoteHistoryRequest) => {
			r.binding = { ...r.binding, fence: r.binding.fence + 1 };
		},
		(r: RemoteHistoryRequest) => {
			r.requestDigest = "b".repeat(64);
		},
		(r: RemoteHistoryRequest) => {
			r.operationId = "foreign";
		},
		(r: RemoteHistoryRequest) => {
			if (r.changes?.[0].expected.kind === "regular")
				r.changes[0].expected.incarnation = "foreign-same-bytes-inode";
		},
		(r: RemoteHistoryRequest) => {
			if (r.changes?.[0].expected.kind === "regular") r.changes[0].expected.metadata = undefined;
		},
		(r: RemoteHistoryRequest) => {
			if (r.changes) r.changes[0].path = "foreign.txt";
		},
	])
		test(`mismatched original intent never records rejected terminal: ${change.toString()}`, async () => {
			const f = refusalFixture();
			const original = structuredClone(f.request);
			change(original);
			f.journal.getIntent = async () => ({ kind: "mutate", request: original });
			await expect(f.history.status(f.request.operationId)).rejects.toThrow();
			expect(f.events).not.toContain("receipt");
		});

	test("original row kind is mandatory, not inferred from caller or returned receipt", async () => {
		const f = refusalFixture();
		f.journal.getIntent = async () => ({ kind: "restore", request: f.request });
		await expect(f.history.status(f.request.operationId)).rejects.toThrow("proof");
		expect(f.events).not.toContain("receipt");
	});
});
