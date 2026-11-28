import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalize, posix, resolve, win32 } from "node:path";
import { getNarraforkPath } from "../lib/narrafork-home";
import {
	legacyTreeSnapshotKey,
	legacyTreeSnapshotPhysicalDir,
	snapshotPathIdentity,
	treeSnapshotKey,
	treeSnapshotPhysicalDir,
} from "./tree-snapshot-paths";

/** Frozen pre-change algorithm, including its host resolution and backslash ambiguity. */
function oldHostIdentity(path: string): string {
	let normalized = normalize(resolve(path)).replaceAll("\\", "/");
	if (normalized !== "/" && !/^[a-zA-Z]:\/$/.test(normalized))
		normalized = normalized.replace(/\/+$/, "");
	if (process.platform === "win32" || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//"))
		return normalized.toLowerCase();
	return normalized;
}

function physicalDirForKey(key: string): string {
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return getNarraforkPath("tree-snapshots", digest);
}

describe("tree snapshot path identity", () => {
	test("preserves existing local keys and footprints for ordinary paths", () => {
		const paths =
			process.platform === "win32"
				? [
						"C:\\Work\\Project",
						"c:/WORK/project/..",
						"C:\\",
						"\\\\Server\\Share\\Project\\",
						"\\\\Server\\Share\\",
						".",
						"relative/资料/../project/",
					]
				: [
						"/work/project",
						"/work/project///",
						"/work/project/../other",
						"/",
						".",
						"relative/资料/../project/",
					];
		for (const path of paths) {
			const oldKey = `local\u0000${oldHostIdentity(path)}`;
			expect(treeSnapshotKey("local", path)).toBe(oldKey);
			expect(legacyTreeSnapshotKey("local", path)).toBe(oldKey);
			expect(treeSnapshotPhysicalDir("local", path)).toBe(physicalDirForKey(oldKey));
			expect(legacyTreeSnapshotPhysicalDir("local", path)).toBe(physicalDirForKey(oldKey));
		}
	});

	test("absolutizes local relative paths and normalizes only real separators", () => {
		const path = "relative/project/../final/";
		expect(snapshotPathIdentity(path)).toBe(oldHostIdentity(path));
		expect(snapshotPathIdentity("/work//project/../final///", "posix")).toBe("/work/final");
		expect(snapshotPathIdentity("/", "posix")).toBe("/");
		expect(snapshotPathIdentity("/work/..cache/", "posix")).toBe("/work/..cache");
		expect(snapshotPathIdentity("/work/../outside", "posix")).toBe("/outside");
	});

	test("distinguishes POSIX literal backslashes from nested paths and trailing separators", () => {
		const literal = "/work/a\\b";
		const nested = "/work/a/b";
		expect(snapshotPathIdentity(literal, "posix")).toBe(literal);
		expect(snapshotPathIdentity(`${literal}///`, "posix")).toBe(literal);
		expect(snapshotPathIdentity("/work/project\\", "posix")).toBe("/work/project\\");
		expect(treeSnapshotKey("local", literal, "posix")).not.toBe(
			treeSnapshotKey("local", nested, "posix"),
		);
		expect(treeSnapshotPhysicalDir("local", literal, "posix")).not.toBe(
			treeSnapshotPhysicalDir("local", nested, "posix"),
		);
		expect(treeSnapshotPhysicalDir("local", "/work/project\\", "posix")).not.toBe(
			treeSnapshotPhysicalDir("local", "/work/project/", "posix"),
		);
	});

	test("preserves POSIX case and treats Windows-looking names literally", () => {
		expect(snapshotPathIdentity("/work/C:\\Project\\file", "posix")).toBe(
			"/work/C:\\Project\\file",
		);
		expect(treeSnapshotKey("remote", "/work/Project\\File")).not.toBe(
			treeSnapshotKey("remote", "/work/project\\file"),
		);
	});

	test("normalizes Windows drives, mixed separators, case, and parent components", () => {
		const expected = "c:/work/project";
		for (const path of [
			"C:\\Work\\Project",
			"c:/work/project/",
			"C:/WORK/temporary/../Project///",
		]) {
			expect(snapshotPathIdentity(path, "windows")).toBe(expected);
			expect(treeSnapshotKey("remote", path)).toBe(`remote\u0000${expected}`);
			expect(treeSnapshotKey("remote", path, "windows")).toBe(`remote\u0000${expected}`);
		}
		expect(snapshotPathIdentity("C:\\", "windows")).toBe("c:/");
		expect(snapshotPathIdentity("C:\\Work\\..cache\\", "windows")).toBe("c:/work/..cache");
		expect(snapshotPathIdentity("C:\\Work\\..\\Outside", "windows")).toBe("c:/outside");
		expect(treeSnapshotKey("remote", "D:\\Work\\Project")).not.toBe(
			treeSnapshotKey("remote", "C:\\Work\\Project"),
		);
	});

	test("supports UNC paths without borrowing host cwd or changing legacy root spelling", () => {
		expect(snapshotPathIdentity("\\\\Server\\Share\\Work\\", "windows")).toBe(
			"//server/share/work",
		);
		expect(snapshotPathIdentity("//SERVER/Share/", "windows")).toBe("//server/share");
		expect(treeSnapshotKey("remote", "\\\\Server\\Share\\Work\\")).toBe(
			"remote\u0000\\\\server\\share\\work",
		);
		expect(treeSnapshotKey("remote", "\\\\Server\\Share\\Work\\")).toBe(
			treeSnapshotKey("remote", "//server/share/work/", "windows"),
		);
		expect(treeSnapshotKey("remote", "\\\\Server\\Share\\")).toBe("remote\u0000\\\\server\\share");
		expect(treeSnapshotKey("local", "\\\\Server\\Share\\", "windows")).toBe(
			"local\u0000//server/share",
		);
		expect(treeSnapshotKey("remote", "\\\\Other\\Share\\Work")).not.toBe(
			treeSnapshotKey("remote", "\\\\Server\\Share\\Work"),
		);
	});

	test("remote double-argument paths infer only unambiguous absolute grammar", () => {
		expect(treeSnapshotKey("remote", "/Work/Project\\Name/")).toBe(
			"remote\u0000/Work/Project\\Name",
		);
		expect(treeSnapshotKey("remote", "//Work/Project\\Name/")).toBe(
			"remote\u0000/Work/Project\\Name",
		);
		expect(treeSnapshotKey("remote", "C:/Work/Project")).toBe("remote\u0000c:/work/project");
		expect(treeSnapshotKey("remote", "//Server/Share/Project")).toBe(
			"remote\u0000/Server/Share/Project",
		);
		expect(treeSnapshotKey("remote", "//Server/Share/Project", "windows")).toBe(
			"remote\u0000\\\\server\\share\\project",
		);
		expect(treeSnapshotPhysicalDir("remote", "/work/project")).toBe(
			physicalDirForKey("remote\u0000/work/project"),
		);
		expect(treeSnapshotPhysicalDir("remote", "C:\\Work\\Project")).toBe(
			physicalDirForKey("remote\u0000c:/work/project"),
		);
	});

	test("remote keys round-trip their grammar without an out-of-band flavor", () => {
		for (const path of [
			"/Work/Project\\Name/",
			"//Server/Share/Project",
			"C:\\Work\\Project",
			"C:/",
			"\\\\Server\\Share\\Work\\",
			"\\\\Server\\Share\\",
		]) {
			const key = treeSnapshotKey("remote", path);
			const [deviceId, identity] = key.split("\u0000") as [string, string];
			expect(treeSnapshotKey(deviceId, identity)).toBe(key);
			expect(treeSnapshotPhysicalDir(deviceId, identity)).toBe(
				treeSnapshotPhysicalDir("remote", path),
			);
		}
		const explicitUNC = treeSnapshotKey("remote", "//Server/Share/Work", "windows");
		const [deviceId, identity] = explicitUNC.split("\u0000") as [string, string];
		expect(treeSnapshotKey(deviceId, identity)).toBe(explicitUNC);
	});

	test("rejects remote paths that would need host cwd or a current Windows drive", () => {
		for (const path of ["relative/project", "C:relative", "\\project", ".", ""]) {
			expect(() => treeSnapshotKey("remote", path)).toThrow("fully absolute");
			expect(() => treeSnapshotPhysicalDir("remote", path)).toThrow("fully absolute");
		}
		expect(() => treeSnapshotKey("remote", "relative", "posix")).toThrow("fully absolute");
		expect(() => treeSnapshotKey("remote", "C:relative", "windows")).toThrow("fully absolute");
		const foreignFlavor = process.platform === "win32" ? "posix" : "windows";
		expect(() => snapshotPathIdentity("relative", foreignFlavor)).toThrow("fully absolute");
	});

	test("keeps the old host algorithm separate for historical markers and objects", () => {
		for (const path of ["/work/a\\b", "/work/a/b", "/work/project\\", "C:\\Work\\Project"]) {
			const oldKey = `local\u0000${oldHostIdentity(path)}`;
			expect(legacyTreeSnapshotKey("local", path)).toBe(oldKey);
			expect(legacyTreeSnapshotPhysicalDir("local", path)).toBe(physicalDirForKey(oldKey));
		}
		if (process.platform === "win32") return;
		const literal = "/work/a\\b";
		const nested = "/work/a/b";
		expect(legacyTreeSnapshotKey("local", literal)).toBe(legacyTreeSnapshotKey("local", nested));
		expect(legacyTreeSnapshotPhysicalDir("local", literal)).toBe(
			legacyTreeSnapshotPhysicalDir("local", nested),
		);
		expect(treeSnapshotKey("local", nested)).toBe(legacyTreeSnapshotKey("local", nested));
		expect(treeSnapshotKey("local", literal)).not.toBe(legacyTreeSnapshotKey("local", literal));
		expect(treeSnapshotPhysicalDir("local", literal)).not.toBe(
			legacyTreeSnapshotPhysicalDir("local", literal),
		);
	});

	test("agrees with the old Windows algorithm for supported Windows paths on any host", () => {
		for (const path of [
			"C:\\Work\\Project",
			"c:/WORK/project/../Final/",
			"C:\\",
			"\\\\Server\\Share\\Project\\",
			"\\\\Server\\Share\\",
		]) {
			const normalized = win32.normalize(win32.resolve(path)).replaceAll("\\", "/");
			const oldIdentity = (
				/^[a-zA-Z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "")
			).toLowerCase();
			expect(snapshotPathIdentity(path, "windows")).toBe(oldIdentity);
		}
		expect(snapshotPathIdentity("/work/Project/", "posix")).toBe(posix.resolve("/work/Project/"));
	});
});
