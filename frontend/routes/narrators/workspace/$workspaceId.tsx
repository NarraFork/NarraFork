import { ActionIcon, Box, Center, Group, Loader, Text, TextInput, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	IconArrowLeft,
	IconCheck,
	IconEqualDouble,
	IconLayoutGrid,
	IconLayoutSidebarRight,
	IconPencil,
} from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NarratorDragGhost } from "../../../components/narrator/NarratorDragGhost";
import type { SplitPanelCallbacks } from "../../../components/narrator/SplitPanelContainer";
import {
	DirectorPanelLayout,
	SplitPanelContainer,
	SplitPanelCtx,
} from "../../../components/narrator/SplitPanelContainer";
import {
	countLeaves,
	createLeaf,
	DEFAULT_DIRECTOR_PRIMARY_RATIO,
	DEFAULT_WORKSPACE_PRESENTATION,
	distributeSizes,
	getAllLeaves,
	getAllNarratorIds,
	moveLeaf,
	normalizeDirectorPrimaryRatio,
	normalizeWorkspacePresentation,
	parseWorkspaceLayout,
	removeLeaf,
	type SplitDirection,
	type SplitLeaf,
	type SplitNode,
	serializeWorkspaceLayout,
	setNarrator,
	setWebviewConfig,
	splitAndAssign,
	splitAndAssignTerminal,
	splitAndAssignWebview,
	swapLeaves,
	type TerminalLeafConfig,
	updateSizes,
	type WebviewLeafConfig,
	type WorkspacePresentation,
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

function collectLeafIds(node: SplitNode): string[] {
	if (node.type === "leaf") return [node.id];
	return node.children.flatMap(collectLeafIds);
}

function ensurePresentationForTree(
	tree: SplitNode,
	presentation?: Partial<WorkspacePresentation> | null,
): WorkspacePresentation {
	return normalizeWorkspacePresentation(tree, presentation ?? DEFAULT_WORKSPACE_PRESENTATION);
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
	const [presentation, setPresentation] = useState<WorkspacePresentation>(
		DEFAULT_WORKSPACE_PRESENTATION,
	);
	const [directorRatioDraft, setDirectorRatioDraft] = useState<number | null>(null);
	const [directorActivationMethod, setDirectorActivationMethod] = useState<
		"mouse" | "touch" | "keyboard" | null
	>(null);
	const presentationRef = useRef<WorkspacePresentation>(DEFAULT_WORKSPACE_PRESENTATION);
	presentationRef.current = presentation;
	const [leafSubagentStacks, setLeafSubagentStacks] = useState<Record<string, string[]>>({});
	const leafSubagentStacksRef = useRef<Record<string, string[]>>({});
	leafSubagentStacksRef.current = leafSubagentStacks;
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
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
		const parsedLayout = parseWorkspaceLayout((workspace as any).tree);

		if (isFirstLoad || (isFreshRefetch && !localEditRef.current)) {
			setTree(parsedLayout.tree);
			setPresentation(parsedLayout.presentation);
			setDirectorRatioDraft(null);
			loadedAtRef.current = serverUpdatedAt ?? null;
			localEditRef.current = false;
		} else if (isFreshRefetch && localEditRef.current && tree) {
			// Even with local edits, accept server tree if it contains narrators
			// that the local tree doesn't have (e.g. added via sidebar "+" button).
			// Trade-off: this overwrites local layout edits (panel resizes, closes)
			// when new narrators appear — acceptable since adding a narrator is a
			// higher-priority structural change than in-flight layout tweaks.
			const serverTree = parsedLayout.tree;
			const localIds = new Set(getAllNarratorIds(tree));
			const serverIds = getAllNarratorIds(serverTree);
			const hasNewNarrators = serverIds.some((id) => !localIds.has(id));
			if (hasNewNarrators) {
				setTree(serverTree);
				setPresentation(parsedLayout.presentation);
				setDirectorRatioDraft(null);
				loadedAtRef.current = serverUpdatedAt ?? null;
				localEditRef.current = false;
				// Cancel any pending debounced save to avoid overwriting the server tree
				if (saveTimerRef.current) {
					clearTimeout(saveTimerRef.current);
					saveTimerRef.current = null;
				}
			}
		}
	}, [workspace, tree]);

	useEffect(() => {
		if (!tree) return;
		const liveLeafIds = new Set(collectLeafIds(tree));
		setLeafSubagentStacks((prev) => {
			let changed = false;
			const next: Record<string, string[]> = {};
			for (const [leafId, stack] of Object.entries(prev)) {
				if (liveLeafIds.has(leafId) && stack.length > 0) {
					next[leafId] = stack;
				} else {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [tree]);

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

	// Persist workspace layout to server (debounced)
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const treeRef = useRef(tree);
	treeRef.current = tree;

	const saveWorkspaceLayout = useCallback(
		(newTree: SplitNode, nextPresentation?: WorkspacePresentation) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			const normalizedPresentation = ensurePresentationForTree(
				newTree,
				nextPresentation ?? presentationRef.current,
			);
			saveTimerRef.current = setTimeout(() => {
				updateRef.current.mutate({
					id: workspaceId,
					tree: serializeWorkspaceLayout({
						tree: newTree,
						presentation: normalizedPresentation,
					}),
				});
			}, 500);
		},
		[workspaceId],
	);

	const updateTree = useCallback(
		(fn: (prev: SplitNode) => SplitNode) => {
			setTree((prev) => {
				const next = fn(prev ?? createLeaf());
				const normalizedPresentation = ensurePresentationForTree(next, presentationRef.current);
				setPresentation(normalizedPresentation);
				localEditRef.current = true;
				saveWorkspaceLayout(next, normalizedPresentation);
				return next;
			});
		},
		[saveWorkspaceLayout],
	);

	// Leave all narrators on unmount
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			// Flush pending save — use api directly instead of mutation to avoid
			// global error notifications when the workspace has already been deleted
			// (e.g. user dissolved the workspace, which triggers unmount + delete).
			if (treeRef.current) {
				api
					.updateWorkspace(workspaceId, {
						tree: serializeWorkspaceLayout({
							tree: treeRef.current,
							presentation: ensurePresentationForTree(treeRef.current, presentationRef.current),
						}),
					})
					.catch(() => {});
			}
			const narratorIds = new Set(getAllNarratorIds(treeRef.current ?? createLeaf()));
			for (const stack of Object.values(leafSubagentStacksRef.current)) {
				for (const id of stack) narratorIds.add(id);
			}
			for (const id of narratorIds) {
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

	const handleDistribute = useCallback(() => {
		updateTree((prev) => distributeSizes(prev));
	}, [updateTree]);

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

	const handleSplitAndAssignTerminal = useCallback(
		(
			leafId: string,
			direction: SplitDirection,
			position: "before" | "after",
			config: TerminalLeafConfig,
		) => {
			updateTree((prev) => splitAndAssignTerminal(prev, leafId, direction, position, config));
		},
		[updateTree],
	);

	const handleSplitAndAssignWebview = useCallback(
		(
			leafId: string,
			direction: SplitDirection,
			position: "before" | "after",
			config: WebviewLeafConfig,
		) => {
			updateTree((prev) => splitAndAssignWebview(prev, leafId, direction, position, config));
		},
		[updateTree],
	);

	const handleUpdateWebviewConfig = useCallback(
		(leafId: string, config: WebviewLeafConfig) => {
			updateTree((prev) => setWebviewConfig(prev, leafId, config));
		},
		[updateTree],
	);

	const updatePresentationState = useCallback(
		(fn: (prev: WorkspacePresentation) => WorkspacePresentation) => {
			setPresentation((prev) => {
				const baseTree = tree ?? createLeaf();
				const next = ensurePresentationForTree(baseTree, fn(prev));
				localEditRef.current = true;
				saveWorkspaceLayout(baseTree, next);
				return next;
			});
		},
		[saveWorkspaceLayout, tree],
	);

	const handleSetPresentationMode = useCallback(
		(mode: WorkspacePresentation["mode"]) => {
			setDirectorRatioDraft(null);
			updatePresentationState((prev) => ({ ...prev, mode }));
		},
		[updatePresentationState],
	);

	const handleActivateDirectorLeaf = useCallback(
		(leafId: string, method: "mouse" | "touch" | "keyboard") => {
			setDirectorActivationMethod(method);
			updatePresentationState((prev) => ({ ...prev, primaryLeafId: leafId }));
		},
		[updatePresentationState],
	);

	const handlePreviewDirectorRatio = useCallback((ratio: number) => {
		setDirectorRatioDraft(normalizeDirectorPrimaryRatio(ratio));
	}, []);

	const handleCommitDirectorRatio = useCallback(
		(ratio: number) => {
			const nextRatio = normalizeDirectorPrimaryRatio(ratio);
			setDirectorRatioDraft(null);
			updatePresentationState((prev) => {
				if (prev.directorPrimaryRatio === nextRatio) return prev;
				return { ...prev, directorPrimaryRatio: nextRatio };
			});
		},
		[updatePresentationState],
	);

	const resolveNarratorView = useCallback(
		(leaf: SplitLeaf) => {
			const stack = leafSubagentStacks[leaf.id] ?? [];
			return {
				narratorId: stack[stack.length - 1] ?? leaf.narratorId,
				isSubagentView: stack.length > 0,
			};
		},
		[leafSubagentStacks],
	);

	const handleOpenSubagentInLeaf = useCallback((leafId: string, narratorId: string) => {
		setLeafSubagentStacks((prev) => {
			const current = prev[leafId] ?? [];
			if (current[current.length - 1] === narratorId) return prev;
			return { ...prev, [leafId]: [...current, narratorId] };
		});
	}, []);

	const handleRestoreLeafNarrator = useCallback((leafId: string) => {
		setLeafSubagentStacks((prev) => {
			const current = prev[leafId] ?? [];
			if (current.length === 0) return prev;
			if (current.length === 1) {
				const next = { ...prev };
				delete next[leafId];
				return next;
			}
			return { ...prev, [leafId]: current.slice(0, -1) };
		});
	}, []);

	// ── Mobile scale: shrink panels proportionally on narrow viewports ──
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
	const panelContainerRef = useRef<HTMLDivElement>(null);
	const [mobileScale, setMobileScale] = useState(1);
	const leafCount = tree ? countLeaves(tree) : 0;

	useEffect(() => {
		if (presentation.mode === "director" || !isMobile || leafCount <= 1) {
			setMobileScale(1);
			return;
		}
		const el = panelContainerRef.current;
		if (!el) return;
		const MIN_LEAF_WIDTH_PX = 360;
		const ro = new ResizeObserver((entries) => {
			const containerWidth = entries[0]?.contentRect.width ?? 0;
			if (containerWidth <= 0) return;
			const neededWidth = leafCount * MIN_LEAF_WIDTH_PX;
			const scale = Math.min(1, containerWidth / neededWidth);
			setMobileScale(Math.max(0.5, scale));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [isMobile, leafCount, presentation.mode]);

	const safeTree = tree ?? createLeaf();
	const canClose = countLeaves(safeTree) > 1;
	const isDirectorMode = presentation.mode === "director";
	const directorLeaves = getAllLeaves(safeTree);
	const effectiveDirectorRatio = normalizeDirectorPrimaryRatio(
		directorRatioDraft ?? presentation.directorPrimaryRatio ?? DEFAULT_DIRECTOR_PRIMARY_RATIO,
	);
	const needsScale = !isDirectorMode && isMobile && leafCount > 1 && mobileScale < 1;
	const scaleStyle: React.CSSProperties = needsScale
		? {
				width: `${100 / mobileScale}%`,
				height: `${100 / mobileScale}%`,
				transform: `scale(${mobileScale})`,
				transformOrigin: "top left",
			}
		: {};

	const ctxValue = useMemo<SplitPanelCallbacks>(
		() => ({
			onSplitAndAssign: handleSplitAndAssign,
			onReplace: handleReplace,
			onClose: handleClose,
			onSwap: handleSwap,
			onMoveToSplit: handleMoveToSplit,
			onSplitAndAssignTerminal: handleSplitAndAssignTerminal,
			onSplitAndAssignWebview: handleSplitAndAssignWebview,
			onUpdateWebviewConfig: handleUpdateWebviewConfig,
			resolveNarratorView,
			onOpenSubagentInLeaf: handleOpenSubagentInLeaf,
			onRestoreLeafNarrator: handleRestoreLeafNarrator,
			canClose,
		}),
		[
			canClose,
			handleClose,
			handleMoveToSplit,
			handleOpenSubagentInLeaf,
			handleReplace,
			handleRestoreLeafNarrator,
			handleSplitAndAssign,
			handleSplitAndAssignTerminal,
			handleSplitAndAssignWebview,
			handleSwap,
			handleUpdateWebviewConfig,
			resolveNarratorView,
		],
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
				<Box style={{ flex: 1 }} />
				<Group gap={4}>
					<Tooltip label={t("workspaceSplitMode")}>
						<ActionIcon
							size="sm"
							variant={isDirectorMode ? "subtle" : "light"}
							onClick={() => handleSetPresentationMode("split")}
						>
							<IconLayoutGrid size={16} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("workspaceDirectorMode")}>
						<ActionIcon
							size="sm"
							variant={isDirectorMode ? "light" : "subtle"}
							onClick={() => handleSetPresentationMode("director")}
						>
							<IconLayoutSidebarRight size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
				<Tooltip label={t("distributePanels")}>
					<ActionIcon
						size="sm"
						variant="subtle"
						onClick={handleDistribute}
						disabled={isDirectorMode}
					>
						<IconEqualDouble size={16} />
					</ActionIcon>
				</Tooltip>
			</Group>

			<Box
				ref={panelContainerRef}
				style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}
			>
				<Box style={{ width: "100%", height: "100%", ...scaleStyle }}>
					<SplitPanelCtx.Provider value={ctxValue}>
						{isDirectorMode ? (
							<DirectorPanelLayout
								leaves={directorLeaves}
								primaryLeafId={presentation.primaryLeafId}
								primaryRatio={effectiveDirectorRatio}
								lastActivationMethod={directorActivationMethod}
								onActivateLeaf={handleActivateDirectorLeaf}
								onPreviewRatioChange={handlePreviewDirectorRatio}
								onCommitRatioChange={handleCommitDirectorRatio}
							/>
						) : (
							<SplitPanelContainer node={tree} onUpdateSizes={handleUpdateSizes} />
						)}
					</SplitPanelCtx.Provider>
				</Box>
			</Box>
			<NarratorDragGhost />
		</Box>
	);
}
