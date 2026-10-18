import { expect, mock, spyOn, test } from "bun:test";
import type { EditorRawDocumentDescriptor } from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";
import { ApiError } from "../../../lib/api/client";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { EditorDocumentSession, sessionCanSave } from "./editor-session-state";
import { EditorWorkingCopy } from "./editor-working-copy";

function descriptor(): EditorRawDocumentDescriptor {
	const codec = new EditorStreamCodec("utf-8");
	codec.push(new TextEncoder().encode("a\n"), true);
	return {
		...codec.finish(),
		resourceKey: "raw-key",
		docId: "raw",
		versionHandle: "raw-handle",
		target: { deviceId: "local", path: "/file.txt" },
		capabilities: {
			boundedRead: true,
			rawRead: true,
			v1Save: true,
			stage: false,
			durableApply: false,
			durableQuery: false,
			watch: false,
		},
	};
}
function setup(stableResourceKey?: string) {
	const document = { ...descriptor(), ...(stableResourceKey ? { stableResourceKey } : {}) };
	let installed = 0,
		disposed = 0;
	const api = {
		...editorDocumentApi,
		create: mock(async () => document),
		source: mock(async () => {
			throw new Error("v1 full source must not run");
		}),
		release: mock(async () => ({})),
		diskState: mock(async () => ({ exists: true as const, ...document })),
		createUpload: mock(editorDocumentApi.createUpload),
	};
	let prepare = async () => ({
		install: () => {
			installed++;
			return { revision: installed, alternativeVersionId: installed, length: 2 };
		},
		dispose: () => {
			disposed++;
		},
	});
	const snapshot = mock((): never => {
		throw new Error("raw load must retain no baseline snapshot");
	});
	const session = new EditorDocumentSession({
		narratorId: "n",
		deviceId: "local",
		path: "/file.txt",
		origin: () => "legacy",
		protocol: "raw-v2",
		resourceKey: "raw-key",
		snapshot,
		encode: async () => new Blob([]),
		applyContent: () => {
			throw new Error("v1 string install must not run");
		},
		loadRaw: () => prepare(),
		api,
		onChange: () => {},
	});
	return {
		session,
		api,
		document,
		snapshot,
		get installed() {
			return installed;
		},
		get disposed() {
			return disposed;
		},
		prepare: (next: typeof prepare) => {
			prepare = next;
		},
	};
}
test.each([
	"denied",
	"rebound",
] as const)("cancelled source authorization cannot freeze a live copy on a late %s response", async (outcome) => {
	const value = setup("root-A");
	await value.session.load();
	let resolve!: (document: typeof value.document) => void, reject!: (error: unknown) => void;
	value.api.create.mockImplementationOnce(
		() =>
			new Promise((yes, no) => {
				resolve = yes;
				reject = no;
			}),
	);
	const loading = value.session.load(true);
	value.session.change({ revision: 2, alternativeVersionId: 2, length: 3 });
	value.session.cancelSourceLoad();
	if (outcome === "denied")
		reject(new ApiError("old response", 403, { code: "EDITOR_IDENTITY_CHANGED" }));
	else resolve({ ...value.document, resourceKey: "late-root-B", stableResourceKey: "root-B" });
	expect(await loading).toBe(false);
	expect(value.session.state.invalidated).not.toBe(true);
	expect(value.session.state.baseHash).toBe(value.document.baseHash);
	expect(value.installed).toBe(1);
	value.session.dispose();
});

test("runtime-only fresh authorization forces version verification, preserves dirty revision/base/format, and root changes freeze", async () => {
	const value = setup("verified-root-A");
	try {
		await value.session.load();
		value.session.change({ revision: 2, alternativeVersionId: 2, length: 3 });
		const before = value.session.state;
		value.api.create.mockResolvedValue({
			...value.document,
			resourceKey: "new-runtime",
			docId: "new-doc",
			baseHash: "different-disk",
		});
		expect(await value.session.refreshDocument()).toBe(true);
		expect(value.api.diskState).toHaveBeenCalledTimes(1);
		expect(value.session.state.version).toBe(before.version);
		expect(value.session.state.baseHash).toBe(before.baseHash);
		expect(value.installed).toBe(1);
		expect(value.session.state.invalidated).toBeUndefined();
		value.api.create.mockResolvedValue({
			...value.document,
			stableResourceKey: "verified-root-B",
			resourceKey: "root-B-runtime",
		});
		expect(await value.session.refreshDocument()).toBe(false);
		expect(value.session.state.invalidated).toBe(true);
		expect(value.session.state.version).toBe(before.version);
		expect(value.session.state.baseHash).toBe(before.baseHash);
		expect(value.installed).toBe(1);
	} finally {
		value.session.dispose();
	}
});

test("paged metadata follows the single reauthorized document without rebasing its original raw baseline", async () => {
	const first = { ...descriptor(), docId: "expired", lineCount: 1_000_001 };
	let next = { ...first, docId: "fresh" };
	const create = spyOn(editorDocumentApi, "create").mockImplementation(async () => next);
	const release = spyOn(editorDocumentApi, "release").mockResolvedValue(undefined);
	const copy = new EditorWorkingCopy(
		{
			narratorId: "n",
			path: "/file.txt",
			deviceId: "local",
			origin: () => "legacy",
			protocol: "raw-v2",
		},
		first,
	);
	try {
		await copy.ensureLoaded();
		expect(copy.pagedDocument?.docId).toBe("expired");
		expect(await copy.session.refreshDocument()).toBe(true);
		expect(copy.pagedDocument?.docId).toBe("fresh");
		expect(copy.session.state.baseHash).toBe(first.baseHash);
		expect(sessionCanSave(copy.session.state)).toBe(false);
		next = { ...next, docId: "changed", baseHash: "f".repeat(64) };
		await copy.session.refreshDocument();
		expect(copy.session.state.baseHash).toBe(first.baseHash);
		expect(copy.pagedDocument?.docId).toBe("changed");
	} finally {
		copy.dispose();
		create.mockRestore();
		release.mockRestore();
	}
});

test("raw load retains digests, no full baseline/source, and cannot use v1 writes/draft restoration even with equal ASCII hashes", async () => {
	const value = setup();
	expect(await value.session.load()).toBe(true);
	expect(value.session.state).toMatchObject({
		protocol: "raw-v2",
		hashKind: "raw-sha256",
		baseHash: value.document.baseHash,
	});
	expect(value.api.source).not.toHaveBeenCalled();
	expect(value.snapshot).not.toHaveBeenCalled();
	value.session.change({ revision: 2, alternativeVersionId: 2, length: 3 });
	expect(sessionCanSave(value.session.state)).toBe(false);
	await value.session.save();
	expect(value.api.createUpload).not.toHaveBeenCalled();
	expect(value.session.restoreDraft("bad", value.document.baseHash, "utf-8")).toBe(false);
	expect(value.session.resourceCosts.baselineBytes).toBe(0);
	value.session.dispose();
});
for (const mutation of ["revision", "alternative", "dispose", "invalidate"] as const)
	test(`candidate finishing after ${mutation} cannot install or replace the old baseline`, async () => {
		const value = setup();
		await value.session.load();
		let complete!: (prepared: Awaited<ReturnType<Parameters<typeof value.prepare>[0]>>) => void;
		const pending = new Promise<Awaited<ReturnType<Parameters<typeof value.prepare>[0]>>>(
			(resolve) => {
				complete = resolve;
			},
		);
		value.prepare(() => pending);
		const loading = value.session.load(true);
		for (let turn = 0; turn < 5; turn++) await Promise.resolve();
		if (mutation === "revision")
			value.session.change({ revision: 2, alternativeVersionId: 2, length: 3 });
		else if (mutation === "alternative")
			value.session.change({ revision: 1, alternativeVersionId: 2, length: 2 });
		else if (mutation === "dispose") value.session.dispose();
		else value.session.invalidate("new execution binding");
		const disposeCandidate = mock(() => {});
		complete({
			install: () => {
				throw new Error("stale install");
			},
			dispose: disposeCandidate,
		});
		expect(await loading).toBe(false);
		expect(disposeCandidate).toHaveBeenCalledTimes(1);
		expect(value.installed).toBe(1);
		expect(value.session.state.baseHash).toBe(value.document.baseHash);
		value.session.dispose();
	});
