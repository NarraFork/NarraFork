import { describe, expect, test } from "bun:test";
import {
	buildGitFileTree,
	compactGitFileTree,
	type GitFileTreeDirectoryNode,
} from "./git-file-tree";

interface TestFile {
	path: string;
	status: string;
}

function directory(
	nodes: ReturnType<typeof buildGitFileTree<TestFile>>,
	name: string,
): GitFileTreeDirectoryNode<TestFile> {
	const node = nodes.find((candidate) => candidate.type === "directory" && candidate.name === name);
	if (!node || node.type !== "directory") {
		throw new Error(`Directory not found: ${name}`);
	}
	return node;
}

describe("buildGitFileTree", () => {
	test("groups nested paths with folders first, sorted names, and aggregate counts", () => {
		const tree = buildGitFileTree<TestFile>([
			{ path: "z.ts", status: " M" },
			{ path: "src/z.ts", status: " M" },
			{ path: "docs/readme.md", status: "??" },
			{ path: "src/a.ts", status: "M " },
			{ path: "a.ts", status: "??" },
			{ path: "src/nested/deep.ts", status: "M " },
		]);

		expect(tree.map((node) => `${node.type}:${node.name}`)).toEqual([
			"directory:docs",
			"directory:src",
			"file:a.ts",
			"file:z.ts",
		]);

		const src = directory(tree, "src");
		expect(src.path).toBe("src");
		expect(src.fileCount).toBe(3);
		expect(src.children.map((node) => `${node.type}:${node.name}`)).toEqual([
			"directory:nested",
			"file:a.ts",
			"file:z.ts",
		]);
		expect(directory(src.children, "nested").fileCount).toBe(1);
	});

	test("normalizes separators for hierarchy while preserving the original Git path", () => {
		const originalPath = ".\\src\\\\nested\\file.ts";
		const file = { path: originalPath, status: " M" };
		const tree = buildGitFileTree([file]);
		const src = directory(tree, "src");
		const nested = directory(src.children, "nested");
		const leaf = nested.children[0];

		expect(src.path).toBe("src");
		expect(nested.path).toBe("src/nested");
		expect(leaf?.type).toBe("file");
		if (leaf?.type !== "file") throw new Error("Expected file node");
		expect(leaf.name).toBe("file.ts");
		expect(leaf.path).toBe(originalPath);
		expect(leaf.file).toBe(file);
	});

	test("keeps identical basenames in separate directories", () => {
		const tree = buildGitFileTree([
			{ path: "client/index.ts", status: " M" },
			{ path: "server/index.ts", status: "M " },
		]);

		expect(directory(tree, "client").children[0]).toMatchObject({
			type: "file",
			name: "index.ts",
			path: "client/index.ts",
		});
		expect(directory(tree, "server").children[0]).toMatchObject({
			type: "file",
			name: "index.ts",
			path: "server/index.ts",
		});
	});
});

describe("compactGitFileTree", () => {
	test("merges single-child directory chains and keeps the deepest path", () => {
		const compacted = compactGitFileTree(
			buildGitFileTree([{ path: "frontend/components/chapter/GitPanel.tsx", status: " M" }]),
		);

		expect(compacted).toHaveLength(1);
		const merged = compacted[0];
		if (merged?.type !== "directory") throw new Error("Expected directory node");
		expect(merged.name).toBe("frontend/components/chapter");
		expect(merged.path).toBe("frontend/components/chapter");
		expect(merged.fileCount).toBe(1);
		expect(merged.children).toEqual([
			{
				type: "file",
				name: "GitPanel.tsx",
				path: "frontend/components/chapter/GitPanel.tsx",
				file: { path: "frontend/components/chapter/GitPanel.tsx", status: " M" },
			},
		]);
	});

	test("stops merging where a directory branches or holds files", () => {
		const compacted = compactGitFileTree(
			buildGitFileTree([
				{ path: "src/app/a.ts", status: " M" },
				{ path: "src/app/nested/b.ts", status: " M" },
				{ path: "lib/only/deep/c.ts", status: "??" },
			]),
		);

		expect(
			compacted.map((node) => (node.type === "directory" ? node.name : `file:${node.name}`)),
		).toEqual(["lib/only/deep", "src/app"]);

		const srcApp = compacted.find((node) => node.type === "directory" && node.name === "src/app");
		if (srcApp?.type !== "directory") throw new Error("Expected directory node");
		expect(srcApp.fileCount).toBe(2);
		expect(srcApp.children.map((node) => `${node.type}:${node.name}`)).toEqual([
			"directory:nested",
			"file:a.ts",
		]);
	});
});
