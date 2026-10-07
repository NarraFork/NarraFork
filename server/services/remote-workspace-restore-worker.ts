import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBinding,
	RemoteHistoryEffect,
	RemoteHistoryObject,
	RemoteHistoryState,
} from "@shared/remote-history-protocol";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import { assertRemoteHistoryBinding, assertRemoteHistoryObject } from "./remote-history-service";

export const REMOTE_RESTORE_INDEX_BYTES = 1024 * 1024;
export const REMOTE_RESTORE_PAGE_BYTES = 4 * 1024 * 1024;
export const REMOTE_RESTORE_METADATA_BYTES = 64 * 1024 * 1024;
export interface RemoteTreeEntry {
	path: string;
	kind: "regular" | "directory";
	state?: RemoteHistoryState;
	mode?: number;
}
export interface RemoteSnapshotDelta {
	path: string;
	expected: RemoteHistoryState;
	desired: RemoteHistoryState;
}
export interface RemoteTreeIndex {
	format: "whole_directory_tree_v1";
	binding: RemoteHistoryBinding;
	policyDigest: string;
	pages: RemoteHistoryObject[];
	entryCount: number;
	excludedCount: number;
	coverage: "complete";
	consistency: "stable_double_scan";
	filterProof: { version: 1; kind: "none" | "git"; fingerprint: string; complete: true };
}
export type RestoreWorkerRequest =
	| {
			kind: "index";
			bytes: Uint8Array;
			binding: RemoteHistoryBinding;
			policyDigest: string;
			side: "snapshot" | "current" | "after";
	  }
	| { kind: "page"; bytes: Uint8Array; binding: RemoteHistoryBinding; flavor: "posix" | "windows" }
	| {
			kind: "ingest";
			side: "snapshot" | "current" | "after";
			entries: RemoteTreeEntry[];
			expectedCount: number;
	  }
	| { kind: "postExpected"; effects: RemoteHistoryEffect[] }
	| { kind: "verifyPost" }
	| { kind: "delta" }
	| { kind: "parseManifest"; bytes: Uint8Array }
	| { kind: "encode"; value: unknown };
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	return value;
}
function treeFingerprint(side: "snapshot" | "current" | "after" | "expectedPost") {
	const hash = createHash("sha256");
	for (const [path, entry] of [...trees[side]].sort(([a], [b]) => a.localeCompare(b)))
		hash.update(JSON.stringify(canonical([path, entry]))).update("\0");
	return hash.digest("hex");
}
const trees = {
	snapshot: new Map<string, RemoteTreeEntry>(),
	current: new Map<string, RemoteTreeEntry>(),
	after: new Map<string, RemoteTreeEntry>(),
	expectedPost: new Map<string, RemoteTreeEntry>(),
};
let metadataBytes = 0;
const filterProofs: Partial<Record<"snapshot" | "current" | "after", string>> = {};
function parse(bytes: Uint8Array, maximum: number): unknown {
	if (bytes.byteLength > maximum) throw new Error("Restore metadata frame budget exceeded");
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Malformed restore metadata");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
	if (
		required.some((key) => !(key in value)) ||
		Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
	)
		throw new Error("Restore metadata format mismatch");
}
function integer(value: unknown, maximum: number) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new Error("Restore metadata count budget exceeded");
}
function same(left?: RemoteTreeEntry, right?: RemoteTreeEntry) {
	if (!left || !right || left.kind !== right.kind) return false;
	if (left.kind === "directory") return left.mode === right.mode;
	const a = left.state;
	const b = right.state;
	return (
		a?.kind === "regular" &&
		b?.kind === "regular" &&
		a.object.digest === b.object.digest &&
		a.object.sizeBytes === b.object.sizeBytes &&
		a.mode === b.mode &&
		a.metadata?.digest === b.metadata?.digest
	);
}
export function runRemoteRestoreWorker(request: RestoreWorkerRequest): unknown {
	if (request.kind === "parseManifest") return parse(request.bytes, FILE_CHANGE_LIMITS.blobBytes);
	if (request.kind === "encode") {
		const bytes = new TextEncoder().encode(JSON.stringify(request.value));
		if (bytes.byteLength > FILE_CHANGE_LIMITS.blobBytes)
			throw new Error("Restore manifest exceeds bounded byte budget");
		return bytes;
	}
	if (request.kind === "index") {
		const value = object(parse(request.bytes, REMOTE_RESTORE_INDEX_BYTES));
		keys(value, [
			"format",
			"binding",
			"policyDigest",
			"pages",
			"entryCount",
			"excludedCount",
			"coverage",
			"consistency",
			"filterProof",
		]);
		delete filterProofs[request.side];
		if (value.filterProof !== undefined) {
			const proof = object(value.filterProof);
			keys(proof, ["version", "kind", "fingerprint", "complete"]);
			if (
				proof.version !== 1 ||
				!["none", "git"].includes(proof.kind as string) ||
				typeof proof.fingerprint !== "string" ||
				!/^[a-f0-9]{64}$/.test(proof.fingerprint) ||
				proof.complete !== true
			)
				throw new Error("Snapshot ignore-filter proof is incomplete or unproven");
			filterProofs[request.side] = JSON.stringify(canonical(proof));
		}
		if (
			request.side === "after" &&
			(!filterProofs.current || filterProofs.after !== filterProofs.current)
		)
			throw new Error("Workspace ignore-filter changed before commit");
		if (
			value.format !== "whole_directory_tree_v1" ||
			value.coverage !== "complete" ||
			value.consistency !== "stable_double_scan" ||
			value.policyDigest !== request.policyDigest
		)
			throw new Error(
				"Snapshot is not a complete stable whole-directory capture under the original policy",
			);
		assertRemoteHistoryBinding(request.binding, value.binding as RemoteHistoryBinding);
		integer(value.entryCount, FILE_CHANGE_LIMITS.capturePaths);
		integer(value.excludedCount, FILE_CHANGE_LIMITS.capturePaths);
		if (
			!Array.isArray(value.pages) ||
			value.pages.length > Math.ceil(FILE_CHANGE_LIMITS.capturePaths / 500)
		)
			throw new Error("Snapshot page inventory exceeds complete budget");
		for (const page of value.pages) {
			assertRemoteHistoryObject(request.binding, page);
			if (page.kind !== "tree" || page.path !== "" || page.sizeBytes > REMOTE_RESTORE_PAGE_BYTES)
				throw new Error("Unproven snapshot page descriptor");
		}
		return value;
	}
	if (request.kind === "page") {
		const value = object(parse(request.bytes, REMOTE_RESTORE_PAGE_BYTES));
		keys(value, ["format", "entries"]);
		if (
			value.format !== "full_tree_page_v1" ||
			!Array.isArray(value.entries) ||
			value.entries.length > 500
		)
			throw new Error("Snapshot page format/count mismatch");
		const paths = targetPathSemantics(request.flavor);
		for (const raw of value.entries) {
			const entry = object(raw);
			keys(entry, ["path", "kind"], ["state", "mode"]);
			if (
				typeof entry.path !== "string" ||
				!entry.path ||
				Buffer.byteLength(entry.path) > 4096 ||
				entry.path.includes("\0") ||
				paths.isAbsolute(entry.path) ||
				!paths.contains(request.binding.root, paths.resolve(request.binding.root, entry.path)) ||
				paths.equals(request.binding.root, paths.resolve(request.binding.root, entry.path))
			)
				throw new Error("Snapshot entry escaped its recorded origin");
			if (entry.kind === "directory") integer(entry.mode, 0o7777);
			else if (entry.kind === "regular") {
				const state = object(entry.state);
				keys(state, ["kind", "object", "mode", "metadata", "incarnation"]);
				if (state.kind !== "regular" || typeof state.incarnation !== "string" || !state.incarnation)
					throw new Error("Snapshot regular entry has no native incarnation");
				integer(state.mode, 0o7777);
				for (const descriptor of [state.object, state.metadata]) {
					assertRemoteHistoryObject(request.binding, descriptor as RemoteHistoryObject);
					const item = descriptor as RemoteHistoryObject;
					if (item.kind !== "blob" || item.path !== entry.path)
						throw new Error("Snapshot regular origin metadata mismatch");
				}
			} else throw new Error("Snapshot contains a special or unsupported object");
		}
		return value.entries;
	}
	if (request.kind === "postExpected") {
		trees.expectedPost = new Map(trees.current);
		trees.after.clear();
		for (const effect of request.effects) {
			if (effect.outcome !== "applied" || !effect.after)
				throw new Error("Post-restore coverage requires actual native after proof");
			if (effect.after.kind === "absent") trees.expectedPost.delete(effect.path);
			else
				trees.expectedPost.set(effect.path, {
					path: effect.path,
					kind: "regular",
					mode: effect.after.mode,
					state: effect.after,
				});
		}
		return trees.expectedPost.size;
	}
	if (request.kind === "verifyPost") {
		if (
			trees.after.size !== trees.expectedPost.size ||
			treeFingerprint("after") !== treeFingerprint("expectedPost")
		) {
			const changed = [...new Set([...trees.after.keys(), ...trees.expectedPost.keys()])].find(
				(path) =>
					JSON.stringify(canonical(trees.after.get(path))) !==
					JSON.stringify(canonical(trees.expectedPost.get(path))),
			);
			throw new Error(
				`Whole workspace changed outside the exact snapshot delta before commit: ${changed}`,
			);
		}
		return true;
	}
	if (request.kind === "ingest") {
		const tree = trees[request.side];
		integer(request.expectedCount, FILE_CHANGE_LIMITS.capturePaths);
		metadataBytes += Buffer.byteLength(JSON.stringify(request.entries));
		if (metadataBytes > REMOTE_RESTORE_METADATA_BYTES)
			throw new Error("Complete tree metadata budget exceeded");
		for (const entry of request.entries) {
			if (tree.has(entry.path) || tree.size >= request.expectedCount)
				throw new Error("Snapshot page inventory has duplicates or undeclared entries");
			tree.set(entry.path, entry);
		}
		return tree.size;
	}
	const changes: RemoteSnapshotDelta[] = [];
	const paths = new Set([...trees.snapshot.keys(), ...trees.current.keys()]);
	let bytes = 0;
	for (const path of [...paths].sort()) {
		const desired = trees.snapshot.get(path);
		const expected = trees.current.get(path);
		if (
			path.split(/[\\/]/).at(-1) === ".gitignore" &&
			(desired?.state?.kind !== expected?.state?.kind ||
				(desired?.state?.kind === "regular" &&
					expected?.state?.kind === "regular" &&
					desired.state.object.digest !== expected.state.object.digest))
		)
			throw new Error("Snapshot ignore-filter input changed; excluded coverage cannot be inferred");
		if (desired?.kind === "directory" || expected?.kind === "directory") {
			if (!same(desired, expected))
				throw new Error(
					"Directory structure/mode restore lacks an admitted native directory primitive",
				);
			continue;
		}
		if (same(desired, expected)) continue;
		if (
			!desired &&
			expected &&
			(!filterProofs.snapshot || filterProofs.snapshot !== filterProofs.current)
		)
			throw new Error(
				"Current-only deletion lacks an identical complete original ignore-filter proof",
			);
		const before = expected?.state ?? { kind: "absent" as const };
		const after = desired?.state ?? { kind: "absent" as const };
		if (before.kind === "regular") bytes += before.object.sizeBytes;
		if (after.kind === "regular") bytes += after.object.sizeBytes;
		if (
			changes.length >= FILE_CHANGE_LIMITS.revertFiles ||
			bytes > FILE_CHANGE_LIMITS.operationEvidenceBytes
		)
			throw new Error("Complete workspace delta exceeds native single-operation evidence budget");
		changes.push({ path, expected: before, desired: after });
	}
	if (
		Buffer.byteLength(JSON.stringify(changes)) >
		FILE_CHANGE_LIMITS.summaryBytes - FILE_CHANGE_LIMITS.metadataBytes
	)
		throw new Error("Complete workspace delta exceeds native single-operation metadata budget");
	return {
		changes,
		evidenceBytes: bytes,
		entryCount: trees.snapshot.size,
		currentEntryCount: trees.current.size,
		snapshotFingerprint: treeFingerprint("snapshot"),
		currentFingerprint: treeFingerprint("current"),
	};
}
parentPort?.on("message", (message: { id: number; request: RestoreWorkerRequest }) => {
	try {
		parentPort?.postMessage({ id: message.id, value: runRemoteRestoreWorker(message.request) });
	} catch (error) {
		parentPort?.postMessage({
			id: message.id,
			error:
				error instanceof Error ? error.message.slice(0, 1024) : "Restore metadata worker failed",
		});
	}
});
