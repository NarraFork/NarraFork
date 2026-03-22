import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { NarratorDragGhost } from "./NarratorDragGhost";
import type { SplitPanelCallbacks } from "./SplitPanelContainer";
import { SplitPanelContainer, SplitPanelCtx } from "./SplitPanelContainer";
import {
	countLeaves,
	createLeaf,
	getAllNarratorIds,
	removeLeaf,
	type SplitDirection,
	type SplitNode,
	setNarrator,
	splitAndAssign,
	splitLeaf,
	updateSizes,
} from "./split-tree";

const LS_SPLIT_TREE = "narrafork_narrators_split_tree";

function isValidNode(node: unknown, depth = 0): node is SplitNode {
	if (depth > 50) return false;
	if (!node || typeof node !== "object") return false;
	const n = node as Record<string, unknown>;
	if (n.type === "leaf") return typeof n.id === "string";
	if (n.type === "branch") {
		return (
			Array.isArray(n.children) &&
			Array.isArray(n.sizes) &&
			(n.children as unknown[]).every((c) => isValidNode(c, depth + 1))
		);
	}
	return false;
}

function loadTree(): SplitNode {
	try {
		const raw = localStorage.getItem(LS_SPLIT_TREE);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (isValidNode(parsed)) return parsed;
		}
	} catch {}
	localStorage.removeItem(LS_SPLIT_TREE);
	return createLeaf();
}

function saveTree(tree: SplitNode) {
	localStorage.setItem(LS_SPLIT_TREE, JSON.stringify(tree));
}

export function NarratorWorkspace() {
	const { t } = useTranslation("narrators");

	const [tree, setTree] = useState<SplitNode>(loadTree);

	// Persist tree on change
	useEffect(() => {
		saveTree(tree);
	}, [tree]);

	// Leave all narrators on unmount
	const treeRef = useRef(tree);
	treeRef.current = tree;
	useEffect(() => {
		return () => {
			for (const id of getAllNarratorIds(treeRef.current)) {
				api.leaveNarrator(id).catch(() => {});
			}
		};
	}, []);

	// ── Tree operations ──

	const handleSplit = useCallback((leafId: string, direction: SplitDirection) => {
		setTree((prev) => splitLeaf(prev, leafId, direction));
	}, []);

	const handleSplitAndAssign = useCallback(
		(
			leafId: string,
			direction: SplitDirection,
			position: "before" | "after",
			narratorId: string,
		) => {
			setTree((prev) => splitAndAssign(prev, leafId, direction, position, narratorId));
		},
		[],
	);

	const handleReplace = useCallback((leafId: string, narratorId: string) => {
		setTree((prev) => setNarrator(prev, leafId, narratorId));
	}, []);

	const handleClose = useCallback((leafId: string) => {
		setTree((prev) => {
			const result = removeLeaf(prev, leafId);
			return result ?? createLeaf();
		});
	}, []);

	const handleUpdateSizes = useCallback((branchId: string, sizes: number[]) => {
		setTree((prev) => updateSizes(prev, branchId, sizes));
	}, []);

	const canClose = countLeaves(tree) > 1;

	const ctxValue = useMemo<SplitPanelCallbacks>(
		() => ({
			onSplitAndAssign: handleSplitAndAssign,
			onReplace: handleReplace,
			onClose: handleClose,
			onSplit: handleSplit,
			canClose,
		}),
		[handleSplitAndAssign, handleReplace, handleClose, handleSplit, canClose],
	);

	return (
		<Box
			h="calc(100dvh - 60px)"
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ display: "flex", flexDirection: "column" }}
		>
			{/* Toolbar */}
			<Group
				px="sm"
				py={4}
				gap="xs"
				style={{
					flexShrink: 0,
					borderBottom: "1px solid var(--mantine-color-dark-4)",
				}}
			>
				<Tooltip label={t("listView")}>
					<ActionIcon size="sm" variant="subtle" component={Link} to="/narrators">
						<IconArrowLeft size={16} />
					</ActionIcon>
				</Tooltip>
				<Text size="sm" fw={500}>
					{t("workspaceView")}
				</Text>
			</Group>

			{/* Split panels — full area */}
			<Box style={{ flex: 1, minHeight: 0 }}>
				<SplitPanelCtx.Provider value={ctxValue}>
					<SplitPanelContainer node={tree} onUpdateSizes={handleUpdateSizes} />
				</SplitPanelCtx.Provider>
			</Box>

			<NarratorDragGhost />
		</Box>
	);
}
