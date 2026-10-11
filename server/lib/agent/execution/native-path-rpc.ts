import { Buffer } from "node:buffer";
import { win32 } from "node:path";
import {
	NATIVE_PATH_BODY_MAX_BYTES,
	NATIVE_PATH_MAX_CODE_UNITS,
	type ResolveNativePathV2Result,
	validateNativePathDescriptorV2,
	validateWindowsPath,
} from "@shared/target-native-path";
import { z } from "zod";

const nativeId = z.string().min(1).max(512);
const path = z.string().min(1).max(NATIVE_PATH_MAX_CODE_UNITS);
const object = z.strictObject({ volumeId: nativeId, fileId: nativeId, creationTime: nativeId });
const ancestor = z.strictObject({ canonicalPath: path, object, caseSensitive: z.boolean() });
const descriptor = z.strictObject({
	version: z.literal(2),
	platform: z.literal("windows"),
	pathSlotKey: z.string().min(1).max(NATIVE_PATH_BODY_MAX_BYTES),
	componentKeys: z.array(path).min(1).max(512),
	volumeId: nativeId,
	ancestors: z.array(ancestor).min(1).max(256),
	parent: ancestor,
	missingSuffix: z.array(z.string().min(1).max(512)).max(256),
	object: object.optional(),
	caseSensitive: z.boolean().optional(),
});
const result = z.strictObject({
	lexicalPath: path,
	canonicalPath: path,
	exists: z.boolean(),
	inputKind: z.enum([
		"drive-absolute",
		"unc-absolute",
		"extended-drive-absolute",
		"extended-unc-absolute",
		"drive-relative",
		"root-relative",
		"relative",
	]),
	nativeDescriptor: descriptor,
});

/** Parse only authenticated v2 RPC responses; absent/malformed native evidence is never a grant. */
export function parseNativePathResolution(value: unknown): ResolveNativePathV2Result {
	if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > NATIVE_PATH_BODY_MAX_BYTES)
		throw new Error("Native path resolution exceeds its evidence budget");
	const parsed = result.parse(value);
	if (
		!validateWindowsPath(parsed.lexicalPath).endsWith("absolute") ||
		!validateWindowsPath(parsed.canonicalPath).endsWith("absolute")
	)
		throw new Error("Native path resolver omitted a fully qualified endpoint");
	const native = parsed.nativeDescriptor;
	validateNativePathDescriptorV2(native);
	if (
		native.volumeId !== native.parent.object.volumeId ||
		(native.object && native.volumeId !== native.object.volumeId) ||
		parsed.exists !== !!native.object ||
		(parsed.exists && native.missingSuffix.length !== 0) ||
		!native.ancestors.some(
			(item) =>
				item.canonicalPath === native.parent.canonicalPath &&
				item.object.volumeId === native.parent.object.volumeId &&
				item.object.fileId === native.parent.object.fileId &&
				item.object.creationTime === native.parent.object.creationTime &&
				item.caseSensitive === native.parent.caseSensitive,
		)
	)
		throw new Error("Native path resolver returned inconsistent object/parent evidence");
	for (const suffix of native.missingSuffix) {
		if (suffix === "." || suffix === ".." || /[\\/]/u.test(suffix))
			throw new Error("Native create suffix is not a path component");
		validateWindowsPath(suffix);
	}
	// Separator spelling is lexical only; authority still comes from the native descriptor.
	if (win32.normalize(native.parent.canonicalPath) !== native.parent.canonicalPath)
		throw new Error("Native path parent is not canonical");
	for (const entry of native.ancestors) {
		Object.freeze(entry.object);
		Object.freeze(entry);
	}
	Object.freeze(native.parent.object);
	Object.freeze(native.parent);
	if (native.object) Object.freeze(native.object);
	Object.freeze(native.componentKeys);
	Object.freeze(native.ancestors);
	Object.freeze(native.missingSuffix);
	Object.freeze(native);
	return Object.freeze(parsed);
}
