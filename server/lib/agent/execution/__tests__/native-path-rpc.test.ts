import { describe, expect, test } from "bun:test";
import { parseNativePathResolution } from "../native-path-rpc";

function fixture() {
	const parent = {
		canonicalPath: "C:\\root",
		object: { volumeId: "volume-c", fileId: "a".repeat(32), creationTime: "42" },
		caseSensitive: false,
	};
	return {
		lexicalPath: "C:\\root\\file.txt",
		canonicalPath: "C:\\root\\file.txt",
		exists: true,
		inputKind: "drive-absolute",
		nativeDescriptor: {
			version: 2,
			platform: "windows",
			pathSlotKey: "c".repeat(64),
			componentKeys: ["ROOT", "FILE.TXT"],
			volumeId: "volume-c",
			ancestors: [parent],
			parent,
			missingSuffix: [] as string[],
			object: { volumeId: "volume-c", fileId: "b".repeat(32), creationTime: "43" },
		},
	};
}

describe("authenticated native path v2 response parsing", () => {
	test("valid evidence is deeply frozen", () => {
		const parsed = parseNativePathResolution(fixture());
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.nativeDescriptor.parent.object)).toBe(true);
		expect(Object.isFrozen(parsed.nativeDescriptor.componentKeys)).toBe(true);
	});

	test("rejects a mismatched ancestor volume or malformed native ID", () => {
		const volume = fixture();
		volume.nativeDescriptor.ancestors.unshift({
			...volume.nativeDescriptor.parent,
			object: { ...volume.nativeDescriptor.parent.object, volumeId: "other-volume" },
		});
		expect(() => parseNativePathResolution(volume)).toThrow();
		const id = fixture();
		id.nativeDescriptor.object.fileId = "client-claimed-id";
		expect(() => parseNativePathResolution(id)).toThrow();
	});

	test("parent must be the final native ancestor, not an earlier matching entry", () => {
		const value = fixture();
		value.nativeDescriptor.ancestors.push({
			...value.nativeDescriptor.parent,
			canonicalPath: "C:\\other",
			object: { ...value.nativeDescriptor.parent.object, fileId: "d".repeat(32) },
		});
		expect(() => parseNativePathResolution(value)).toThrow();
	});

	test("supports the bounded 512-component producer shape, rejects 513", () => {
		const value = fixture();
		value.nativeDescriptor.componentKeys = Array.from({ length: 512 }, (_, n) => `P${n}`);
		expect(parseNativePathResolution(value).nativeDescriptor.componentKeys).toHaveLength(512);
		const excessive = fixture();
		excessive.nativeDescriptor.componentKeys = Array.from({ length: 513 }, (_, n) => `P${n}`);
		expect(() => parseNativePathResolution(excessive)).toThrow();
	});

	test("rejects missing and contradictory creation evidence", () => {
		const value = fixture();
		value.exists = false;
		expect(() => parseNativePathResolution(value)).toThrow();
		const suffix = fixture();
		suffix.nativeDescriptor.missingSuffix = [".."];
		expect(() => parseNativePathResolution(suffix)).toThrow();
		expect(() => parseNativePathResolution({ ...fixture(), unexpected: true })).toThrow();
	});
});
