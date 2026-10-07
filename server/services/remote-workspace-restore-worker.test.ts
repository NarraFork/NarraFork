import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { RemoteHistoryBinding, RemoteHistoryObject } from "@shared/remote-history-protocol";
import { remoteHistoryObjectId } from "./remote-history-service";
import { RemoteRestoreParser } from "./remote-workspace-restore-parser";
import type { RemoteSnapshotDelta, RemoteTreeEntry } from "./remote-workspace-restore-worker";

// Await worker errors normally: Bun's synchronous rejects.toThrow matcher can
// starve a worker MessagePort after several successful replies.
async function rejects(promise: Promise<unknown>, message: string) {
	const error = await promise.then(
		() => undefined,
		(error) => error,
	);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toContain(message);
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const binding: RemoteHistoryBinding = {
	sourceInstanceId: "source",
	workspaceInstanceId: "workspace",
	scopeId: "scope",
	root: "/root",
	rootIdentity: "root-incarnation",
	fence: 7,
};
const proof = { version: 1, kind: "git", fingerprint: digest("immutable-filter"), complete: true };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const index = (filterProof: unknown = proof) => ({
	format: "whole_directory_tree_v1",
	binding,
	policyDigest: digest("policy"),
	pages: [],
	entryCount: 0,
	excludedCount: 0,
	coverage: "complete",
	consistency: "stable_double_scan",
	filterProof,
});
function blob(path: string, content: string): RemoteHistoryObject {
	const hash = digest(content);
	return {
		sourceInstanceId: binding.sourceInstanceId,
		workspaceInstanceId: binding.workspaceInstanceId,
		scopeId: binding.scopeId,
		kind: "blob",
		path,
		algorithm: "sha256",
		digest: hash,
		sizeBytes: content.length,
		objectId: remoteHistoryObjectId(binding.scopeId, "blob", hash, path),
	};
}
const entry: RemoteTreeEntry = {
	path: "keep.dat",
	kind: "regular",
	mode: 0o600,
	state: {
		kind: "regular",
		mode: 0o600,
		object: blob("keep.dat", "DO NOT DELETE"),
		metadata: blob("keep.dat", "native metadata"),
		incarnation: "native-incarnation",
	},
};

for (const kind of ["missing", "partial", "different", "kind_changed"] as const) {
	test(`worker refuses ${kind} immutable filter proof before current-only deletion`, async () => {
		const parser = new RemoteRestoreParser(AbortSignal.timeout(10_000));
		try {
			const original =
				kind === "missing"
					? (() => {
							const value: Record<string, unknown> = index();
							delete value.filterProof;
							return value;
						})()
					: index(kind === "partial" ? { ...proof, complete: false } : proof);
			const request = {
				kind: "index" as const,
				bytes: encode(original),
				binding,
				policyDigest: digest("policy"),
				side: "snapshot" as const,
			};
			if (kind === "missing" || kind === "partial") {
				await rejects(
					parser.request(request),
					kind === "missing" ? "format mismatch" : "incomplete",
				);
				return;
			}
			await parser.request(request);
			await parser.request({
				kind: "index",
				bytes: encode(
					index(
						kind === "kind_changed"
							? { ...proof, kind: "none" }
							: { ...proof, fingerprint: digest("new-filter") },
					),
				),
				binding,
				policyDigest: digest("policy"),
				side: "current",
			});
			await parser.request({ kind: "ingest", side: "current", entries: [entry], expectedCount: 1 });
			await rejects(parser.request({ kind: "delta" }), "Current-only deletion");
		} finally {
			parser.close();
		}
	});
}

test("identical complete filter proofs admit one exact current-only deletion", async () => {
	const parser = new RemoteRestoreParser(AbortSignal.timeout(10_000));
	try {
		for (const side of ["snapshot", "current"] as const)
			await parser.request({
				kind: "index",
				bytes: encode(index()),
				binding,
				policyDigest: digest("policy"),
				side,
			});
		await parser.request({ kind: "ingest", side: "current", entries: [entry], expectedCount: 1 });
		const result = await parser.request<{ changes: RemoteSnapshotDelta[] }>({ kind: "delta" });
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].path).toBe("keep.dat");
		expect(result.changes[0].desired).toEqual({ kind: "absent" });
	} finally {
		parser.close();
	}
});

for (const change of ["partial", "source", "oversized"] as const) {
	test(`worker rejects ${change} index without declaring full coverage`, async () => {
		const parser = new RemoteRestoreParser(AbortSignal.timeout(10_000));
		try {
			const value = index();
			const bytes =
				change === "oversized"
					? new Uint8Array(1024 * 1024 + 1)
					: encode(
							change === "source"
								? { ...value, binding: { ...binding, sourceInstanceId: "replacement" } }
								: { ...value, coverage: "partial" },
						);
			await rejects(
				parser.request({
					kind: "index",
					bytes,
					binding,
					policyDigest: digest("policy"),
					side: "snapshot",
				}),
				change === "oversized"
					? "frame budget"
					: change === "source"
						? "sourceInstanceId mismatch"
						: "complete stable",
			);
		} finally {
			parser.close();
		}
	});
}

test("worker rejects unsupported special tree entries and post-capture filter change", async () => {
	const parser = new RemoteRestoreParser(AbortSignal.timeout(10_000));
	try {
		await rejects(
			parser.request({
				kind: "page",
				bytes: encode({
					format: "full_tree_page_v1",
					entries: [{ path: "special", kind: "symlink" }],
				}),
				binding,
				flavor: "posix",
			}),
			"special or unsupported",
		);
		await parser.request({
			kind: "index",
			bytes: encode(index()),
			binding,
			policyDigest: digest("policy"),
			side: "current",
		});
		await rejects(
			parser.request({
				kind: "index",
				bytes: encode(index({ ...proof, fingerprint: digest("filter-after") })),
				binding,
				policyDigest: digest("policy"),
				side: "after",
			}),
			"filter changed before commit",
		);
	} finally {
		parser.close();
	}
});
