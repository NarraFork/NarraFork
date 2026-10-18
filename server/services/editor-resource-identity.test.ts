import { expect, test } from "bun:test";
import type { CreateEditorDocumentInput } from "../../shared/editor-document";
import {
	type EditorActor,
	type EditorBinding,
	editorRecoveryKey,
	editorResourceKey,
} from "./editor-document-service";

const binding: EditorBinding = {
	cwd: "/repo",
	projectId: "project",
	lexicalPath: "/repo/a",
	canonicalPath: "/repo/a",
	outsideRoots: false,
	contextKey: "revision-1",
	workspaceIdentity: "root-inode-1",
	pathFlavor: "posix",
};
const actor: EditorActor = { userId: "user", narratorId: "source", authorize: async () => binding };
const input: CreateEditorDocumentInput = {
	path: "/repo/a",
	deviceId: "local",
	origin: "reference",
};

test("recovery discovery stays inside verified principal, narrator, device and origin without granting model sharing", () => {
	const recoveryKey = editorRecoveryKey(actor, input);
	expect(recoveryKey).toMatch(/^[a-f0-9]{64}$/);
	expect(editorRecoveryKey(actor, { ...input, path: "/new-execution/a" })).toBe(recoveryKey);
	for (const [otherActor, otherInput] of [
		[{ ...actor, userId: "other" }, input],
		[{ ...actor, narratorId: "host" }, input],
		[actor, { ...input, deviceId: "remote" }],
		[actor, { ...input, origin: "legacy" as const }],
	] as const)
		expect(editorRecoveryKey(otherActor, otherInput)).not.toBe(recoveryKey);
	expect(editorResourceKey(actor, input, { ...binding, contextKey: "new" })).not.toBe(
		editorResourceKey(actor, input, binding),
	);
});

test("opaque identity merges only canonical aliases inside the complete authorized scope", () => {
	const key = editorResourceKey(actor, input, binding);
	expect(key).toMatch(/^[a-f0-9]{64}$/);
	expect(
		editorResourceKey(actor, { ...input, path: "a" }, { ...binding, lexicalPath: "/repo/./a" }),
	).toBe(key);
	for (const [otherActor, otherInput, otherBinding] of [
		[{ ...actor, userId: "other" }, input, binding],
		[{ ...actor, narratorId: "host" }, input, binding],
		[actor, { ...input, deviceId: "remote" }, binding],
		[actor, { ...input, origin: "legacy" as const }, binding],
		[actor, input, { ...binding, cwd: "/other" }],
		[actor, input, { ...binding, contextKey: "revision-2" }],
		[actor, input, { ...binding, workspaceIdentity: "root-inode-2" }],
		[actor, input, { ...binding, projectId: "other" }],
		[actor, input, { ...binding, pathFlavor: "windows" as const }],
		[actor, input, { ...binding, canonicalPath: "/repo/b" }],
		[actor, input, { ...binding, outsideRoots: true }],
	] as const)
		expect(editorResourceKey(otherActor, otherInput, otherBinding)).not.toBe(key);
});

test("stable raw identity excludes only runtime generation/epoch, never authority or physical root", () => {
	const raw = { ...input, protocol: "raw-v2" as const };
	const previous = { ...binding, runtimeGeneration: 1, runtimeEpoch: "before" };
	const restarted = { ...binding, runtimeGeneration: 2, runtimeEpoch: "after" };
	expect(editorResourceKey(actor, raw, previous)).not.toBe(
		editorResourceKey(actor, raw, restarted),
	);
	const stable = editorResourceKey(actor, raw, previous, true);
	expect(editorResourceKey(actor, raw, restarted, true)).toBe(stable);
	for (const changed of [
		{ ...restarted, workspaceIdentity: "different-physical-root" },
		{ ...restarted, contextKey: "different-context" },
		{ ...restarted, cwd: "/new-root" },
		{ ...restarted, pathFlavor: "windows" as const },
		{ ...restarted, deviceId: "different-device" },
	])
		expect(editorResourceKey(actor, raw, changed, true)).not.toBe(stable);
	for (const changed of [
		{ ...actor, userId: "other" },
		{ ...actor, narratorId: "host" },
	])
		expect(editorResourceKey(changed, raw, restarted, true)).not.toBe(stable);
	expect(editorResourceKey(actor, { ...raw, origin: "legacy" }, restarted, true)).not.toBe(stable);
});
