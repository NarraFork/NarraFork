import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type DraftMode = "fork" | "merge";

export interface DraftNodeData {
	mode: DraftMode;
	/** fork: parent chapter id; merge: not used */
	parentChapterId?: string;
	/** merge: source chapter ids */
	sourceChapterIds?: string[];
	/** merge-into: target chapter id */
	targetChapterId?: string;
	/** Default title hint */
	defaultTitle?: string;
	onConfirm: (
		draftNodeId: string,
		payload: {
			title: string;
			description: string;
			inheritMode: string;
			mode: DraftMode;
			parentChapterId?: string;
			sourceChapterIds?: string[];
			targetChapterId?: string;
		},
	) => void;
	onCancel: (draftNodeId: string) => void;
	[key: string]: unknown;
}

export const DRAFT_NODE_WIDTH = 280;
const inheritOptions = ["fresh", "compressed", "full"] as const;

function DraftNodeInner({ id, data }: NodeProps) {
	const d = data as DraftNodeData;
	const mode = d.mode ?? "fork";
	const { t } = useTranslation("graph");
	const [title, setTitle] = useState(d.defaultTitle ?? "");
	const [description, setDescription] = useState("");
	const [inheritMode, setInheritMode] = useState<string>("full");
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const setInputRef = useCallback((el: HTMLInputElement | null) => {
		(inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
		if (el) el.focus();
	}, []);

	const handleConfirm = useCallback(() => {
		if (!title.trim() || loading) return;
		setLoading(true);
		d.onConfirm(id, {
			title: title.trim(),
			description: description.trim(),
			inheritMode,
			mode,
			parentChapterId: d.parentChapterId,
			sourceChapterIds: d.sourceChapterIds,
			targetChapterId: d.targetChapterId,
		});
	}, [id, d, title, description, inheritMode, mode, loading]);

	const handleCancel = useCallback(() => {
		d.onCancel(id);
	}, [id, d]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleConfirm();
			} else if (e.key === "Escape") {
				handleCancel();
			}
		},
		[handleConfirm, handleCancel],
	);

	const isFork = mode === "fork";
	const borderColor = isFork ? "var(--mantine-color-indigo-5)" : "var(--mantine-color-teal-5)";
	const accentFilled = isFork
		? "var(--mantine-color-indigo-filled)"
		: "var(--mantine-color-teal-filled)";

	const handleStyle = { opacity: 0, width: 8, height: 8 };

	return (
		<>
			<Handle type="target" position={Position.Top} id="top" style={handleStyle} />
			<Handle type="source" position={Position.Top} id="top-src" style={handleStyle} />
			<Handle type="target" position={Position.Bottom} id="bottom" style={handleStyle} />
			<Handle type="source" position={Position.Bottom} id="bottom-src" style={handleStyle} />
			<Handle type="target" position={Position.Left} id="left" style={handleStyle} />
			<Handle type="source" position={Position.Left} id="left-src" style={handleStyle} />
			<Handle type="target" position={Position.Right} id="right" style={handleStyle} />
			<Handle type="source" position={Position.Right} id="right-src" style={handleStyle} />
			{/* biome-ignore lint/a11y/noStaticElementInteractions: need keyboard + stop propagation */}
			<div
				className="nowheel"
				onKeyDown={handleKeyDown}
				style={{
					width: DRAFT_NODE_WIDTH,
				background: "var(--mantine-color-body)",
				border: `2px dashed ${borderColor}`,
					borderRadius: 8,
					padding: 12,
					display: "flex",
					flexDirection: "column",
					gap: 8,
					cursor: "grab",
				}}
			>
				{/* Mode label */}
				<span
					style={{
						fontSize: 10,
						fontWeight: 600,
						textTransform: "uppercase",
						letterSpacing: 1,
						color: borderColor,
					}}
				>
					{isFork ? t("forkDraft.confirm") : t("selection.merge")}
				</span>

				{/* Title */}
				<input
					ref={setInputRef}
					className="nodrag"
					type="text"
					placeholder={isFork ? t("forkDraft.titlePlaceholder") : t("mergeDraft.titlePlaceholder")}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					style={{
						width: "100%",
						padding: "6px 8px",
						borderRadius: 4,
					border: "1px solid var(--mantine-color-default-border)",
					background: "var(--mantine-color-default)",
						color: "var(--mantine-color-text)",
						fontSize: 13,
						outline: "none",
					}}
				/>

				{/* Description */}
				<textarea
					className="nodrag"
					placeholder={
						isFork ? t("forkDraft.descriptionPlaceholder") : t("mergeDraft.descriptionPlaceholder")
					}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					rows={2}
					style={{
						width: "100%",
						padding: "6px 8px",
						borderRadius: 4,
					border: "1px solid var(--mantine-color-default-border)",
					background: "var(--mantine-color-default)",
						color: "var(--mantine-color-text)",
						fontSize: 12,
						outline: "none",
						resize: "vertical",
						fontFamily: "inherit",
					}}
				/>

				{/* Inherit mode pills — fork only */}
				{isFork && (
					<div className="nodrag" style={{ display: "flex", gap: 4 }}>
						<span
							style={{
								fontSize: 11,
								color: "var(--mantine-color-dimmed)",
								lineHeight: "24px",
								marginRight: 4,
								whiteSpace: "nowrap",
							}}
						>
							{t("forkDraft.contextInheritance")}
						</span>
						{inheritOptions.map((opt) => (
							<button
								key={opt}
								type="button"
								onClick={() => setInheritMode(opt)}
								style={{
									padding: "2px 10px",
									borderRadius: 12,
									border:
										inheritMode === opt
											? `1px solid ${borderColor}`
											: "1px solid var(--mantine-color-default-border)",
									background: inheritMode === opt ? accentFilled : "transparent",
									color: inheritMode === opt ? "white" : "var(--mantine-color-dimmed)",
									fontSize: 11,
									cursor: "pointer",
									whiteSpace: "nowrap",
								}}
							>
								{t(`forkDraft.${opt}`)}
							</button>
						))}
					</div>
				)}

				{/* Actions */}
				<div className="nodrag" style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
					<button
						type="button"
						onClick={handleCancel}
						style={{
							padding: "4px 14px",
							borderRadius: 4,
							border: "1px solid var(--mantine-color-default-border)",
							background: "transparent",
							color: "var(--mantine-color-dimmed)",
							fontSize: 12,
							cursor: "pointer",
						}}
					>
						{t("forkDraft.cancel")}
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={!title.trim() || loading}
						style={{
							padding: "4px 14px",
							borderRadius: 4,
							border: "none",
							background: !title.trim() || loading ? "var(--mantine-color-default-border)" : accentFilled,
							color: !title.trim() || loading ? "var(--mantine-color-dimmed)" : "white",
							fontSize: 12,
							cursor: !title.trim() || loading ? "not-allowed" : "pointer",
							opacity: loading ? 0.7 : 1,
						}}
					>
						{loading ? "…" : isFork ? t("forkDraft.confirm") : t("selection.merge")}
					</button>
				</div>
			</div>
		</>
	);
}

export const DraftNode = memo(DraftNodeInner);
