import { describe, expect, test } from "bun:test";
import {
	classifyWindowsPath,
	type NativeObjectIdentityV2,
	type NativePathAncestorV2,
	type NativePathDescriptorV2,
	nativePathContains,
	nativePathEquals,
	resolveWindowsPath,
	validateNativePathDescriptorV2,
	validateWindowsPath,
} from "./target-native-path";

const volumeId = "\\\\?\\Volume{fixture}\\0000000000000001";
const object = (id: number): NativeObjectIdentityV2 => ({
	volumeId,
	fileId: id.toString(16).padStart(32, "0"),
	creationTime: "1234567",
});
const root: NativePathAncestorV2 = {
	canonicalPath: "\\\\?\\C:\\",
	object: object(1),
	caseSensitive: false,
};
const dir: NativePathAncestorV2 = {
	canonicalPath: "\\\\?\\C:\\case",
	object: object(2),
	caseSensitive: true,
};
function descriptor(name: string, id = 3): NativePathDescriptorV2 {
	return {
		version: 2,
		platform: "windows",
		pathSlotKey: id.toString(16).padStart(64, "0"),
		componentKeys: ["root", "CASE", name],
		volumeId,
		ancestors: [root, dir],
		parent: dir,
		missingSuffix: [],
		object: object(id),
		caseSensitive: false,
	};
}

describe("Windows input grammar is independent of process cwd", () => {
	test("binds root and same-drive relative paths to the explicit selected drive", () => {
		expect(resolveWindowsPath("D:\\work", "D:foo")).toBe("D:\\work\\foo");
		expect(resolveWindowsPath("D:\\work", "\\foo")).toBe("D:\\foo");
		expect(() => resolveWindowsPath("D:\\work", "C:foo")).toThrow("AMBIGUOUS_DRIVE_RELATIVE");
		expect(resolveWindowsPath("\\\\server\\share\\work", "\\foo")).toBe("\\\\server\\share\\foo");
	});
	test("preserves valid UNC, extended, Unicode and leading-space names", () => {
		for (const path of [
			"\\\\server\\share\\Unicode 空格\\文档",
			"\\\\?\\C:\\Unicode 空格\\文件",
			"\\\\?\\UNC\\server\\share\\文件",
		]) {
			expect(resolveWindowsPath("D:\\work", path)).toBe(path);
			expect(classifyWindowsPath(path).endsWith("absolute")).toBe(true);
		}
		const long = `\\\\?\\C:\\${"a\\".repeat(160)}文件`;
		expect(long.length).toBeGreaterThan(260);
		expect(resolveWindowsPath("D:\\work", long)).toBe(long);
		expect(resolveWindowsPath("D:\\work", " leading\\é.txt")).toBe("D:\\work\\ leading\\é.txt");
	});
	test("refuses devices, ADS, wildcards and ambiguous extended literal aliases", () => {
		for (const path of [
			"\\\\.\\pipe\\name",
			"\\\\?\\GLOBALROOT\\Device\\x",
			"\\??\\C:\\x",
			"C:\\NUL.txt",
			"C:\\COM¹.txt",
			"C:\\LPT²",
			"C:\\CONIN$",
			"C:\\file:stream",
			"C:\\file::$DATA",
			"C:\\a ",
			"C:\\a.",
			"C:\\*.txt",
			"\\\\?\\C:\\a\\..\\b",
			"C:\\a\u0000b",
			"C:\\a\nb",
		]) {
			expect(() => validateWindowsPath(path)).toThrow();
		}
	});
});

describe("native path authority keeps slots, parent identity, and incarnation separate", () => {
	test("does not collapse distinct Work/work under a sensitive parent", () => {
		const upper = descriptor("Work", 3);
		const lower = descriptor("work", 4);
		expect(nativePathEquals(upper, lower)).toBe(false);
		expect(nativePathContains(upper, lower)).toBe(false);
		expect(nativePathEquals(upper, structuredClone(upper))).toBe(true);
	});
	test("rejects same slot after parent replacement, object replacement or case-mode drift", () => {
		const original = descriptor("Work");
		const replacement = structuredClone(original);
		replacement.object = object(7);
		expect(nativePathEquals(original, replacement)).toBe(false);
		const parentReplacement = structuredClone(original);
		parentReplacement.parent.object = object(9);
		expect(nativePathEquals(original, parentReplacement)).toBe(false);
		const modeDrift = structuredClone(original);
		modeDrift.parent.caseSensitive = false;
		expect(nativePathEquals(original, modeDrift)).toBe(false);
	});
	test("only grants a native root prefix with its original incarnation in the chain", () => {
		const parent: NativePathDescriptorV2 = {
			...descriptor("ignored", 2),
			pathSlotKey: "2".padStart(64, "0"),
			componentKeys: ["root", "CASE"],
			ancestors: [root],
			parent: root,
			object: dir.object,
			caseSensitive: true,
		};
		expect(nativePathContains(parent, descriptor("Work"))).toBe(true);
		const replaced = structuredClone(parent);
		replaced.object = object(9);
		expect(nativePathContains(replaced, descriptor("Work"))).toBe(false);
	});
	test("strictly validates field, ancestor, volume, suffix and UTF8 wire budgets", () => {
		const valid = descriptor("Work");
		expect(() => validateNativePathDescriptorV2(valid)).not.toThrow();
		for (const mutate of [
			(value: Record<string, unknown>) => {
				value.guessCase = false;
			},
			(value: Record<string, unknown>) => {
				value.ancestors = Array(257).fill(root);
			},
			(value: Record<string, unknown>) => {
				value.componentKeys = ["界".repeat(24000)];
			},
			(value: Record<string, unknown>) => {
				value.volumeId = "other";
			},
			(value: Record<string, unknown>) => {
				value.parent = { ...dir, caseSensitive: undefined };
			},
			(value: Record<string, unknown>) => {
				value.missingSuffix = ["../x"];
			},
		]) {
			const invalid = structuredClone(valid) as unknown as Record<string, unknown>;
			mutate(invalid);
			expect(() => validateNativePathDescriptorV2(invalid)).toThrow();
		}
	});
});

test("explicit fully qualified Windows paths do not need an inferred device or controller cwd", () => {
	for (const path of [
		"D:\\repo",
		"\\\\server\\share\\repo",
		"\\\\?\\D:\\repo",
		"\\\\?\\UNC\\server\\share\\repo",
	]) {
		expect(resolveWindowsPath("", path)).toBe(path);
	}
	for (const path of ["relative", "\\root-relative", "D:drive-relative"]) {
		expect(() => resolveWindowsPath("", path)).toThrow("baseCwd must be fully qualified");
	}
	for (const path of [
		"D:\\NUL.txt",
		"D:\\file:stream",
		"\\\\.\\pipe\\unsafe",
		"\\\\?\\GLOBALROOT\\Device\\unsafe",
	]) {
		expect(() => resolveWindowsPath("", path)).toThrow();
	}
});
