/**
 * archive-tree.ts — turn a flat zip central directory into tree levels.
 *
 * Kept apart from ArchiveViewerContent so it can be tested without loading Monaco.
 *
 * Entry names are labels, not paths: they are split on "/" only to group the tree.
 * Zip gives no ordering guarantee, so the result must not depend on entry order:
 * files and folders live under distinct keys ("a" vs "a/"), which lets a file and a
 * folder of the same name coexist whichever arrives first.
 */

import type { TreeNodeData } from "@mantine/core";
import type { ArchiveEntryInfo } from "../../../lib/api/file-references";

/** Same per-level cap as the workspace file tree, for the same reason: render cost. */
export const MAX_NODES_PER_LEVEL = 1_000;
/**
 * Zip names may be up to 64 KiB, i.e. thousands of "/" segments. Segments past this
 * depth are folded into the last label so building and rendering stay shallow.
 */
export const MAX_TREE_DEPTH = 64;
export const TRUNCATED_PREFIX = "\u0000truncated:";

export interface ArchiveNodeProps {
	entry?: ArchiveEntryInfo;
	/** Synthetic folder for a path prefix that has no entry of its own. */
	folder?: boolean;
	truncatedCount?: number;
}

interface Slot {
	node: TreeNodeData;
	level?: Level;
}

interface Level {
	children: Map<string, Slot>;
}

function splitEntryName(name: string): string[] {
	const parts = name.split("/").filter((part) => part.length > 0);
	if (parts.length <= MAX_TREE_DEPTH) return parts;
	return [...parts.slice(0, MAX_TREE_DEPTH - 1), parts.slice(MAX_TREE_DEPTH - 1).join("/")];
}

/** Turn flat raw names into tree levels; folders implied by a prefix are synthesized. */
export function buildArchiveTree(entries: readonly ArchiveEntryInfo[]): TreeNodeData[] {
	const root: Level = { children: new Map() };
	for (const entry of entries) {
		const parts = splitEntryName(entry.name);
		if (parts.length === 0) continue;
		// A trailing "/" marks a directory in zip even when the flag says otherwise.
		const isFile = !entry.isDirectory && !entry.name.endsWith("/");
		let level = root;
		let prefix = "";
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			prefix = prefix ? `${prefix}/${part}` : part;
			if (isFile && index === parts.length - 1) {
				// First entry wins on a duplicate file name.
				if (!level.children.has(part))
					level.children.set(part, {
						node: {
							value: entry.name,
							label: part,
							nodeProps: { entry } satisfies ArchiveNodeProps,
						},
					});
				break;
			}
			const key = `${part}/`;
			let slot = level.children.get(key);
			if (!slot) {
				slot = {
					node: {
						value: `${prefix}/`,
						label: part,
						nodeProps: { folder: true } satisfies ArchiveNodeProps,
					},
					level: { children: new Map() },
				};
				level.children.set(key, slot);
			}
			level = slot.level as Level;
		}
	}
	const toNodes = (level: Level, parentKey: string): TreeNodeData[] => {
		const slots = [...level.children.values()].sort((a, b) => {
			const folderA = a.level ? 0 : 1;
			const folderB = b.level ? 0 : 1;
			return folderA - folderB || String(a.node.label).localeCompare(String(b.node.label));
		});
		const shown = slots
			.slice(0, MAX_NODES_PER_LEVEL)
			.map((slot) =>
				slot.level ? { ...slot.node, children: toNodes(slot.level, slot.node.value) } : slot.node,
			);
		const hidden = slots.length - shown.length;
		if (hidden > 0)
			shown.push({
				value: `${TRUNCATED_PREFIX}${parentKey}`,
				label: String(hidden),
				nodeProps: { truncatedCount: hidden } satisfies ArchiveNodeProps,
			});
		return shown;
	};
	return toNodes(root, "");
}
