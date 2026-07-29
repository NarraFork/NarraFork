/**
 * StructuredNodeTree.tsx — "node mode" rendering for the file viewer.
 *
 * Draws a `StructuredNode[]` (json / toml / ini) as a collapsible key/value tree
 * on Mantine's `Tree` + `useTree`. Leaves show `key: value` with the value tinted
 * by type; branches show the key plus a direct-child count so a collapsed
 * subtree still says how much it hides.
 *
 * Owns its own expand-all / collapse-all controls so the panel does not have to
 * thread a tree controller back up; split out of FileViewerContent to keep the
 * pure node → TreeNodeData mapping small and independently testable.
 */

import type { TreeNodeData } from "@mantine/core";
import { ActionIcon, Badge, Box, Group, Text, Tooltip, Tree, useTree } from "@mantine/core";
import { IconFoldDown, IconFoldUp } from "@tabler/icons-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { StructuredNode, StructuredValueType } from "./structured-parse";

/** Mantine text colour per scalar type (dimmed for absent values). */
const VALUE_COLOR: Record<StructuredValueType, string> = {
	string: "teal.4",
	number: "orange.4",
	boolean: "violet.4",
	null: "dimmed",
};

interface NodePayload {
	valueLabel?: string;
	valueType?: StructuredValueType;
	childCount?: number;
}

/**
 * Map parsed nodes to Mantine tree data. `value` must be unique across the whole
 * tree, so it is the path from the root (keys are already unique per level).
 */
export function toTreeData(nodes: readonly StructuredNode[], prefix = ""): TreeNodeData[] {
	return nodes.map((node) => {
		const value = prefix ? `${prefix}.${node.key}` : node.key;
		if (node.kind === "leaf") {
			const payload: NodePayload = { valueLabel: node.value, valueType: node.valueType };
			return { value, label: node.key, nodeProps: { payload } };
		}
		const payload: NodePayload = { childCount: node.childCount };
		return {
			value,
			label: node.key,
			children: toTreeData(node.children, value),
			nodeProps: { payload },
		};
	});
}

export interface StructuredNodeTreeProps {
	nodes: readonly StructuredNode[];
	/** Changing this re-applies the initial expansion (e.g. after a reload). */
	resetKey?: string;
}

export function StructuredNodeTree({ nodes, resetKey }: StructuredNodeTreeProps) {
	const { t } = useTranslation("narrator");
	const data = useMemo(() => toTreeData(nodes), [nodes]);
	const tree = useTree();

	// A fresh document (or an explicit reload) starts fully expanded, so the whole
	// shape is visible without clicking through every level.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey/data are the intentional re-init triggers
	useEffect(() => {
		tree.expandAllNodes();
	}, [resetKey, data]);

	return (
		<Box style={{ fontSize: 12 }}>
			<Group gap={4} px="xs" py={2} justify="flex-end">
				<Tooltip label={t("fileViewer.expandAll")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("fileViewer.expandAll")}
						onClick={() => tree.expandAllNodes()}
					>
						<IconFoldDown size={14} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("fileViewer.collapseAll")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("fileViewer.collapseAll")}
						onClick={() => tree.collapseAllNodes()}
					>
						<IconFoldUp size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>
			<Box px="xs" pb="xs">
				<Tree
					data={data}
					tree={tree}
					levelOffset={16}
					withLines
					renderNode={({ node, expanded, hasChildren, elementProps }) => {
						const payload = (node.nodeProps?.payload ?? {}) as NodePayload;
						return (
							<Group gap={6} wrap="nowrap" py={1} {...elementProps}>
								<Text size="xs" c="dimmed" style={{ width: 10, flexShrink: 0 }}>
									{hasChildren ? (expanded ? "▾" : "▸") : ""}
								</Text>
								<Text size="xs" ff="monospace" fw={hasChildren ? 600 : 500}>
									{String(node.label)}
								</Text>
								{hasChildren ? (
									<Badge size="xs" variant="light" color="gray">
										{payload.childCount ?? 0}
									</Badge>
								) : (
									<Text
										size="xs"
										ff="monospace"
										c={VALUE_COLOR[payload.valueType ?? "string"]}
										style={{ wordBreak: "break-all", whiteSpace: "pre-wrap", minWidth: 0 }}
									>
										{payload.valueLabel ?? ""}
									</Text>
								)}
							</Group>
						);
					}}
				/>
			</Box>
		</Box>
	);
}
