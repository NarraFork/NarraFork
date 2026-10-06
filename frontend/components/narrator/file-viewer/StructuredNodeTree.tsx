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
import {
	ActionIcon,
	Badge,
	Box,
	Group,
	getTreeExpandedState,
	Text,
	Tooltip,
	Tree,
	useTree,
} from "@mantine/core";
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
	/** 0-based source line; stamped as `data-line` so the editor's split view can scroll-sync. */
	line?: number;
}

/**
 * RFC 6901 escaping for path segments. `value` must be unique across the whole
 * tree, so it is the path from the root (keys are already unique per level) —
 * but a plain "a.b" join collides when a KEY itself contains "." (e.g. the
 * JSON `{"a.b": 1}` vs `{"a": {"b": 1}}`), which makes two distinct nodes
 * share one expansion state. Escaping `~` and `/` and joining with "/" keeps
 * every path unique regardless of key content.
 */
function escapePathSegment(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Map parsed nodes to Mantine tree data.
 */
export function toTreeData(nodes: readonly StructuredNode[], prefix = ""): TreeNodeData[] {
	return nodes.map((node) => {
		const value = `${prefix}/${escapePathSegment(node.key)}`;
		if (node.kind === "leaf") {
			const payload: NodePayload = {
				valueLabel: node.value,
				valueType: node.valueType,
				line: node.line,
			};
			return { value, label: node.key, nodeProps: { payload } };
		}
		const payload: NodePayload = { childCount: node.childCount, line: node.line };
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

	// Compute expansion state from `data` directly instead of calling
	// `tree.expandAllNodes()` / `tree.collapseAllNodes()`. Those helpers only flip
	// keys ALREADY PRESENT in the controller's expanded state — and the state is
	// populated by Tree's own initialize effect, which (a) hasn't run yet when our
	// mount effect fires (expandedState is still `{}`), so expand-all is a no-op
	// that also clobbers initialize's update, and (b) lags one render behind any
	// `data` change, so freshly added nodes are unreachable. Symptoms: a freshly
	// opened file rendered fully collapsed, and the expand-all button appeared
	// dead. Setting the full state computed from `data` sidesteps both races (our
	// effect runs after Tree's initialize in the same commit, so it wins).
	const expandAll = () => tree.setExpandedState(getTreeExpandedState(data, "*"));
	const collapseAll = () => tree.setExpandedState(getTreeExpandedState(data, []));

	// A fresh document (or an explicit reload) starts fully expanded, so the whole
	// shape is visible without clicking through every level.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey/data are the intentional re-init triggers; `tree` identity changes on every state update and must not re-trigger
	useEffect(() => {
		tree.setExpandedState(getTreeExpandedState(data, "*"));
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
						onClick={expandAll}
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
						onClick={collapseAll}
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
							<Group
								gap={6}
								wrap="nowrap"
								py={1}
								data-line={payload.line ?? undefined}
								{...elementProps}
							>
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
