import { describe, expect, mock, test } from "bun:test";
import type { NativePathDescriptorV2 } from "@shared/target-native-path";
import type { ExecutionBackend, FileMetadataOptions } from "../../../lib/agent/execution/backend";
import { windowsPathSemantics } from "../../../lib/agent/execution/path-semantics";
import type { ToolExecutionTarget } from "../../../lib/agent/types";
import { createExecutionTargetContext } from "../target-context";

function fixture() {
	const parent = {
		canonicalPath: "C:\\",
		object: { volumeId: "volume", fileId: "a".repeat(32), creationTime: "1" },
		caseSensitive: false,
	};
	const root: NativePathDescriptorV2 = {
		version: 2,
		platform: "windows",
		pathSlotKey: "b".repeat(64),
		componentKeys: ["ROOT"],
		volumeId: "volume",
		ancestors: [parent],
		parent,
		missingSuffix: [],
		object: { volumeId: "volume", fileId: "b".repeat(32), creationTime: "2" },
		caseSensitive: false,
	};
	const file: NativePathDescriptorV2 = {
		...root,
		pathSlotKey: "c".repeat(64),
		componentKeys: ["OTHER", "FILE.TXT"],
		object: { volumeId: "volume", fileId: "c".repeat(32), creationTime: "3" },
	};
	const target: ToolExecutionTarget = {
		deviceId: "native-device",
		backendKind: "remote",
		cwd: "C:\\root",
		pathFlavor: "windows",
		lexicalPath: "C:\\other\\file.txt",
		canonicalPath: "C:\\other\\file.txt",
		runtimeGeneration: 3,
		selectionSource: "session_default",
		nativeRootDescriptor: root,
		nativeDescriptor: file,
	};
	let rootChanged = false;
	const resolve = mock(async (path: string, options?: FileMetadataOptions) => {
		const expected = path === target.cwd ? root : file;
		if (options?.expectedNativeDescriptor !== expected)
			throw new Error("original native proof omitted");
		if (path === target.cwd && rootChanged) throw new Error("original root incarnation replaced");
		return {
			lexicalPath: path,
			canonicalPath: path,
			exists: true,
			runtimeGeneration: 3,
			nativeDescriptor: expected,
		};
	});
	const backend = {
		deviceId: target.deviceId,
		kind: "remote",
		pathFlavor: "windows",
		platform: { os: "windows" },
		paths: windowsPathSemantics,
		runtimeGeneration: 3,
		supportsNativePathV2: true,
		resolvePathIdentity: resolve,
	} as unknown as ExecutionBackend;
	return {
		target,
		backend,
		resolve,
		root,
		file,
		replaceRoot: () => {
			rootChanged = true;
		},
	};
}

describe("permission context retains original Windows native proofs", () => {
	test("root and external authorized file are independently revalidated and preserved", async () => {
		const f = fixture();
		const context = await createExecutionTargetContext({ backend: f.backend, target: f.target });
		expect(f.resolve.mock.calls).toHaveLength(2);
		expect(f.resolve.mock.calls[0][0]).toBe(f.target.cwd);
		expect(f.resolve.mock.calls[0][1]?.expectedNativeDescriptor).toBe(f.root);
		expect(f.resolve.mock.calls[1][1]?.expectedNativeDescriptor).toBe(f.file);
		expect(f.resolve.mock.calls[1][1]?.expectedRootDescriptor).toBeUndefined();
		expect(context.target.nativeRootDescriptor).toBe(f.root);
		expect(context.target.nativeDescriptor).toBe(f.file);
	});
	test("missing legacy root evidence cannot be invented from the live resolver", async () => {
		const f = fixture();
		await expect(
			createExecutionTargetContext({
				backend: f.backend,
				target: { ...f.target, nativeRootDescriptor: undefined },
			}),
		).rejects.toThrow("Original native execution-directory proof required");
		expect(f.resolve).not.toHaveBeenCalled();
	});
	test("missing original file proof is rejected, not replaced by current same-name evidence", async () => {
		const f = fixture();
		await expect(
			createExecutionTargetContext({
				backend: f.backend,
				target: { ...f.target, nativeDescriptor: undefined },
			}),
		).rejects.toThrow("Original native execution-target proof required");
		expect(f.resolve.mock.calls).toHaveLength(1);
	});
	test("same-spelled replacement root is rejected before target lookup", async () => {
		const f = fixture();
		f.replaceRoot();
		await expect(
			createExecutionTargetContext({ backend: f.backend, target: f.target }),
		).rejects.toThrow("original root incarnation replaced");
		expect(f.resolve.mock.calls).toHaveLength(1);
	});
});
