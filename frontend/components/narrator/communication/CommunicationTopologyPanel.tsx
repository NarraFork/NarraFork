import { RecentTabIcon } from "@frontend/components/nav/RecentTabIcon";
import { useCommunicationTopology } from "@frontend/hooks/useCommunicationTopology";
import { useNarratorMentionCandidates } from "@frontend/hooks/useNarratorMentionCandidates";
import { api } from "@frontend/lib/api";
import { formatLocaleDate } from "@frontend/lib/intl-format";
import {
	isNarratorSubject,
	onPanelDragEnd,
	onPanelDragMove,
	PANEL_DROP_PRIORITY,
	registerPanelDropTarget,
} from "@frontend/lib/panel-drag";
import { ActionIcon, Badge, Button, Loader, TextInput } from "@mantine/core";
import { useElementSize, useFocusTrap } from "@mantine/hooks";
import type { CommunicationScope, CommunicationTopology } from "@shared/narrator-communication";
import {
	IconArrowBackUp,
	IconArrowUpRight,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconGripVertical,
	IconLink,
	IconList,
	IconMinus,
	IconPlus,
	IconRefresh,
	IconSchema,
	IconUnlink,
	IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorPanelVisible } from "../narrator-panel-visibility";
import styles from "./Topology.module.css";
import {
	type DropIntent,
	disconnectAction,
	layoutTopology,
	nodeDropIntent,
	peerPath,
	subtreeSize,
	type TopologyAction,
} from "./topology-model";
import { type TopologyDrag, useTopologyGestures } from "./use-topology-gestures";

type ConnectionStatus = "connecting" | "live" | "disconnected" | "denied" | "unavailable";
type Selection = { kind: "node" | "peer"; id: string } | null;
interface UndoEntry {
	sourceId: string;
	kind: "connect" | "disconnect" | "split" | "restore";
	targetId?: string;
	/** Last visible eligibility for the inverse; disconnected neighbors leave the projection. */
	canReconnect?: boolean;
}

export interface CommunicationTopologyPanelProps {
	scope: CommunicationScope;
	onOpenNarrator?: (id: string) => void;
}

export function CommunicationTopologyPanel({
	scope,
	onOpenNarrator,
}: CommunicationTopologyPanelProps) {
	const visible = useNarratorPanelVisible();
	const { topology, status, retry } = useCommunicationTopology(scope, visible);
	return (
		<CommunicationTopologyView
			topology={topology}
			status={status}
			onRetry={retry}
			onOpenNarrator={onOpenNarrator}
		/>
	);
}

/** Projection-only surface. The connected host above owns the existing WS subscription. */
export function CommunicationTopologyView({
	topology,
	status,
	onRetry,
	onOpenNarrator,
}: {
	topology: CommunicationTopology | null;
	status: ConnectionStatus;
	onRetry: () => void;
	onOpenNarrator?: (id: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const { ref: panelRef, width } = useElementSize();
	const { ref: viewportRef, height: viewportHeight } = useElementSize();
	const panelId = useId();
	const [view, setView] = useState<"graph" | "list">("graph");
	const [selection, setSelectionState] = useState<Selection>(null);
	const [detailsDismissed, setDetailsDismissed] = useState(false);
	const setSelection = useCallback((next: Selection) => {
		setSelectionState(next);
		setDetailsDismissed(false);
	}, []);
	const [collapsed, setCollapsed] = useState(new Set<string>());
	const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
	const [hover, setHover] = useState<{ targetId?: string; intent: DropIntent } | null>(null);
	const [externalDrag, setExternalDrag] = useState(false);
	const [dragPoint, setDragPoint] = useState({ x: 16, y: 16 });
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
	const [undo, setUndo] = useState<UndoEntry | null>(null);
	const [connectSource, setConnectSource] = useState<string | null>(null);
	const [confirmation, setConfirmation] = useState<TopologyAction | null>(null);
	const mutationScope = useRef(0);
	const busyRef = useRef(false);
	const live = status === "live";
	const selectedNode = topology?.nodes.find(
		(node) => selection?.kind === "node" && node.id === selection.id,
	);
	const selectedPeer = topology?.peers.find(
		(peer) => selection?.kind === "peer" && peer.id === selection.id,
	);
	const detailsVisible = (!!selectedNode || !!selectedPeer) && !detailsDismissed;
	const sideDetails = width >= 1024 && detailsVisible;
	const detailsFocusRef = useFocusTrap(
		detailsVisible && !sideDetails && !confirmation && !connectSource,
	);
	const confirmationFocusRef = useFocusTrap(!!confirmation);
	const graphWidth = Math.max(240, width - (sideDetails ? 288 : 0));
	const layout = useMemo(
		() => (topology ? layoutTopology(topology, graphWidth, collapsed, expandedGroups) : null),
		[topology, graphWidth, collapsed, expandedGroups],
	);
	const topologyRef = useRef(topology);
	topologyRef.current = topology;
	const scopeKey = JSON.stringify(topology?.scope ?? null);
	const previousScope = useRef(scopeKey);
	useEffect(() => {
		if (previousScope.current === scopeKey) return;
		previousScope.current = scopeKey;
		mutationScope.current++;
		setSelection(null);
		setConnectSource(null);
		setConfirmation(null);
		setNotice(null);
		setUndo(null);
	}, [scopeKey, setSelection]);
	useEffect(() => {
		if (status === "denied" || status === "unavailable") {
			mutationScope.current++;
			setSelection(null);
			setConnectSource(null);
			setConfirmation(null);
			setUndo(null);
			setNotice(null);
		}
	}, [status, setSelection]);

	const commit = useCallback(
		async (action: TopologyAction, isUndo = false) => {
			if (!live || busyRef.current) return;
			busyRef.current = true;
			setPending(true);
			setNotice(null);
			const currentScope = mutationScope.current;
			const priorPeer = topologyRef.current?.peers.find(
				(peer) => action.mutation.kind === "disconnect" && peer.id === action.mutation.peerId,
			);
			const canReconnect =
				!!priorPeer &&
				[priorPeer.endpointLo, priorPeer.endpointHi].every((id) => {
					const endpoint = topologyRef.current?.nodes.find((entry) => entry.id === id);
					return endpoint?.canConnect && endpoint.status !== "archived";
				});
			try {
				const result = await api.mutateCommunication(action.sourceId, action.mutation, {
					signal: AbortSignal.timeout(10_000),
				});
				if (currentScope !== mutationScope.current) return;
				setNotice({
					error: false,
					message: t(result.changed ? "communicationSaved" : "communicationUnchanged"),
				});
				if (result.changed && !isUndo) {
					const peer = priorPeer;
					setUndo({
						sourceId: action.sourceId,
						kind: action.mutation.kind,
						canReconnect,
						targetId:
							action.mutation.kind === "connect"
								? action.mutation.targetNarratorId
								: peer
									? peer.endpointLo === action.sourceId
										? peer.endpointHi
										: peer.endpointLo
									: undefined,
					});
				} else setUndo(null);
			} catch (error) {
				if (currentScope === mutationScope.current)
					setNotice({
						error: true,
						message: t("communicationFailed", {
							reason: error instanceof Error ? error.message : String(error),
						}),
					});
			} finally {
				busyRef.current = false;
				setPending(false);
			}
		},
		[live, t],
	);

	function undoAction(): TopologyAction | null {
		if (!undo || !topology) return null;
		const node = topology.nodes.find((n) => n.id === undo.sourceId);
		if (undo.kind === "connect") {
			const peer = topology.peers.find(
				(p) =>
					(p.endpointLo === undo.sourceId && p.endpointHi === undo.targetId) ||
					(p.endpointHi === undo.sourceId && p.endpointLo === undo.targetId),
			);
			return peer ? disconnectAction(peer, topology.nodes) : null;
		}
		if (undo.kind === "disconnect" && undo.canReconnect && undo.targetId) {
			const target = topology.nodes.find((candidate) => candidate.id === undo.targetId);
			if (
				(node && (!node.canConnect || node.status === "archived")) ||
				(target && (!target.canConnect || target.status === "archived"))
			)
				return null;
			return {
				sourceId: undo.sourceId,
				mutation: { kind: "connect", targetNarratorId: undo.targetId },
			};
		}
		if (!node?.canManage) return null;
		if (undo.kind === "split" && node.restoreParentId && !node.parentNarratorId)
			return { sourceId: node.id, mutation: { kind: "restore", version: node.version } };
		if (undo.kind === "restore" && node.parentNarratorId)
			return { sourceId: node.id, mutation: { kind: "split", version: node.version } };
		return null;
	}

	function hit(drag: TopologyDrag, x: number, y: number) {
		const element = document.elementFromPoint(x, y);
		const inPanel = element?.closest(`[data-topology-panel="${CSS.escape(panelId)}"]`);
		if (!inPanel || !topology || pending) return null;
		const zone = element?.closest<HTMLElement>("[data-topology-drop]")?.dataset.topologyDrop;
		if (drag.kind === "peer") {
			const peer = topology.peers.find((p) => p.id === drag.id);
			if (zone !== "disconnect") return null;
			const action = peer ? disconnectAction(peer, topology.nodes) : null;
			return {
				intent: (!live
					? { kind: "rejected", reason: "offline" }
					: action
						? { kind: "allowed", action, label: "disconnect" }
						: { kind: "rejected", reason: "readonly" }) as DropIntent,
			};
		}
		const targetId =
			zone === "split"
				? "split"
				: element?.closest<HTMLElement>("[data-topology-node]")?.dataset.topologyNode;
		return targetId
			? { targetId, intent: nodeDropIntent(topology, drag.id, targetId, live) }
			: null;
	}
	const gestures = useTopologyGestures({
		active: !!topology && view === "graph",
		width: graphWidth,
		height: viewportHeight || 500,
		sceneWidth: layout?.width ?? graphWidth,
		sceneHeight: layout?.height ?? 500,
		onHover: (drag, x, y) => {
			setHover(hit(drag, x, y));
			const canvas = document
				.querySelector(
					`[data-topology-panel="${CSS.escape(panelId)}"] [data-testid="topology-canvas"]`,
				)
				?.getBoundingClientRect();
			if (canvas)
				setDragPoint({
					x: Math.max(10, Math.min(canvas.width - 210, x - canvas.left + 14)),
					y: Math.max(10, Math.min(canvas.height - 170, y - canvas.top + 14)),
				});
		},
		onDrop: (drag, x, y) => {
			const result = hit(drag, x, y);
			if (result?.intent.kind === "allowed") void commit(result.intent.action);
		},
		onCancel: () => setHover(null),
	});
	const activeDrag = gestures.drag;
	const cancelGesture = gestures.cancel;
	useEffect(() => {
		if (
			activeDrag &&
			!(activeDrag.kind === "node" ? topology?.nodes : topology?.peers)?.some(
				(entry) => entry.id === activeDrag.id,
			)
		)
			cancelGesture();
	}, [activeDrag, topology, cancelGesture]);
	useEffect(() => {
		const cleanup = registerPanelDropTarget({
			id: `communication-${panelId}`,
			priority: PANEL_DROP_PRIORITY.topology,
			hitTest: (state) => {
				if (!isNarratorSubject(state) || !topology || view !== "graph") return null;
				const element = document.elementFromPoint(state.x, state.y);
				if (!element?.closest(`[data-topology-panel="${CSS.escape(panelId)}"]`)) return null;
				const targetId = element.closest<HTMLElement>("[data-topology-node]")?.dataset.topologyNode;
				if (!targetId) return null;
				// A visible node consumes even a rejected drop: it must never fall through to split a workspace.
				return { targetId };
			},
			onDrop: (state, target) => {
				const node = topology?.nodes.find((n) => n.id === target.targetId);
				const known = topology?.nodes.some((n) => n.id === state.id);
				const intent =
					known && topology ? nodeDropIntent(topology, state.id, target.targetId, live) : null;
				if (intent?.kind === "rejected")
					setNotice({ error: true, message: t(`communicationReject_${intent.reason}`) });
				else if (live && node?.canConnect)
					void commit(
						intent?.kind === "allowed"
							? intent.action
							: {
									sourceId: state.id,
									mutation: { kind: "connect", targetNarratorId: target.targetId },
								},
					);
			},
		});
		const move = onPanelDragMove((state) => {
			if (!isNarratorSubject(state)) return;
			const element = document.elementFromPoint(state.x, state.y);
			const inside = !!element?.closest(`[data-topology-panel="${CSS.escape(panelId)}"]`);
			setExternalDrag(inside);
			const targetId = inside
				? element?.closest<HTMLElement>("[data-topology-node]")?.dataset.topologyNode
				: undefined;
			if (targetId && topology)
				setHover({
					targetId,
					intent: topology.nodes.some((n) => n.id === state.id)
						? nodeDropIntent(topology, state.id, targetId, live)
						: live && topology.nodes.find((n) => n.id === targetId)?.canConnect
							? {
									kind: "allowed",
									action: {
										sourceId: state.id,
										mutation: { kind: "connect", targetNarratorId: targetId },
									},
									label: "connect",
								}
							: { kind: "rejected", reason: live ? "readonly" : "offline" },
				});
			else setHover(null);
		});
		const end = onPanelDragEnd(() => {
			setExternalDrag(false);
			setHover(null);
		});
		return () => {
			cleanup();
			move();
			end();
		};
	}, [panelId, topology, live, view, t, commit]);

	const name = (id: string) => topology?.nodes.find((node) => node.id === id)?.title || id;
	const toggle = (id: string) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const details =
		detailsVisible && topology ? (
			<aside
				ref={detailsFocusRef}
				className={`${styles.details} ${sideDetails ? styles.sideDetails : styles.drawer}`}
				data-testid="topology-details"
				aria-label={t("communicationDetails")}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						setDetailsDismissed(true);
					}
				}}
			>
				<div className={styles.detailsHeader}>
					<strong>{t("communicationDetails")}</strong>
					<ActionIcon
						size={44}
						variant="subtle"
						aria-label={t("communicationClose")}
						onClick={() => setDetailsDismissed(true)}
					>
						<IconX size={18} />
					</ActionIcon>
				</div>
				{selectedNode ? (
					<>
						<h3 className={styles.detailTitle}>
							{selectedNode.title || t("communicationUntitled")}
						</h3>
						<code className={styles.identity}>{selectedNode.id}</code>
						{selectedNode.team && (
							<>
								<Badge variant="light">{selectedNode.team.name}</Badge>
								{selectedNode.team.workItem && <p>{selectedNode.team.workItem.title}</p>}
							</>
						)}
						<dl>
							<dt>{t("communicationGroup")}</dt>
							<dd>
								{layout?.groups.find((group) => group.id === selectedNode.groupId)?.title ||
									name(selectedNode.groupId)}
							</dd>
							<dt>{t("communicationReach")}</dt>
							<dd>
								{t("communicationReachCount", {
									count: topology.nodes.filter((n) => n.groupId === selectedNode.groupId).length,
								})}
							</dd>
							<dt>{t("communicationSource")}</dt>
							<dd>
								{selectedNode.parentNarratorId
									? name(selectedNode.parentNarratorId)
									: selectedNode.restoreParentId
										? name(selectedNode.restoreParentId)
										: t("communicationIndependent")}
							</dd>
						</dl>
						{selectedNode.delegated && (
							<p className={styles.explanation}>{t("communicationDelegationKept")}</p>
						)}
						<div className={styles.actionStack}>
							<Button
								variant="light"
								leftSection={<IconLink size={16} />}
								disabled={!live || pending || !selectedNode.canConnect}
								onClick={() => setConnectSource(selectedNode.id)}
							>
								{t("communicationConnect")}
							</Button>
							{selectedNode.parentNarratorId && (
								<Button
									variant="default"
									disabled={!live || pending || !selectedNode.canManage}
									onClick={() =>
										setConfirmation({
											sourceId: selectedNode.id,
											mutation: { kind: "split", version: selectedNode.version },
										})
									}
								>
									{t("communicationSplit")}
								</Button>
							)}
							{!selectedNode.parentNarratorId && selectedNode.restoreParentId && (
								<Button
									variant="default"
									disabled={!live || pending || !selectedNode.canManage}
									onClick={() =>
										setConfirmation({
											sourceId: selectedNode.id,
											mutation: { kind: "restore", version: selectedNode.version },
										})
									}
								>
									{t("communicationRestore")}
								</Button>
							)}
							<Button
								variant="subtle"
								rightSection={<IconArrowUpRight size={16} />}
								onClick={() => onOpenNarrator?.(selectedNode.id)}
								disabled={!onOpenNarrator}
							>
								{t("communicationOpen")}
							</Button>
						</div>
					</>
				) : selectedPeer ? (
					<>
						<h3 className={styles.detailTitle}>{name(selectedPeer.endpointLo)}</h3>
						<IconLink size={20} />
						<h3 className={styles.detailTitle}>{name(selectedPeer.endpointHi)}</h3>
						<p>{t("communicationExactPeer")}</p>
						<small>
							{t("communicationCreated", {
								date: formatLocaleDate(selectedPeer.createdAt),
							})}
						</small>
						<Button
							mt="md"
							variant="light"
							color="red"
							leftSection={<IconUnlink size={16} />}
							disabled={!live || pending || !selectedPeer.canDisconnect}
							onClick={() => setConfirmation(disconnectAction(selectedPeer, topology.nodes))}
						>
							{t("communicationDisconnect")}
						</Button>
					</>
				) : null}
				<p className={styles.explanation}>{t("communicationNoGrant")}</p>
			</aside>
		) : null;

	return (
		<section
			ref={panelRef}
			className={styles.panel}
			data-topology-panel={panelId}
			data-testid="communication-topology"
			aria-label={t("communicationTitle")}
		>
			<header className={styles.toolbar}>
				<div className={styles.heading}>
					<IconSchema size={20} />
					<strong>{t("communicationTitle")}</strong>
					<span
						className={styles.sync}
						role="img"
						data-live={live}
						title={t(`communicationSync_${status}`)}
						aria-label={t(`communicationSync_${status}`)}
					/>
				</div>
				<div className={styles.tools}>
					<button
						type="button"
						className={styles.toolButton}
						aria-label={t("communicationGraph")}
						aria-pressed={view === "graph"}
						onClick={() => setView("graph")}
					>
						<IconSchema size={18} />
					</button>
					<button
						type="button"
						className={styles.toolButton}
						aria-label={t("communicationList")}
						aria-pressed={view === "list"}
						onClick={() => setView("list")}
					>
						<IconList size={18} />
					</button>
					<button
						type="button"
						className={styles.toolButton}
						aria-label={t("communicationRetry")}
						onClick={onRetry}
					>
						<IconRefresh size={18} />
					</button>
				</div>
			</header>
			{!live && (
				<div className={styles.connectionBanner} role="status">
					{status === "connecting" && <Loader size={14} />}
					{t(`communicationSync_${status}`)}
				</div>
			)}
			{notice && (
				<div
					className={styles.notice}
					data-error={notice.error}
					role={notice.error ? "alert" : "status"}
				>
					<span>
						{notice.error ? null : <IconCheck size={14} />}
						{notice.message}
					</span>
					{undo && (
						<Button
							size="compact-sm"
							variant="subtle"
							disabled={!live || pending || !undoAction()}
							leftSection={<IconArrowBackUp size={14} />}
							onClick={() => {
								const action = undoAction();
								if (action) void commit(action, true);
							}}
						>
							{t("communicationUndo")}
						</Button>
					)}
					<ActionIcon
						size={32}
						variant="subtle"
						aria-label={t("communicationClose")}
						onClick={() => setNotice(null)}
					>
						<IconX size={15} />
					</ActionIcon>
				</div>
			)}
			<div className={styles.body}>
				{topology && layout ? (
					view === "graph" ? (
						<div className={styles.viewportWrap} ref={viewportRef}>
							<div
								ref={gestures.canvasRef}
								{...gestures.canvasHandlers}
								className={styles.canvas}
								data-testid="topology-canvas"
								data-gesture={gestures.drag ? "drag" : "idle"}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										gestures.cancel();
										setSelection(null);
									}
								}}
								role="application"
								aria-label={t("communicationCanvasHelp")}
							>
								<div
									className={styles.scene}
									data-testid="topology-scene"
									style={{
										width: layout.width,
										height: layout.height,
										transform: `translate(${gestures.transform.tx}px, ${gestures.transform.ty}px) scale(${gestures.transform.scale})`,
									}}
								>
									{layout.groups.map((group) => (
										<div
											key={group.id}
											className={styles.domain}
											data-topology-group={group.id}
											data-current={group.current}
											style={{
												left: group.x,
												top: group.y,
												width: group.width,
												height: group.height,
											}}
										>
											<div className={styles.domainTitle}>
												<span>{group.title || t("communicationUntitled")}</span>
												<Badge variant="light" size="xs">
													{group.count}
												</Badge>
											</div>
											<div className={styles.domainHint} title={t("communicationMutual")}>
												{t("communicationMutual")}
											</div>
											{group.hidden > 0 && (
												<button
													type="button"
													className={styles.expandGroup}
													onClick={() => setExpandedGroups((old) => new Set([...old, group.id]))}
												>
													{t("communicationExpandGroup", { count: group.hidden })}
												</button>
											)}
										</div>
									))}
									<svg
										className={styles.edges}
										width={layout.width}
										height={layout.height}
										aria-label={t("communicationPeerLines")}
									>
										<title>{t("communicationPeerLines")}</title>
										{topology.peers.map((peer, index) => {
											const a = layout.nodes.find((n) => n.node.id === peer.endpointLo);
											const b = layout.nodes.find((n) => n.node.id === peer.endpointHi);
											if (!a || !b) return null;
											const path = peerPath(a, b, layout, index);
											return (
												<g
													key={peer.id}
													data-selected={selectedPeer?.id === peer.id}
													className={styles.edge}
												>
													<path d={path} className={styles.edgeVisible} />
													{/* biome-ignore lint/a11y/useSemanticElements: SVG hit path; keyboard and relation-list buttons provide the same operation. */}
													<path
														d={path}
														className={styles.edgeHit}
														role="button"
														tabIndex={0}
														aria-label={t("communicationPeerLabel", {
															a: name(peer.endpointLo),
															b: name(peer.endpointHi),
														})}
														onClick={() => setSelection({ kind: "peer", id: peer.id })}
														onKeyDown={(event) => {
															if (event.key === "Enter" || event.key === " ") {
																event.preventDefault();
																setSelection({ kind: "peer", id: peer.id });
															}
														}}
													/>
												</g>
											);
										})}
									</svg>
									{layout.nodes.map((placed) => (
										<div
											key={placed.node.id}
											data-topology-node={placed.node.id}
											data-draggable={live && (placed.node.canManage || placed.node.canConnect)}
											className={styles.node}
											data-selected={selectedNode?.id === placed.node.id}
											data-dragging={
												gestures.drag?.kind === "node" && gestures.drag.id === placed.node.id
											}
											data-target={
												hover?.targetId === placed.node.id ? hover.intent.kind : undefined
											}
											style={{
												left: placed.x,
												top: placed.y,
												width: placed.width,
												height: placed.height,
											}}
										>
											<button
												type="button"
												className={styles.handle}
												data-topology-handle={
													live && !pending && (placed.node.canManage || placed.node.canConnect)
														? "node"
														: undefined
												}
												data-drag-id={placed.node.id}
												disabled={
													!live || pending || (!placed.node.canManage && !placed.node.canConnect)
												}
												aria-label={t("communicationDrag", { name: placed.node.title })}
												onClick={(event) => {
													event.stopPropagation();
													setSelection({ kind: "node", id: placed.node.id });
												}}
											>
												<IconGripVertical size={18} />
											</button>
											<button
												type="button"
												data-topology-select
												className={styles.nodeText}
												aria-label={placed.node.title || t("communicationUntitled")}
												onClick={() => setSelection({ kind: "node", id: placed.node.id })}
											>
												<span className={styles.statusIcon} aria-hidden="true">
													<RecentTabIcon
														size={16}
														tab={{
															id: placed.node.id,
															type:
																placed.node.team?.id === placed.node.id
																	? "team"
																	: placed.node.delegated
																		? "subagent"
																		: "narrator",
															status: placed.node.status,
															substatus: placed.node.substatus,
														}}
													/>
												</span>
												<span className={styles.nodeName} title={placed.node.title || undefined}>
													{placed.node.title || t("communicationUntitled")}
												</span>
											</button>
											{placed.descendants > 0 ? (
												<button
													type="button"
													className={styles.cardAction}
													aria-label={t(
														collapsed.has(placed.node.id)
															? "communicationExpandBranch"
															: "communicationCollapseBranch",
													)}
													onClick={(event) => {
														event.stopPropagation();
														toggle(placed.node.id);
													}}
												>
													{collapsed.has(placed.node.id) ? (
														<IconChevronRight size={15} />
													) : (
														<IconChevronDown size={15} />
													)}
													<small>{placed.descendants}</small>
												</button>
											) : (
												<button
													type="button"
													className={styles.cardAction}
													aria-label={t("communicationOpen")}
													disabled={!onOpenNarrator}
													onClick={(event) => {
														event.stopPropagation();
														onOpenNarrator?.(placed.node.id);
													}}
												>
													<IconArrowUpRight size={16} />
												</button>
											)}
											{gestures.drag?.kind === "node" &&
												topology.nodes.find((n) => n.id === gestures.drag?.id)?.restoreParentId ===
													placed.node.id && (
													<div className={styles.restoreBadge}>{t("communicationRestoreHere")}</div>
												)}
										</div>
									))}
								</div>
								{gestures.drag?.kind === "node" &&
									topology.nodes.some((node) => node.id === gestures.drag?.id) && (
										<div
											className={styles.dragGhost}
											data-testid="topology-drag-preview"
											style={{ left: dragPoint.x, top: dragPoint.y }}
											aria-hidden="true"
										>
											<strong>{name(gestures.drag.id)}</strong>
											<small>
												{t("communicationMovingSubtree", {
													count: subtreeSize(topology, gestures.drag.id),
												})}
											</small>
										</div>
									)}
								{selectedPeer?.canDisconnect && live && (
									<button
										type="button"
										className={styles.peerHandle}
										data-topology-handle="peer"
										data-drag-id={selectedPeer.id}
										aria-label={t("communicationDragDisconnect")}
									>
										<IconGripVertical size={18} />
										<IconUnlink size={18} />
										<span>{t("communicationDragDisconnect")}</span>
									</button>
								)}
								{(gestures.drag || externalDrag) && (
									<div className={styles.dropTray}>
										{gestures.drag?.kind === "peer" ? (
											<div data-topology-drop="disconnect" className={styles.dropZone}>
												<IconUnlink size={18} />
												{t("communicationDisconnect")}
											</div>
										) : (
											gestures.drag && (
												<div data-topology-drop="split" className={styles.dropZone}>
													<IconSchema size={18} />
													{t("communicationSplit")}
												</div>
											)
										)}
										<div className={styles.dropPreview} role="status">
											{hover
												? hover.intent.kind === "allowed"
													? t(`communicationDrop_${hover.intent.label}`, {
															count: hover.intent.count ?? 1,
															a: selectedPeer ? name(selectedPeer.endpointLo) : "",
															b: selectedPeer ? name(selectedPeer.endpointHi) : "",
														})
													: t(`communicationReject_${hover.intent.reason}`)
												: t("communicationDropHint")}
										</div>
										{hover?.intent.kind === "allowed" && hover.intent.label === "split" && (
											<small>{t("communicationSplitPreserves")}</small>
										)}
									</div>
								)}
							</div>
							<div className={styles.zoomTools}>
								<button
									type="button"
									className={styles.toolButton}
									aria-label={t("communicationZoomOut")}
									onClick={() => gestures.zoom(1 / 1.15)}
								>
									<IconMinus size={16} />
								</button>
								<button
									type="button"
									className={styles.scaleButton}
									aria-label={t("communicationResetView")}
									onClick={gestures.reset}
								>
									{Math.round(gestures.transform.scale * 100)}%
								</button>
								<button
									type="button"
									className={styles.toolButton}
									aria-label={t("communicationZoomIn")}
									onClick={() => gestures.zoom(1.15)}
								>
									<IconPlus size={16} />
								</button>
							</div>
						</div>
					) : (
						<div className={styles.relationList} data-testid="topology-list">
							<h3>{t("communicationDomains")}</h3>
							{layout.groups.map((group) => (
								<section className={styles.listGroup} key={group.id}>
									<strong>{group.title || t("communicationUntitled")}</strong>
									<p>{t("communicationMutual")}</p>
									{topology.nodes
										.filter((n) => n.groupId === group.id)
										.map((node) => (
											<button
												type="button"
												key={node.id}
												className={styles.listRow}
												onClick={() => setSelection({ kind: "node", id: node.id })}
											>
												<span className={styles.statusIcon} aria-hidden="true">
													<RecentTabIcon
														size={16}
														tab={{
															id: node.id,
															type:
																node.team?.id === node.id
																	? "team"
																	: node.delegated
																		? "subagent"
																		: "narrator",
															status: node.status,
															substatus: node.substatus,
														}}
													/>
												</span>
												<span className={styles.nodeName}>
													{node.title || t("communicationUntitled")}
												</span>
												<IconChevronRight size={16} />
											</button>
										))}
								</section>
							))}
							<h3>{t("communicationPeerLines")}</h3>
							{topology.peers.map((peer) => (
								<button
									type="button"
									key={peer.id}
									className={styles.listRow}
									onClick={() => setSelection({ kind: "peer", id: peer.id })}
								>
									<span>
										{name(peer.endpointLo)} ↔ {name(peer.endpointHi)}
									</span>
									<IconChevronRight size={16} />
								</button>
							))}
						</div>
					)
				) : (
					<div className={styles.empty}>
						{status === "connecting" ? <Loader size="sm" /> : <IconSchema size={36} />}
						<p>{t(status === "denied" ? "communicationSync_denied" : "communicationEmpty")}</p>
						<Button variant="light" onClick={onRetry}>
							{t("communicationRetry")}
						</Button>
					</div>
				)}
				{details}
				{pending && (
					<div className={styles.pending} role="status">
						<Loader size={16} />
						{t("communicationPending")}
					</div>
				)}
			</div>
			<footer className={styles.footer}>
				{topology?.truncated ? t("communicationTruncated") : t("communicationNoGrantShort")}
			</footer>
			{confirmation && (
				<div className={styles.modalBackdrop}>
					<div
						ref={confirmationFocusRef}
						className={styles.confirmDialog}
						role="dialog"
						aria-modal="true"
						aria-label={t(`communicationAction_${confirmation.mutation.kind}`)}
					>
						<h3>{t(`communicationAction_${confirmation.mutation.kind}`)}</h3>
						<p>
							{confirmation.mutation.kind === "split"
								? t("communicationSplitPreserves")
								: confirmation.mutation.kind === "disconnect"
									? t("communicationDisconnectHint")
									: t("communicationRestoreHint")}
						</p>
						<div className={styles.confirmActions}>
							<Button variant="default" onClick={() => setConfirmation(null)}>
								{t("communicationCancel")}
							</Button>
							<Button
								disabled={!live || pending}
								onClick={() => {
									const action = confirmation;
									setConfirmation(null);
									void commit(action);
								}}
							>
								{t("communicationConfirm")}
							</Button>
						</div>
					</div>
				</div>
			)}
			{connectSource && (
				<ConnectDialog
					sourceId={connectSource}
					live={live && !pending}
					onClose={() => setConnectSource(null)}
					onConnect={(targetId) => {
						setConnectSource(null);
						void commit({
							sourceId: connectSource,
							mutation: { kind: "connect", targetNarratorId: targetId },
						});
					}}
				/>
			)}
		</section>
	);
}

function ConnectDialog({
	sourceId,
	live,
	onClose,
	onConnect,
}: {
	sourceId: string;
	live: boolean;
	onClose: () => void;
	onConnect: (id: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const dialogFocusRef = useFocusTrap(true);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [composing, setComposing] = useState(false);
	const [alreadyRelated, setAlreadyRelated] = useState<"sameGroup" | "connected">();
	const { candidates, loading, error, hasMore, verification, verifyCandidate, cancelVerification } =
		useNarratorMentionCandidates(sourceId, query, live, live, "manual-connect");
	const checking = verification?.status === "checking";
	const connectionRejection = (candidate: (typeof candidates)[number]) =>
		candidate.sameGroup
			? "sameGroup"
			: candidate.connected
				? "connected"
				: candidate.canConnect === false
					? "readonly"
					: undefined;
	const valid = candidates.find((node) => node.id === selected && !connectionRejection(node));
	const confirm = () => {
		if (!valid || !live || composing || checking) return;
		setAlreadyRelated(undefined);
		verifyCandidate(valid.id, (eligible) => {
			if (eligible.sameGroup || eligible.connected) {
				setAlreadyRelated(eligible.sameGroup ? "sameGroup" : "connected");
			} else onConnect(eligible.id);
		});
	};
	const close = () => {
		cancelVerification();
		onClose();
	};
	const recent = candidates.filter((node) => node.isRecent);
	const more = candidates.filter((node) => !node.isRecent);
	return (
		<div className={styles.modalBackdrop}>
			<div
				ref={dialogFocusRef}
				className={styles.connectDialog}
				role="dialog"
				aria-modal="true"
				aria-label={t("communicationConnect")}
				onKeyDown={(event) => {
					if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
						return;
					if (event.key === "Escape") {
						event.stopPropagation();
						close();
					}
					if (
						event.key === "Enter" &&
						(!(event.target instanceof HTMLButtonElement) ||
							event.target.getAttribute("role") === "option")
					) {
						event.preventDefault();
						confirm();
					}
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						if (checking) return;
						const index = candidates.findIndex((node) => node.id === selected);
						const next =
							(index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) %
							candidates.length;
						setAlreadyRelated(undefined);
						setSelected(candidates[next]?.id ?? null);
					}
				}}
			>
				<div className={styles.detailsHeader}>
					<h3>{t("communicationConnect")}</h3>
					<ActionIcon
						size={44}
						variant="subtle"
						aria-label={t("communicationClose")}
						onClick={close}
					>
						<IconX size={18} />
					</ActionIcon>
				</div>
				<TextInput
					autoFocus
					maxLength={128}
					placeholder={t("communicationSearch")}
					aria-label={t("communicationSearch")}
					value={query}
					onChange={(event) => {
						cancelVerification();
						setSelected(null);
						setAlreadyRelated(undefined);
						setQuery(event.currentTarget.value);
					}}
					onCompositionStart={() => {
						cancelVerification();
						setComposing(true);
					}}
					onCompositionEnd={() => setComposing(false)}
				/>
				<div
					className={styles.candidates}
					role="listbox"
					aria-label={t("communicationCandidates")}
					aria-busy={loading || checking}
				>
					{(
						[
							["mentionRecentSessions", recent],
							["mentionMoreSessions", more],
						] as const
					).map(
						([key, items]) =>
							items.length > 0 && (
								<section key={String(key)}>
									<small>{t(String(key))}</small>
									{items.map((candidate) => {
										const rejection = connectionRejection(candidate);
										return (
											<button
												type="button"
												key={candidate.id}
												role="option"
												aria-selected={selected === candidate.id}
												disabled={checking || !!rejection}
												className={styles.candidate}
												onClick={() => {
													setAlreadyRelated(undefined);
													setSelected(candidate.id);
												}}
											>
												<span>{candidate.title || t("communicationUntitled")}</span>
												{rejection ? (
													<small>{t(`communicationReject_${rejection}`)}</small>
												) : candidate.canConnect === undefined ? (
													<small>{t("mentionVerifyRequired")}</small>
												) : null}
											</button>
										);
									})}
								</section>
							),
					)}
					{alreadyRelated && <p role="alert">{t(`communicationReject_${alreadyRelated}`)}</p>}
					{checking && <p role="status">{t("mentionVerifyChecking")}</p>}
					{verification?.status === "denied" && <p role="alert">{t("mentionVerifyDenied")}</p>}
					{verification?.status === "error" && <p role="alert">{t("mentionVerifyError")}</p>}
					{!verification && loading && <p role="status">{t("mentionSearching")}</p>}
					{!verification && error && <p role="alert">{t("mentionSearchError")}</p>}
					{!loading && !candidates.length && <p>{t("mentionNoResults")}</p>}
					{hasMore && <small>{t("communicationMoreSearch")}</small>}
				</div>
				<p className={styles.explanation}>{t("communicationExactPeer")}</p>
				<div className={styles.confirmActions}>
					<Button variant="default" onClick={close}>
						{t("communicationCancel")}
					</Button>
					<Button disabled={!valid || !live || composing || checking} onClick={confirm}>
						{t("communicationConnect")}
					</Button>
				</div>
			</div>
		</div>
	);
}
