import { describe, expect, test } from "bun:test";
import type { TreeNodeData } from "@mantine/core";
import type { ArchiveEntryInfo } from "../../../lib/api/file-references";
import {
	type ArchiveNodeProps,
	buildArchiveTree,
	MAX_NODES_PER_LEVEL,
	MAX_TREE_DEPTH,
	TRUNCATED_PREFIX,
} from "./archive-tree";

function entry(name: string, isDirectory = name.endsWith("/")): ArchiveEntryInfo {
	return {
		name,
		isDirectory,
		isSymlink: false,
		isSpecial: false,
		encrypted: false,
		compressionMethod: 8,
		compressedSize: 1,
		uncompressedSize: 1,
		readable: !isDirectory,
	} as ArchiveEntryInfo;
}

/** Stable shape for comparison: [label, kind, children?]. */
function shape(nodes: TreeNodeData[]): unknown[] {
	return nodes.map((node) => {
		const props = node.nodeProps as ArchiveNodeProps | undefined;
		if (props?.entry) return [node.label, "file", node.value];
		return [node.label, "folder", node.value, shape(node.children ?? [])];
	});
}

function fileValues(nodes: TreeNodeData[]): string[] {
	return nodes.flatMap((node) =>
		(node.nodeProps as ArchiveNodeProps | undefined)?.entry
			? [node.value]
			: fileValues(node.children ?? []),
	);
}

describe("buildArchiveTree", () => {
	test("file `a` and directory entry `a/b/` coexist regardless of order", () => {
		const fileFirst = buildArchiveTree([entry("a"), entry("a/b/")]);
		const folderFirst = buildArchiveTree([entry("a/b/"), entry("a")]);
		const expected = [
			["a", "folder", "a/", [["b", "folder", "a/b/", []]]],
			["a", "file", "a"],
		];
		expect(shape(fileFirst)).toEqual(expected);
		expect(shape(folderFirst)).toEqual(expected);
	});

	test("file `a` and file `a/b` coexist regardless of order", () => {
		const fileFirst = buildArchiveTree([entry("a"), entry("a/b")]);
		const nestedFirst = buildArchiveTree([entry("a/b"), entry("a")]);
		const expected = [
			["a", "folder", "a/", [["b", "file", "a/b"]]],
			["a", "file", "a"],
		];
		expect(shape(fileFirst)).toEqual(expected);
		expect(shape(nestedFirst)).toEqual(expected);
	});

	test("same-name conflict deeper in the tree keeps both nodes", () => {
		const names = ["x/y/z/", "x/y", "x/y/z/w"];
		const forward = buildArchiveTree(names.map((name) => entry(name)));
		const backward = buildArchiveTree([...names].reverse().map((name) => entry(name)));
		expect(shape(forward)).toEqual(shape(backward));
		expect(fileValues(forward).sort()).toEqual(["x/y", "x/y/z/w"]);
	});

	test("explicit directory entries merge with implied folders", () => {
		const tree = buildArchiveTree([
			entry("META-INF/MANIFEST.MF"),
			entry("META-INF/"),
			entry("com/example/A.class"),
		]);
		expect(shape(tree)).toEqual([
			[
				"com",
				"folder",
				"com/",
				[["example", "folder", "com/example/", [["A.class", "file", "com/example/A.class"]]]],
			],
			["META-INF", "folder", "META-INF/", [["MANIFEST.MF", "file", "META-INF/MANIFEST.MF"]]],
		]);
	});

	test("very deep names are folded so the tree depth stays bounded", () => {
		const name = Array.from({ length: 5_000 }, (_, index) => `d${index}`).join("/");
		const tree = buildArchiveTree([entry(name)]);
		let depth = 0;
		let nodes = tree;
		let last: TreeNodeData | undefined;
		while (nodes.length > 0) {
			depth++;
			last = nodes[0];
			nodes = last.children ?? [];
		}
		expect(depth).toBe(MAX_TREE_DEPTH);
		expect(last?.value).toBe(name);
		expect(fileValues(tree)).toEqual([name]);
	});

	test("caps each level and reports the hidden count", () => {
		const total = MAX_NODES_PER_LEVEL + 5;
		const tree = buildArchiveTree(
			Array.from({ length: total }, (_, index) => entry(`f${index}.txt`)),
		);
		expect(tree).toHaveLength(MAX_NODES_PER_LEVEL + 1);
		const marker = tree[tree.length - 1];
		expect(marker.value.startsWith(TRUNCATED_PREFIX)).toBe(true);
		expect((marker.nodeProps as ArchiveNodeProps).truncatedCount).toBe(5);
	});
});
