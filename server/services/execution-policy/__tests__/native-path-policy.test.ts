import { describe, expect, test } from "bun:test";
import {
	windowsPathSemantics,
	withNativePathDescriptors,
} from "@server/lib/agent/execution/path-semantics";
import type { NativePathAncestorV2, NativePathDescriptorV2 } from "@shared/target-native-path";
import { normalizeExecutionPolicyRuleSet } from "../normalize";
import { evaluatePathPolicy } from "../path-policy";

function directory(
	path: string,
	id: number,
	sensitive: boolean,
	parent?: NativePathDescriptorV2,
): NativePathDescriptorV2 {
	const object = {
		volumeId: "native-volume",
		fileId: id.toString(16).padStart(32, "0"),
		creationTime: "100",
	};
	const root: NativePathAncestorV2 = {
		canonicalPath: "C:\\",
		object: { ...object, fileId: "1".padStart(32, "0") },
		caseSensitive: false,
	};
	const ancestors: NativePathAncestorV2[] = parent
		? [
				...parent.ancestors,
				{
					canonicalPath: "C:\\case",
					object: parent.object as typeof object,
					caseSensitive: parent.caseSensitive as boolean,
				},
			]
		: [root];
	return {
		version: 2,
		platform: "windows",
		pathSlotKey: id.toString(16).padStart(64, "0"),
		componentKeys: parent
			? [...parent.componentKeys, path.slice(path.lastIndexOf("\\") + 1)]
			: ["root", "CASE"],
		volumeId: object.volumeId,
		ancestors,
		parent: ancestors[ancestors.length - 1],
		missingSuffix: [],
		object,
		caseSensitive: sensitive,
	};
}

function setup() {
	const parent = directory("C:\\case", 2, true);
	const upper = directory("C:\\case\\Work", 3, false, parent);
	const lower = directory("C:\\case\\work", 4, false, parent);
	const observed = new Map([
		["C:\\case", parent],
		["C:\\case\\Work", upper],
		["C:\\case\\work", lower],
	]);
	const paths = withNativePathDescriptors(windowsPathSemantics, (path) =>
		observed.get(windowsPathSemantics.normalize(path)),
	);
	const rules = normalizeExecutionPolicyRuleSet(
		{
			whitelistDirs: [{ path: "C:\\case", accessLevel: "full" }],
			blacklistDirs: [{ path: "C:\\case\\Work", denyLevel: "denyAll" }],
		},
		"project",
	);
	return { parent, upper, lower, observed, paths, rules };
}

describe("Windows native authorization", () => {
	test("a sensitive Work deny hole never folds work into it", () => {
		const { paths, rules } = setup();
		expect(
			evaluatePathPolicy({
				path: "C:\\case\\Work",
				paths,
				operation: "write",
				whitelist: rules.directoryWhitelist,
				blacklist: rules.directoryBlacklist,
			}).decision,
		).toBe("deny");
		expect(
			evaluatePathPolicy({
				path: "C:\\case\\work",
				paths,
				operation: "write",
				whitelist: rules.directoryWhitelist,
				blacklist: rules.directoryBlacklist,
			}).decision,
		).toBe("allow");
	});
	test("native insensitive aliases remain available without lexical lowercasing", () => {
		const { upper, paths, observed } = setup();
		// This alias is a proved *native* observation, not a guessed string match.
		observed.set("C:\\CASE\\Work", upper);
		expect(paths.equals("C:\\CASE\\Work", "C:\\case\\Work")).toBe(true);
		expect(windowsPathSemantics.equals("C:\\CASE\\Work", "C:\\case\\Work")).toBe(false);
	});
	test("a missing deny proof cannot silently fall through to broad workspace access", () => {
		const { paths, rules, observed } = setup();
		observed.delete("C:\\case\\Work");
		expect(() =>
			evaluatePathPolicy({
				path: "C:\\case\\work",
				paths,
				operation: "write",
				whitelist: rules.directoryWhitelist,
				blacklist: rules.directoryBlacklist,
			}),
		).toThrow("NATIVE_PATH_CAPABILITY_NOT_READY");
	});
	test("original parent/root incarnation is not replaced by a current same-name directory", () => {
		const { paths, lower, observed } = setup();
		const changed = structuredClone(lower);
		changed.ancestors[1].object.fileId = "9".padStart(32, "0");
		observed.set("C:\\case\\work", changed);
		expect(paths.contains("C:\\case", "C:\\case\\work")).toBe(false);
	});
});
