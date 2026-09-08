import { describe, expect, test } from "bun:test";
import {
	type FileReferenceContext,
	type FileSelection,
	fileTargetKey,
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
	MAX_FILE_REFERENCE_POSITION,
} from "./file-reference";
import {
	fileLinkLineSuffix,
	filePathFromHref,
	fileSelectionLineSuffix,
	fileTargetFromHref,
	isLocalFileHref,
	localFileDirectory,
	localFileHref,
	localFilePath,
	parseLocalFilePath,
	resolveLocalFilePath,
} from "./markdown-file-path";

const context: FileReferenceContext = { deviceId: "Device_Mixed-Case", cwd: "/work/repo" };
const lines = (first: number, last = first): FileSelection => ({
	startLineNumber: first,
	startColumn: 1,
	endLineNumber: last + 1,
	endColumn: 1,
});
const point = (line: number, column: number): FileSelection => ({
	startLineNumber: line,
	startColumn: column,
	endLineNumber: line,
	endColumn: column,
});
const marker = (value: unknown) => `#nf-local-file=${encodeURIComponent(JSON.stringify(value))}`;
const nfHref = (path: string, deviceId = "Remote_A-bZ", suffix = "") =>
	`nf-file://open?device=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(path)}${suffix}`;

describe("parseLocalFilePath", () => {
	test.each([
		"README.md",
		"README",
		"Makefile",
		"Dockerfile.dev",
		".env.local",
		".gitignore",
		"src/a.ts",
		"../src/a.ts",
		"./console.log",
		"@scope/package/src/a.ts",
		"/etc/hosts",
		"/tmp/a.ts",
		"C:\\Work\\src\\a.ts",
		"c:/Work/src/a.ts",
		"目录/含 空格的 文件.ts",
		"说明 文档.md",
		"src/a%20b.ts",
		"src/100%.ts",
		"src/a%2520b.ts",
	])("keeps complete literal spelling: %s", (path) => {
		expect(parseLocalFilePath(path)).toEqual({ path });
	});

	test("accepts inline-code contents or a complete single-backtick wrapper", () => {
		expect(parseLocalFilePath("`目录/含 空格.ts:10:3`")).toEqual({
			path: "目录/含 空格.ts",
			selection: point(10, 3),
		});
		expect(parseLocalFilePath("`src/a.ts` and `src/b.ts`")).toBeNull();
	});

	test.each([
		["#L10", lines(10)],
		["#L10-L20", lines(10, 20)],
		["#L10-L10", lines(10)],
		[":10", lines(10)],
		[":10-20", lines(10, 20)],
		[":10:3", point(10, 3)],
		[":10:3-20:4", { ...point(10, 3), endLineNumber: 20, endColumn: 4 }],
		[":10:3-10:7", { ...point(10, 3), endColumn: 7 }],
	])("preserves exclusive selection for %s", (suffix, selection) => {
		for (const path of ["README.md", "src/a.ts", "/tmp/a.ts", "C:\\repo\\a.ts"]) {
			expect(parseLocalFilePath(`${path}${suffix}`)).toEqual({ path, selection });
		}
	});

	test.each([
		"#L0",
		"#L-1",
		"#L01",
		"#L10-L0",
		"#L10-L9",
		"#L10-L20-L30",
		"#L10:3",
		"#L1.5",
		"#LNaN",
		"#LInfinity",
		"#L1000000",
		"#L999999999999999999999999",
		":0",
		":-1",
		":01",
		":1.5",
		":10:0",
		":10:-1",
		":10:3-9:4",
		":10:3-10:2",
		":10:3-20",
		":10-20:4",
		":10:1000001",
		":1000001:1",
		":1000000",
		":10-9",
		":10#L20",
		"#L10#L20",
	])("does not reinterpret malformed location as a file: %s", (suffix) => {
		expect(parseLocalFilePath(`/tmp/a.ts${suffix}`)).toBeNull();
		expect(fileTargetFromHref(`src/a.ts${suffix}`, context)).toBeNull();
	});

	test.each([
		"",
		" README.md",
		"README.md ",
		"src/a.ts\n",
		"/tmp/\u0000a.ts",
		"/tmp/\u202ea.ts",
		"/tmp/\ud800a.ts",
		"src/a.ts?raw=1",
		"src/a.ts#intro",
		"#intro",
		"word",
		"console.log",
		"process.env",
		"example.com/a.ts",
		"www.example.com/a.ts",
		"127.0.0.1/a.ts",
		"user@example.com/a.ts",
		"https://example.com/src/a.ts",
		"javascript:src/a.ts",
		"data:text/plain,src/a.ts",
		"vscode://file/tmp/a.ts",
		"file:relative/a.ts",
		"file://remote-server/tmp/a.ts",
		"file://user@localhost/tmp/a.ts",
		"file://localhost:80/tmp/a.ts",
		"file://%6cocalhost/tmp/a.ts",
		"file://localhost\\tmp\\a.ts",
		"//server/share/a.ts",
		"\\\\server\\share\\a.ts",
		"\\rooted\\a.ts",
		"/\\server/share/a.ts",
		"C:relative.ts",
		"C:/a.ts:stream",
		"~someone/a.ts",
		"src/../",
	])("rejects ambiguous or unsafe literals: %s", (value) => {
		expect(parseLocalFilePath(value)).toBeNull();
	});

	test("decodes only the URI layer of legacy local file URIs", () => {
		expect(parseLocalFilePath("file:///tmp/a%2520b.ts#L2-L4")).toEqual({
			path: "/tmp/a%20b.ts",
			selection: lines(2, 4),
		});
		expect(parseLocalFilePath("file://localhost/C:/a%20b.ts:10:3")).toEqual({
			path: "C:/a b.ts",
			selection: point(10, 3),
		});
		expect(parseLocalFilePath("file:///C%3A/a.ts")).toEqual({ path: "C:/a.ts" });
		expect(parseLocalFilePath("file:////host/share/a.ts")).toBeNull();
		expect(fileTargetFromHref("file:///tmp/a.ts")).toBeNull();
		expect(fileTargetFromHref("file:///tmp/a.ts#L2", context)).toEqual({
			deviceId: context.deviceId,
			path: "/tmp/a.ts",
			selection: lines(2),
		});
	});
});

describe("fileTargetFromHref and markers", () => {
	test("requires a captured device even for an absolute ordinary file link", () => {
		for (const href of ["README.md", "src/a.ts#L10", "/tmp/a.ts", "C:/repo/a.ts"]) {
			expect(fileTargetFromHref(href)).toBeNull();
			expect(fileTargetFromHref(href, null)).toBeNull();
		}
		expect(fileTargetFromHref("src/a.ts#L10-L20", context)).toEqual({
			deviceId: context.deviceId,
			path: "/work/repo/src/a.ts",
			selection: lines(10, 20),
		});
		expect(fileTargetFromHref("../README.md", context)?.path).toBe("/work/README.md");
		expect(fileTargetFromHref("/tmp/a.ts", context)?.deviceId).toBe(context.deviceId);
	});

	test("uses Windows cwd lexically on any host", () => {
		expect(
			fileTargetFromHref("src/a.ts:10:3", { deviceId: "Win", cwd: "D:\\项目\\工作区" }),
		).toEqual({ deviceId: "Win", path: "D:/项目/工作区/src/a.ts", selection: point(10, 3) });
	});

	test("rejects invalid or missing context rather than guessing", () => {
		for (const bad of [
			{ deviceId: "", cwd: "/work" },
			{ deviceId: " ", cwd: "/work" },
			{ deviceId: "Remote\nId", cwd: "/work" },
			{ deviceId: "Remote", cwd: "relative" },
			{ deviceId: "Remote", cwd: "//host/work" },
			{ deviceId: "Remote", cwd: "C:work" },
		]) {
			expect(fileTargetFromHref("README.md", bad)).toBeNull();
			expect(fileTargetFromHref("/tmp/a.ts", bad)).toBeNull();
		}
	});

	test("round-trips selected structured targets, case-sensitive devices and literal percent", () => {
		const target = { deviceId: "Remote_BaZ", path: "/tmp/a%20b.ts", selection: lines(10, 20) };
		const href = localFileHref(target);
		expect(href.startsWith("#nf-local-file=")).toBe(true);
		expect(href.startsWith("file:")).toBe(false);
		expect(isLocalFileHref(href)).toBe(true);
		expect(fileTargetFromHref(href)).toEqual(target);
		expect(fileTargetFromHref(href, context)).toEqual(target);
	});

	test("retains legacy string marker and path-only helper compatibility", () => {
		const path = "src/a%20b.ts:10:3";
		const href = localFileHref(path);
		expect(href).toBe(`#nf-local-file=${encodeURIComponent(path)}`);
		expect(localFilePath(path)).toBe("src/a%20b.ts");
		expect(filePathFromHref(href)).toBe("src/a%20b.ts");
		expect(filePathFromHref("src/a%2520b.ts#L10")).toBe("src/a%20b.ts");
		expect(fileTargetFromHref(href)).toBeNull();
		expect(fileTargetFromHref(href, context)).toEqual({
			deviceId: context.deviceId,
			path: "/work/repo/src/a%20b.ts",
			selection: point(10, 3),
		});
	});

	test("relative structured targets require matching captured device and cwd", () => {
		const href = localFileHref({ deviceId: "Other", path: "src/a.ts", selection: lines(3) });
		expect(fileTargetFromHref(href)).toBeNull();
		expect(fileTargetFromHref(href, context)).toBeNull();
		expect(fileTargetFromHref(href, { deviceId: "Other", cwd: "/old/work" })).toEqual({
			deviceId: "Other",
			path: "/old/work/src/a.ts",
			selection: lines(3),
		});
	});

	test("two selections of one file are not collapsed into the same marker", () => {
		const a = localFileHref({ deviceId: "D", path: "/a.ts", selection: lines(1) });
		const b = localFileHref({ deviceId: "D", path: "/a.ts", selection: lines(2) });
		expect(a).not.toBe(b);
		expect(fileTargetFromHref(a)?.selection).toEqual(lines(1));
		expect(fileTargetFromHref(b)?.selection).toEqual(lines(2));
	});

	test("decodes ordinary href paths once without decoding location syntax into metadata", () => {
		expect(fileTargetFromHref("src/含%20空格.ts#L1", context)).toEqual({
			deviceId: context.deviceId,
			path: "/work/repo/src/含 空格.ts",
			selection: lines(1),
		});
		expect(fileTargetFromHref("src/a%2520b.ts", context)?.path).toBe("/work/repo/src/a%20b.ts");
		expect(fileTargetFromHref("src/a%23tag.ts", context)?.path).toBe("/work/repo/src/a#tag.ts");
		const href = localFileHref({ deviceId: "D", path: "/a.ts#L10" });
		expect(fileTargetFromHref(href)).toEqual({ deviceId: "D", path: "/a.ts#L10" });
	});

	test.each([
		undefined,
		"",
		"#L10",
		"#heading",
		"/knowledge/e1",
		"https://example.com/src/a.ts#L10",
		"mailto:user@example.com",
		"data:text/html,src/a.ts",
		"javascript:alert(1)",
		"vscode://file/tmp/a.ts",
		"example.com/src/a.ts",
		"//host/share/a.ts",
		"%2F%2Fhost/share/a.ts",
		"javascript%3A%2Ftmp%2Fa.ts",
		"https%3A%2F%2Fexample.com%2Fa.ts",
		"file%3A%2F%2F%2Ftmp%2Fa.ts",
		"src/a.ts?raw=1",
		"src/a.ts#intro",
		"src/a.ts%3A10",
		"src/%00a.ts",
		"src/%E0%A4%A.ts",
		"#nf-local-file=%",
		"#nf-local-file=%7Bbroken",
		marker({ path: "/a.ts", selection: { ...lines(1), endColumn: -1 } }),
		marker({ path: "/a.ts", deviceId: "D", selection: { ...lines(1), startLineNumber: 1.2 } }),
		marker({ path: "/a.ts", deviceId: "D", selection: { ...lines(1), endLineNumber: 0 } }),
		marker({ path: "javascript:alert(1)", deviceId: "D" }),
		marker({ path: "//host/a.ts", deviceId: "D" }),
		marker({ path: "/a.ts", deviceId: 123 }),
	])("rejects unsafe href or malformed marker: %s", (href) => {
		expect(fileTargetFromHref(href, context)).toBeNull();
	});
});

describe("strict nf-file protocol", () => {
	test("preserves device case in query, not URL authority, and carries lines", () => {
		const href = nfHref("/remote/src/a%20b.ts", "UPPER_and-Lower", "#L10-L20");
		const target = {
			deviceId: "UPPER_and-Lower",
			path: "/remote/src/a%20b.ts",
			selection: lines(10, 20),
		};
		expect(isLocalFileHref(href)).toBe(true);
		expect(parseLocalFilePath(href)).toEqual(target);
		expect(fileTargetFromHref(href)).toEqual(target);
		expect(fileTargetFromHref(href, context)).toEqual(target);
		expect(filePathFromHref(href)).toBe(target.path);
		expect(fileTargetFromHref(nfHref("C:\\Work\\a.ts"))?.path).toBe("C:/Work/a.ts");
	});

	test("accepts either parameter order and form-encoded spaces", () => {
		expect(fileTargetFromHref("nf-file://open?path=%2Ftmp%2Fa+b.ts&device=ABC")).toEqual({
			deviceId: "ABC",
			path: "/tmp/a b.ts",
		});
	});

	test.each([
		"nf-file://Remote?device=D&path=%2Fa.ts",
		"nf-file://OPEN?device=D&path=%2Fa.ts",
		"NF-FILE://open?device=D&path=%2Fa.ts",
		"nf-file://open/?device=D&path=%2Fa.ts",
		"nf-file://user@open?device=D&path=%2Fa.ts",
		"nf-file://open:80?device=D&path=%2Fa.ts",
		"nf-file://%6fpen?device=D&path=%2Fa.ts",
		"nf-file://open?device=D",
		"nf-file://open?path=%2Fa.ts",
		"nf-file://open?device=&path=%2Fa.ts",
		"nf-file://open?device=D&path=src%2Fa.ts",
		"nf-file://open?device=D&path=%2Fa.ts&extra=1",
		"nf-file://open?device=D&device=E&path=%2Fa.ts",
		"nf-file://open?device=D&path=%2Fa.ts&path=%2Fb.ts",
		"nf-file://open?device=D&path=%2Fa.ts#anchor",
		"nf-file://open?device=D&path=%2Fa.ts#L0",
		"nf-file://open?device=D&path=%2Fa.ts#L20-L10",
		"nf-file://open?device=%00D&path=%2Fa.ts",
		"nf-file://open?device=D&path=%2F%2Fhost%2Fa.ts",
		"nf-file://open?device=D&path=C%3Arelative.ts",
		"nf-file://open?device=D&path=javascript%3A%2Fa.ts",
	])("does not admit alternate authorities, schemes, parameters or paths: %s", (href) => {
		expect(isLocalFileHref(href)).toBe(false);
		expect(fileTargetFromHref(href, context)).toBeNull();
		expect(parseLocalFilePath(href)).toBeNull();
	});
});

describe("visible file link line ranges", () => {
	test.each([
		["src/a.ts#L10", ":10"],
		["src/a.ts#L10-L20", ":10-20"],
		["src/a.ts:10:3-12:5", ":10-12"],
		["file:///tmp/中文.ts#L2", ":2"],
		[nfHref("/tmp/a.ts", "RemoteCase", "#L10-L20"), ":10-20"],
		[localFileHref({ path: "/tmp/a.ts", deviceId: "local", selection: lines(3, 5) }), ":3-5"],
		["src/a.ts", ""],
		["https://example.com/a.ts#L10", ""],
		["#L10", ""],
		["/knowledge/e1#L10", ""],
		["javascript:alert(1)", ""],
	])("shows the explicit file location from %s", (href, suffix) => {
		expect(fileLinkLineSuffix(href, "查看文件")).toBe(suffix);
	});

	test.each([
		"a.ts:10-20",
		"a.ts:10–20",
		"a.ts：10-20",
		"a.ts#L10-L20",
	])("does not duplicate an already rendered range in %s", (label) => {
		expect(fileLinkLineSuffix("src/a.ts#L10-L20", label)).toBe("");
	});

	test("does not mistake a filename's literal hash for an appended line label", () => {
		expect(fileLinkLineSuffix(nfHref("/tmp/中文#L10", "local", "#L10"), "中文#L10")).toBe(":10");
		expect(fileLinkLineSuffix("src/a.ts#L10", "a.ts:110")).toBe(":10");
		expect(fileSelectionLineSuffix(lines(10, 20))).toBe(":10-20");
		expect(fileSelectionLineSuffix(point(10, 3))).toBe(":10");
		expect(fileSelectionLineSuffix()).toBe("");
	});
});

describe("lexical resolution and directory helpers", () => {
	test.each([
		["src/a.ts", "/repo", "/repo/src/a.ts"],
		["../a.ts", "/repo/src", "/repo/a.ts"],
		["../../../a.ts", "/repo", "/a.ts"],
		["./src/../a.ts", "/repo", "/repo/a.ts"],
		["src\\a.ts", "D:\\Repo", "D:/Repo/src/a.ts"],
		["C:\\Repo\\src\\..\\a.ts:10:3", undefined, "C:/Repo/a.ts"],
		["/repo/src/../a%20b.ts#L1", undefined, "/repo/a%20b.ts"],
		["a.ts", "C:/", "C:/a.ts"],
		["a.ts", "/", "/a.ts"],
		["~/a.ts", "/repo", null],
		["a.ts", undefined, null],
		["a.ts", "relative", null],
		["a.ts", "//host/share", null],
		["a.ts", "C:relative", null],
		["//host/share/a.ts", "/repo", null],
	])("resolves %s against %s without OS or process cwd", (path, base, expected) => {
		expect(resolveLocalFilePath(path, base)).toBe(expected);
	});

	test.each([
		["/repo/src/a.ts", "/repo/src"],
		["/repo/src/a.ts:10:3", "/repo/src"],
		["/repo/src/a.ts#L10-L20", "/repo/src"],
		["C:\\Repo\\src\\a.ts:10", "C:/Repo/src"],
		["C:\\a.ts", "C:/"],
		["C:\\", "C:/"],
		["/a.ts", "/"],
		["/", "/"],
		["src/a.ts", "src"],
		["src/nested/", "src"],
		["README.md", "."],
		["file:///tmp/a%20b.ts#L2", "/tmp"],
		["//host/share/a.ts", "."],
		["C:relative.ts", "."],
		["/tmp/a.ts#L0", "."],
	])("gets lexical directory of %s", (path, directory) => {
		expect(localFileDirectory(path)).toBe(directory);
	});
});

describe("POSIX path grammar", () => {
	test("real explicit URIs keep backslash filenames distinct from slash paths and siblings", () => {
		const cases = [
			["nf-file://open?device=Linux&path=%2Fwork%2Fa%5Cb.ts#L10-L20", "/work/a\\b.ts"],
			["nf-file://open?device=Linux&path=%2Fwork%2Fa%2Fb.ts#L10-L20", "/work/a/b.ts"],
			["nf-file://open?device=Linux&path=%2Fwork%2Fa%255Cb.ts#L10-L20", "/work/a%5Cb.ts"],
		] as const;
		const keys: string[] = [];
		for (const [href, path] of cases) {
			const expected = { deviceId: "Linux", path, selection: lines(10, 20) };
			expect(isLocalFileHref(href)).toBe(true);
			expect(parseLocalFilePath(href)).toEqual(expected);
			const target = fileTargetFromHref(href);
			expect(target).toEqual(expected);
			if (!target) throw new Error("Expected an explicit file target");
			expect(fileTargetFromHref(localFileHref(target))).toEqual(expected);
			expect(fileTargetFromHref(href, { deviceId: "Windows", cwd: "C:/work" })).toEqual(expected);
			keys.push(fileTargetKey(target));
		}
		expect(new Set(keys).size).toBe(cases.length);
		expect(localFileDirectory(cases[0][1])).toBe("/work");
		expect(localFileDirectory(cases[2][1])).toBe("/work");
		expect(fileTargetFromHref(cases[0][0])?.path).toBe("/work/a\\b.ts");
	});

	test("relative hrefs follow captured POSIX cwd without treating backslashes as separators", () => {
		const posixContext = { deviceId: "Linux", cwd: "/work/sub\\dir" };
		expect(fileTargetFromHref("a%5Cb.ts#L10", posixContext)).toEqual({
			deviceId: "Linux",
			path: "/work/sub\\dir/a\\b.ts",
			selection: lines(10),
		});
		expect(fileTargetFromHref("../a.ts", posixContext)?.path).toBe("/work/a.ts");
		expect(fileTargetFromHref("file:///work/a%5Cb.ts#L2", posixContext)).toEqual({
			deviceId: "Linux",
			path: "/work/a\\b.ts",
			selection: lines(2),
		});
	});

	test.each([
		["/work/a\\b.ts", undefined, "/work/a\\b.ts"],
		["src\\a.ts", "/work", "/work/src\\a.ts"],
		["src\\..\\a.ts", "/work", "/work/src\\..\\a.ts"],
		["../a.ts", "/work/sub\\dir", "/work/a.ts"],
		["src\\a.ts", "C:/work", "C:/work/src/a.ts"],
		["src/..\\a.ts", "C:\\work", "C:/work/a.ts"],
		["C:\\work\\a/b.ts", undefined, "C:/work/a/b.ts"],
	])("resolves %s by the absolute path or base grammar", (path, base, expected) => {
		expect(resolveLocalFilePath(path, base)).toBe(expected);
	});

	test.each([
		["/work/a\\b.ts", "/work"],
		["/work/sub\\dir/a.ts#L2", "/work/sub\\dir"],
		["/work/sub\\dir/", "/work"],
		["src/a\\b.ts", "src"],
		["src\\a.ts", "."],
		["C:/work\\a.ts", "C:/work"],
		["nf-file://open?device=Linux&path=%2Fwork%2Fa%5Cb.ts#L2", "/work"],
	])("dirname preserves grammar for %s", (path, directory) => {
		expect(localFileDirectory(path)).toBe(directory);
	});
});

describe("bounded paths, coordinates and metadata", () => {
	test("accepts exactly the shared path limit and rejects oversized paths before use", () => {
		const path = `/${"x".repeat(MAX_FILE_REFERENCE_PATH_CHARS - 4)}.ts`;
		expect(path.length).toBe(MAX_FILE_REFERENCE_PATH_CHARS);
		expect(parseLocalFilePath(path)).toEqual({ path });
		expect(parseLocalFilePath(`${path}x`)).toBeNull();
		expect(fileTargetFromHref(marker({ deviceId: "D", path: `${path}x` }))).toBeNull();
		expect(() => localFileHref({ path: `${path}x`, deviceId: "D" })).toThrow();
		expect(resolveLocalFilePath(path.slice(1), "/base")).toBeNull();
	});

	test("permits full-length Unicode paths across encoded markers", () => {
		const path = `/${"中".repeat(MAX_FILE_REFERENCE_PATH_CHARS - 4)}.ts`;
		const href = localFileHref({ path, deviceId: "D", selection: lines(2) });
		expect(fileTargetFromHref(href)).toEqual({ path, deviceId: "D", selection: lines(2) });
	});

	test("accepts exactly the metadata budget and rejects the next byte", () => {
		const empty = { path: "/a.ts", deviceId: "" };
		const deviceId = "D".repeat(MAX_FILE_REFERENCE_METADATA_BYTES - JSON.stringify(empty).length);
		const target = { ...empty, deviceId };
		expect(fileTargetFromHref(localFileHref(target))).toEqual(target);
		expect(fileTargetFromHref(nfHref(target.path, deviceId))).toEqual(target);
		expect(fileTargetFromHref(marker({ ...target, deviceId: `${deviceId}D` }))).toBeNull();
	});

	test("checks the shared position limit including the exclusive end", () => {
		const lastWholeLine = MAX_FILE_REFERENCE_POSITION - 1;
		expect(parseLocalFilePath(`a.ts#L${lastWholeLine}`)?.selection).toEqual(lines(lastWholeLine));
		expect(parseLocalFilePath(`a.ts#L${MAX_FILE_REFERENCE_POSITION}`)).toBeNull();
		expect(parseLocalFilePath(`a.ts:${MAX_FILE_REFERENCE_POSITION}:1`)?.selection).toEqual(
			point(MAX_FILE_REFERENCE_POSITION, 1),
		);
		expect(parseLocalFilePath(`a.ts:1:${MAX_FILE_REFERENCE_POSITION}`)?.selection).toEqual(
			point(1, MAX_FILE_REFERENCE_POSITION),
		);
		expect(parseLocalFilePath(`a.ts:1:${MAX_FILE_REFERENCE_POSITION + 1}`)).toBeNull();
		expect(parseLocalFilePath(`a.ts#L${"9".repeat(MAX_FILE_REFERENCE_METADATA_BYTES)}`)).toBeNull();
	});

	test("enforces metadata bytes, not UTF-16 character counts", () => {
		const deviceId = "中".repeat(Math.ceil(MAX_FILE_REFERENCE_METADATA_BYTES / 3));
		const target = { path: "/a.ts", deviceId };
		expect(JSON.stringify(target).length).toBeLessThan(MAX_FILE_REFERENCE_METADATA_BYTES);
		expect(fileTargetFromHref(marker(target))).toBeNull();
		expect(fileTargetFromHref(nfHref(target.path, deviceId))).toBeNull();
		expect(fileTargetFromHref("a.ts", { deviceId, cwd: "/repo" })).toBeNull();
		expect(() => localFileHref(target)).toThrow();
	});

	test("rejects oversized encoded input, JSON payloads and irrelevant metadata", () => {
		const long = "x".repeat(MAX_FILE_REFERENCE_METADATA_BYTES * 4);
		expect(parseLocalFilePath(`${long}.ts`)).toBeNull();
		expect(fileTargetFromHref(`#nf-local-file=${long}`, context)).toBeNull();
		expect(fileTargetFromHref(marker({ path: "/a.ts", deviceId: "D", padding: long }))).toBeNull();
		expect(isLocalFileHref(nfHref("/a.ts", long))).toBe(false);
	});

	test("rejects invalid structured selection without rounding or truncating", () => {
		for (const bad of [
			{ ...point(1, 1), startColumn: 0 },
			{ ...point(1, 1), endColumn: 1.5 },
			{ ...point(1, 1), endColumn: Number.NaN },
			{ ...point(1, 1), endLineNumber: Number.POSITIVE_INFINITY },
			{ ...point(2, 2), endLineNumber: 1 },
			{ ...point(1, 2), endColumn: 1 },
			{ ...point(1, 1), endColumn: MAX_FILE_REFERENCE_POSITION + 1 },
		]) {
			expect(() => localFileHref({ path: "/a.ts", deviceId: "D", selection: bad })).toThrow();
			expect(
				fileTargetFromHref(marker({ path: "/a.ts", deviceId: "D", selection: bad })),
			).toBeNull();
		}
	});
});
