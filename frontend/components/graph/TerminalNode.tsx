import {
	ActionIcon,
	Button,
	Card,
	Group,
	Modal,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconMinus, IconTerminal2, IconX } from "@tabler/icons-react";
import { Handle, type NodeProps, NodeResizeControl, Position } from "@xyflow/react";
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTerminalCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";

const TerminalPanel = lazy(() =>
	import("../terminal/TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

export interface TerminalNodeData {
	terminalId: string;
	terminalName: string;
	chapterId: string;
	onMinimize?: (nodeId: string) => void;
	onClose?: (nodeId: string, terminalId: string) => void;
	onRename?: (terminalId: string, name: string) => void;
	/** When set to a truthy value, the node enters inline-edit mode automatically. */
	requestEdit?: number;
	[key: string]: unknown;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const MAX_TERMINAL_NODE_NAME_CHARS = 500;

function clampTerminalNodeName(value: string): string {
	return value.length > MAX_TERMINAL_NODE_NAME_CHARS
		? `${value.slice(0, MAX_TERMINAL_NODE_NAME_CHARS)}…`
		: value;
}

function TerminalNodeInner({ data, id }: NodeProps) {
	const d = data as TerminalNodeData;
	const { t } = useTranslation("graph");
	const terminalCapability = useTerminalCapability();
	const processTreeSupported = terminalCapability.processTree?.supported !== false;
	const panelWheelRef = useRef<HTMLDivElement>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [closing, setClosing] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState(d.terminalName);
	const inputRef = useRef<HTMLInputElement>(null);
	const displayName = clampTerminalNodeName(d.terminalName);

	const handleMinimize = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			d.onMinimize?.(id);
		},
		[d.onMinimize, id],
	);

	const handleCloseClick = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			if (processTreeSupported) {
				try {
					const processes = await api.getTerminalProcesses(d.terminalId);
					if (processes.length > 1) {
						setConfirmOpen(true);
						return;
					}
				} catch {
					// Can't check — just close directly
				}
			}
			d.onClose?.(id, d.terminalId);
		},
		[d.onClose, d.terminalId, id, processTreeSupported],
	);

	const handleConfirmClose = useCallback(() => {
		setClosing(true);
		d.onClose?.(id, d.terminalId);
	}, [d.onClose, d.terminalId, id]);

	const startEditing = useCallback(() => {
		setEditValue(d.terminalName);
		setEditing(true);
		requestAnimationFrame(() => inputRef.current?.select());
	}, [d.terminalName]);

	const commitRename = useCallback(() => {
		setEditing(false);
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== d.terminalName) {
			d.onRename?.(d.terminalId, trimmed);
		}
	}, [editValue, d.terminalName, d.onRename, d.terminalId]);

	const cancelEditing = useCallback(() => {
		setEditing(false);
		setEditValue(d.terminalName);
	}, [d.terminalName]);

	// Trigger inline edit when requestEdit changes (from context menu rename)
	const lastRequestEdit = useRef(d.requestEdit);
	useEffect(() => {
		if (d.requestEdit && d.requestEdit !== lastRequestEdit.current) {
			startEditing();
		}
		lastRequestEdit.current = d.requestEdit;
	}, [d.requestEdit, startEditing]);

	// Allow Ctrl+wheel to pass through to ReactFlow for zoom
	// (handled by NowheelPassthrough in NarraFlow — no per-node listener needed)

	const handleStyle = { opacity: 0, width: 8, height: 8 };

	return (
		<>
			<NodeResizeControl
				minWidth={MIN_WIDTH}
				minHeight={MIN_HEIGHT}
				position="bottom-right"
				style={{ background: "transparent", border: "none" }}
			>
				<div
					style={{
						width: 14,
						height: 14,
						borderRadius: "50%",
						background: "var(--mantine-color-teal-5)",
						opacity: 0.7,
						cursor: "nwse-resize",
						position: "relative",
						top: -4,
						left: -4,
					}}
				/>
			</NodeResizeControl>
			<Handle type="target" position={Position.Top} id="top" style={handleStyle} />
			<Handle type="source" position={Position.Top} id="top-src" style={handleStyle} />
			<Handle type="target" position={Position.Bottom} id="bottom" style={handleStyle} />
			<Handle type="source" position={Position.Bottom} id="bottom-src" style={handleStyle} />
			<Handle type="target" position={Position.Left} id="left" style={handleStyle} />
			<Handle type="source" position={Position.Left} id="left-src" style={handleStyle} />
			<Handle type="target" position={Position.Right} id="right" style={handleStyle} />
			<Handle type="source" position={Position.Right} id="right-src" style={handleStyle} />
			<Card
				shadow="sm"
				padding={0}
				radius="md"
				withBorder
				style={{
					width: "100%",
					height: "100%",
					borderColor: "var(--mantine-color-teal-5)",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				{/* Header — drag handle */}
				<div
					className="terminal-node-drag-handle"
					style={{
						padding: "4px 8px",
						cursor: "grab",
						flexShrink: 0,
						borderBottom: "1px solid var(--mantine-color-dark-4)",
					}}
				>
					<Group justify="space-between" wrap="nowrap">
						<Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
							<IconTerminal2
								size={14}
								color="var(--mantine-color-teal-5)"
								style={{ flexShrink: 0 }}
							/>
							{editing ? (
								<TextInput
									ref={inputRef}
									size="xs"
									value={editValue}
									onChange={(e) => setEditValue(e.currentTarget.value)}
									onBlur={commitRename}
									onKeyDown={(e) => {
										if (e.key === "Enter") commitRename();
										if (e.key === "Escape") cancelEditing();
									}}
									className="nodrag"
									styles={{
										input: { height: 22, minHeight: 22, fontSize: 12, padding: "0 6px" },
									}}
									style={{ flex: 1, minWidth: 0 }}
								/>
							) : (
								<Text
									size="xs"
									fw={500}
									lineClamp={1}
									className="nodrag"
									style={{ minWidth: 0, cursor: "default" }}
									onDoubleClick={startEditing}
								>
									{displayName}
								</Text>
							)}
						</Group>
						<Group gap={2} wrap="nowrap">
							<Tooltip label={t("terminal.minimize")}>
								<ActionIcon
									variant="subtle"
									size="xs"
									color="gray"
									className="nodrag"
									onClick={handleMinimize}
								>
									<IconMinus size={12} />
								</ActionIcon>
							</Tooltip>
							<Tooltip label={t("terminal.close")}>
								<ActionIcon
									variant="subtle"
									size="xs"
									color="red"
									className="nodrag"
									onClick={handleCloseClick}
								>
									<IconX size={12} />
								</ActionIcon>
							</Tooltip>
						</Group>
					</Group>
				</div>

				{/* Terminal content */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only */}
				<div
					className="nopan nodrag nowheel"
					ref={panelWheelRef}
					onContextMenu={(e) => e.stopPropagation()}
					style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
				>
					<Suspense fallback={null}>
						<TerminalPanel terminalId={d.terminalId} />
					</Suspense>
				</div>
			</Card>

			{/* Confirm close modal — rendered outside Card to avoid clipping */}
			{confirmOpen && (
				<ConfirmCloseModal
					open={confirmOpen}
					closing={closing}
					onClose={() => setConfirmOpen(false)}
					onConfirm={handleConfirmClose}
				/>
			)}
		</>
	);
}

/** Separate component so the modal portal escapes the node transform. */
function ConfirmCloseModal({
	open,
	closing,
	onClose,
	onConfirm,
}: {
	open: boolean;
	closing: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const { t } = useTranslation("graph");
	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("terminal.closeConfirmTitle")}
			centered
			zIndex={2000}
		>
			<Stack>
				<Text size="sm">{t("terminal.closeConfirmMessage")}</Text>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("terminal.cancel")}
					</Button>
					<Button color="red" onClick={onConfirm} loading={closing}>
						{t("terminal.confirmClose")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function areTerminalNodePropsEqual(prev: NodeProps, next: NodeProps) {
	const prevData = prev.data as TerminalNodeData;
	const nextData = next.data as TerminalNodeData;
	return (
		prev.id === next.id &&
		prevData.terminalId === nextData.terminalId &&
		prevData.terminalName === nextData.terminalName &&
		prevData.requestEdit === nextData.requestEdit &&
		prevData.onMinimize === nextData.onMinimize &&
		prevData.onClose === nextData.onClose &&
		prevData.onRename === nextData.onRename
	);
}

export const TerminalNode = memo(TerminalNodeInner, areTerminalNodePropsEqual);
