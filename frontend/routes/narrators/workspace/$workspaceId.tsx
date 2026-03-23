import { ActionIcon, Box, Center, Group, Loader, Text, TextInput, Tooltip } from "@mantine/core";
import { IconArrowLeft, IconCheck, IconPencil } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NarratorDragGhost } from "../../../components/narrator/NarratorDragGhost";
import type { SplitPanelCallbacks } from "../../../components/narrator/SplitPanelContainer";
import {
	SplitPanelContainer,
	SplitPanelCtx,
} from "../../../components/narrator/SplitPanelContainer";
import {
	countLeaves,
	createLeaf,
	getAllNarratorIds,
	moveLeaf,
	removeLeaf,
	type SplitDirection,
	type SplitNode,
	setNarrator,
	splitAndAssign,
	swapLeaves,
	updateSizes,
} from "../../../components/narrator/split-tree";
import { addRecentTab, updateRecentTabLocal } from "../../../hooks/useRecentTabs";
import { useUpdateWorkspace, useWorkspace } from "../../../hooks/useWorkspace";
import { api } from "../../../lib/api";

export const Route = createFileRoute("/narrators/workspace/$workspaceId")({
	component: () => {
		const { workspaceId } = Route.useParams();
		return <WorkspacePage key={workspaceId} />;
	},
});

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

function parseTree(json: string): SplitNode {
	try {
		const parsed = JSON.parse(json);
		if (isValidNode(parsed)) return parsed;
	} catch {}
	return createLeaf();
}

function WorkspacePage() {
	const { workspaceId } = Route.useParams();
	const navigate = useNavigate();
	const { t } = useTranslation("narrators");
	const { data: workspace, isLoading } = useWorkspace(workspaceId);
	const updateWorkspace = useUpdateWorkspace();
	const updateRef = useRef(updateWorkspace);
	updateRef.current = updateWorkspace;

	// ── Editable title ──
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	const serverTitle = (workspace as any)?.title as string | undefined;
	const [editing, setEditing] = useState(false);
	const [editTitle, setEditTitle] = useState("");

	const startEditing = useCallback(() => {
		setEditTitle(serverTitle || "");
		setEditing(true);
	}, [serverTitle]);

	const commitTitle = useCallback(() => {
		setEditing(false);
		const trimmed = editTitle.trim();
		if (trimmed && trimmed !== serverTitle) {
			updateRef.current.mutate({ id: workspaceId, title: trimmed });
			updateRecentTabLocal("workspace", workspaceId, { title: trimmed });
		}
	}, [editTitle, serverTitle, workspaceId]);

	const [tree, setTree] = useState<SplitNode | null>(null);
	/** Track whether local edits have been made — skip overwriting with stale server data. */
	const localEditRef = useRef(false);
	/** Track the server updatedAt we last loaded from, to detect fresh refetches. */
	const loadedAtRef = useRef<number | null>(null);

	// Initialize tree from server data, and update when a fresh refetch arrives
	// (but not if the user has made local edits since the last load).
	useEffect(() => {
		if (!workspace) return;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
		const serverUpdatedAt = (workspace as any).updatedAt as number | undefined;
		const isFirstLoad = tree === null;
		const isFreshRefetch = serverUpdatedAt != null && serverUpdatedAt !== loadedAtRef.current;

		if (isFirstLoad || (isFreshRefetch && !localEditRef.current)) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
			setTree(parseTree((workspace as any).tree));
			loadedAtRef.current = serverUpdatedAt ?? null;
			localEditRef.current = false;
		}
	}, [workspace, tree]);

	// Record recent tab
	useEffect(() => {
		if (!workspace) return;
		addRecentTab({
			type: "workspace",
			id: workspaceId,
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
			title: (workspace as any).title || "Workspace",
		});
	}, [workspaceId, workspace]);

	// Sync child narrator tabs' workspaceId whenever tree changes
	const prevNarratorIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!tree) return;
		const currentIds = new Set(getAllNarratorIds(tree));
		const prevIds = prevNarratorIdsRef.current;

		// Newly added narrators — set workspaceId
		for (const nId of currentIds) {
			if (!prevIds.has(nId)) {
				addRecentTab({
					type: "narrator",
					id: nId,
					title: "",
					workspaceId,
					updateOnly: true,
				});
			}
		}
		// Removed narrators — clear workspaceId
		for (const nId of prevIds) {
			if (!currentIds.has(nId)) {
				addRecentTab({
					type: "narrator",
					id: nId,
					title: "",
					workspaceId: null,
					updateOnly: true,
				});
			}
		}
		prevNarratorIdsRef.current = currentIds;
	}, [tree, workspaceId]);

	// Persist tree to server (debounced)
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const treeRef = useRef(tree);
	treeRef.current = tree;

	const saveTree = useCallback(
		(newTree: SplitNode) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				updateRef.current.mutate({ id: workspaceId, tree: JSON.stringify(newTree) });
			}, 500);
		},
		[workspaceId],
	);

	const updateTree = useCallback(
		(fn: (prev: SplitNode) => SplitNode) => {
			setTree((prev) => {
				const next = fn(prev ?? createLeaf());
				localEditRef.current = true;
				saveTree(next);
				return next;
			});
		},
		[saveTree],
	);

	// Leave all narrators on unmount
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			// Flush pending save
			if (treeRef.current) {
				updateRef.current.mutate({
					id: workspaceId,
					tree: JSON.stringify(treeRef.current),
				});
			}
			for (const id of getAllNarratorIds(treeRef.current ?? createLeaf())) {
				api.leaveNarrator(id).catch(() => {});
			}
		};
	}, [workspaceId]);

	// ── Tree operations ──

	const handleSplitAndAssign = useCallback(
		(
			leafId: string,
			direction: SplitDirection,
			position: "before" | "after",
			narratorId: string,
		) => {
			updateTree((prev) => splitAndAssign(prev, leafId, direction, position, narratorId));
		},
		[updateTree],
	);

	const handleReplace = useCallback(
		(leafId: string, narratorId: string) => {
			updateTree((prev) => setNarrator(prev, leafId, narratorId));
		},
		[updateTree],
	);

	const handleClose = useCallback(
		(leafId: string) => {
			updateTree((prev) => {
				const result = removeLeaf(prev, leafId);
				if (!result || countLeaves(result) === 0) {
					// Last panel closed — navigate back to narrators list
					navigate({ to: "/narrators" });
					return prev;
				}
				return result;
			});
		},
		[updateTree, navigate],
	);

	const handleUpdateSizes = useCallback(
		(branchId: string, sizes: number[]) => {
			updateTree((prev) => updateSizes(prev, branchId, sizes));
		},
		[updateTree],
	);

	const handleSwap = useCallback(
		(leafIdA: string, leafIdB: string) => {
			updateTree((prev) => swapLeaves(prev, leafIdA, leafIdB));
		},
		[updateTree],
	);

	const handleMoveToSplit = useCallback(
		(
			sourceLeafId: string,
			targetLeafId: string,
			direction: SplitDirection,
			position: "before" | "after",
		) => {
			updateTree((prev) => moveLeaf(prev, sourceLeafId, targetLeafId, direction, position));
		},
		[updateTree],
	);

	if (isLoading || !tree) {
		return (
			<Box
				h="calc(100dvh - 60px)"
				mx="calc(var(--mantine-spacing-md) * -1)"
				my="calc(var(--mantine-spacing-md) * -1)"
			>
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			</Box>
		);
	}

	const canClose = countLeaves(tree) > 1;

	const ctxValue: SplitPanelCallbacks = {
		onSplitAndAssign: handleSplitAndAssign,
		onReplace: handleReplace,
		onClose: handleClose,
		onSwap: handleSwap,
		onMoveToSplit: handleMoveToSplit,
		canClose,
	};

	return (
		<Box
			h="calc(100dvh - 60px)"
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
		>
			{/* Toolbar with editable title */}
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
				{editing ? (
					<TextInput
						size="xs"
						value={editTitle}
						onChange={(e) => setEditTitle(e.currentTarget.value)}
						onBlur={commitTitle}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitTitle();
							if (e.key === "Escape") setEditing(false);
						}}
						autoFocus
						styles={{ input: { minWidth: 120 } }}
						rightSection={
							<ActionIcon size="xs" variant="subtle" onClick={commitTitle}>
								<IconCheck size={14} />
							</ActionIcon>
						}
					/>
				) : (
					<Group gap={4} style={{ cursor: "pointer" }} onClick={startEditing}>
						<Text size="sm" fw={500}>
							{serverTitle || "Workspace"}
						</Text>
						<IconPencil size={14} color="var(--mantine-color-dimmed)" />
					</Group>
				)}
			</Group>

			<Box style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
				<SplitPanelCtx.Provider value={ctxValue}>
					<SplitPanelContainer node={tree} onUpdateSizes={handleUpdateSizes} />
				</SplitPanelCtx.Provider>
			</Box>
			<NarratorDragGhost />
		</Box>
	);
}
