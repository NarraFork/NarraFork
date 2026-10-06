import { describe, expect, it } from "bun:test";
import { subagentFilePathDisplays } from "./subagent-file-paths";

const labels = { unknownDevice: "unknown device", unknownWorkspace: "unknown workspace" };
const file = {
	deviceId: "local",
	workspacePath: "/home/user/project",
	filePath: "src/index.ts",
};

function display(workspacePath: string | null, filePath: string) {
	return subagentFilePathDisplays([{ ...file, workspacePath, filePath }], labels)[0];
}

describe("subagent file path displays", () => {
	it("omits one known location but retains full location in the title", () => {
		expect(subagentFilePathDisplays([file], labels)).toEqual([
			{
				path: "src/index.ts",
				location: "",
				title: "local · /home/user/project · /home/user/project/src/index.ts",
			},
		]);
	});

	it.each([
		["/repo", "/repo/src/a.ts", "src/a.ts"],
		["/repo/", "/repo/src/a.ts", "src/a.ts"],
		["/", "/src/a.ts", "src/a.ts"],
		["/repo", "src/a.ts", "src/a.ts"],
		["repo", "src/a.ts", "src/a.ts"],
		["repo", "repo/src/a.ts", "repo/src/a.ts"],
		["/repo", "/repo-copy/a.ts", "/repo-copy/a.ts"],
		["/repo", "/other/a.ts", "/other/a.ts"],
		["/repo", "/repo", "/repo"],
		["/repo", "/repo//a.ts", "/repo//a.ts"],
		["/", "//host/a.ts", "//host/a.ts"],
		["/repo", "../a.ts", "../a.ts"],
		["/repo", "/repo/../other/a.ts", "/repo/../other/a.ts"],
		["/repo", "/repo/src/../a.ts", "/repo/src/../a.ts"],
		["/a/../repo", "/a/../repo/a.ts", "/a/../repo/a.ts"],
		["/repo", "/repo\\outside/a.ts", "/repo\\outside/a.ts"],
		["/repo", "/repo/a\\b.ts", "a\\b.ts"],
		["C:\\repo", "C:\\repo\\src\\a.ts", "src\\a.ts"],
		["C:\\repo\\", "C:/repo/src/a.ts", "src/a.ts"],
		["C:/repo", "C:\\repo\\src\\a.ts", "src\\a.ts"],
		["C:\\", "C:\\src\\a.ts", "src\\a.ts"],
		["C:\\repo", "C:\\repo-copy\\a.ts", "C:\\repo-copy\\a.ts"],
		["C:\\repo", "D:\\repo\\a.ts", "D:\\repo\\a.ts"],
		["C:\\repo", "C:\\Repo\\a.ts", "C:\\Repo\\a.ts"],
		["C:\\repo", "C:src\\a.ts", "C:src\\a.ts"],
		["C:\\repo", "src\\a.ts", "src\\a.ts"],
		["\\\\host\\share", "\\\\host\\share\\src\\a.ts", "src\\a.ts"],
		["\\\\host\\share", "\\\\host\\share-copy\\a.ts", "\\\\host\\share-copy\\a.ts"],
		[null, "/repo/a.ts", "/repo/a.ts"],
	])("formats workspace %s and file %s without guessing filesystem identity", (root, path, want) => {
		expect(display(root, path).path).toBe(want);
	});

	it.each([
		["/repo/", "src/a.ts", "/repo/src/a.ts"],
		["/", "a.ts", "/a.ts"],
		["C:\\repo", "src\\a.ts", "C:\\repo\\src\\a.ts"],
		["C:\\repo\\", "src\\a.ts", "C:\\repo\\src\\a.ts"],
		["C:/repo", "src/a.ts", "C:/repo/src/a.ts"],
		["/repo", "/outside/a.ts", "/outside/a.ts"],
		["repo", "src/a.ts", "repo/src/a.ts"],
		["C:\\repo", "C:src\\a.ts", "C:src\\a.ts"],
	])("preserves the complete file location in title: %s / %s", (root, path, full) => {
		expect(display(root, path).title).toBe(`local · ${root} · ${full}`);
	});

	it("shows only the differing device when the workspace is shared", () => {
		const rows = subagentFilePathDisplays([file, { ...file, deviceId: "remote" }], labels);
		expect(rows.map((row) => row.location)).toEqual(["local", "remote"]);
	});

	it("uses the shortest distinct workspace suffix, omitting a common device", () => {
		const workspaces = ["/home/alice/project", "/work/bob/project", "/work/tools"];
		const rows = subagentFilePathDisplays(
			workspaces.map((workspacePath) => ({ ...file, workspacePath })),
			labels,
		);
		expect(rows.map((row) => row.location)).toEqual(["alice/project", "bob/project", "tools"]);
	});

	it("extends suffixes far enough for repeated parent names and drive roots", () => {
		for (const workspaces of [
			["/one/work/repo", "/two/work/repo"],
			["C:\\work\\repo", "D:\\work\\repo"],
			["repo", "/repo"],
			["/repo", "/repo/"],
			["/", "C:\\"],
			["\\\\one\\share\\repo", "\\\\two\\share\\repo"],
		]) {
			const rows = subagentFilePathDisplays(
				workspaces.map((workspacePath) => ({ ...file, workspacePath })),
				labels,
			);
			expect(new Set(rows.map((row) => row.location)).size).toBe(workspaces.length);
		}
	});

	it("uses both device and workspace when both vary", () => {
		const rows = subagentFilePathDisplays(
			[file, { ...file, deviceId: "remote", workspacePath: "/work/other" }],
			labels,
		);
		expect(rows.map((row) => row.location)).toEqual(["local · project", "remote · other"]);
	});

	it.each([undefined, null, ""])("never treats missing metadata (%s) as local", (missing) => {
		const rows = subagentFilePathDisplays(
			[{ ...file, deviceId: missing, workspacePath: missing }],
			labels,
		);
		expect(rows[0].location).toBe("unknown device · unknown workspace");
		expect(rows[0].title).toBe("unknown device · unknown workspace · src/index.ts");
	});

	it("retains the individual unknown dimension and disambiguates it from known locations", () => {
		expect(
			subagentFilePathDisplays([file, { ...file, deviceId: null }], labels).map(
				(row) => row.location,
			),
		).toEqual(["local", "unknown device"]);
		expect(
			subagentFilePathDisplays([file, { ...file, workspacePath: null }], labels).map(
				(row) => row.location,
			),
		).toEqual(["project", "unknown workspace"]);
	});

	it("does not mutate paths or location identity", () => {
		const files = Object.freeze([
			Object.freeze({ ...file, filePath: "/home/user/project/src/index.ts" }),
		]);
		subagentFilePathDisplays(files, labels);
		expect(files[0].filePath).toBe("/home/user/project/src/index.ts");
		expect(files[0].workspacePath).toBe(file.workspacePath);
	});
});
