import { Box, CopyButton, Text, Tooltip } from "@mantine/core";
import {
	IconCopy,
	IconEyeCheck,
	IconGitBranch,
	IconGitMerge,
	IconGitPullRequest,
	IconMessageForward,
	IconPrompt,
	IconX,
} from "@tabler/icons-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** Adjust menu position so it stays within the viewport. */
function useMenuPosition(x: number, y: number) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ left: x, top: y });

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = x;
		let top = y;
		if (left + rect.width > vw - 8) left = vw - rect.width - 8;
		if (top + rect.height > vh - 8) top = vh - rect.height - 8;
		if (left < 8) left = 8;
		if (top < 8) top = 8;
		setPos({ left, top });
	}, [x, y]);

	return { ref, pos };
}

interface TickContextMenuProps {
	x: number;
	y: number;
	commitSha: string;
	commitMessage: string;
	commitAuthor: string;
	commitDate: string;
	onClose: () => void;
	onFork: (commitSha: string) => void;
}

export function TickContextMenu({
	x,
	y,
	commitSha,
	commitMessage,
	commitAuthor,
	commitDate,
	onClose,
	onFork,
}: TickContextMenuProps) {
	const { t } = useTranslation("graph");
	const { ref, pos } = useMenuPosition(x, y);
	const hasMultiLine = commitMessage.includes("\n") || commitMessage.length > 60;
	return (
		<Box
			ref={ref}
			style={{
				position: "fixed",
				left: pos.left,
				top: pos.top,
				zIndex: 1000,
				background: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))",
				border: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
				borderRadius: 8,
				padding: 4,
				minWidth: 220,
				maxWidth: 360,
				boxShadow: "0 4px 12px light-dark(rgba(0,0,0,0.1), rgba(0,0,0,0.3))",
				userSelect: "none",
			}}
			onClick={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
		>
			{/* Commit info header */}
			<Box px={8} py={4}>
				<Box style={{ display: "flex", alignItems: "center", gap: 4 }}>
					<Text size="xs" ff="monospace" c="indigo" fw={600}>
						{commitSha.slice(0, 8)}
					</Text>
					<CopyButton value={commitSha}>
						{({ copied, copy }) => (
							<Tooltip label={copied ? t("ruler.copied") : t("ruler.copySha")} withArrow>
								<Box style={{ cursor: "pointer", display: "flex", opacity: 0.6 }} onClick={copy}>
									<IconCopy size={12} />
								</Box>
							</Tooltip>
						)}
					</CopyButton>
				</Box>
				{commitAuthor && (
					<Text size="10px" c="dimmed" mt={2}>
						{commitAuthor}
						{commitDate ? ` · ${formatRelativeDate(commitDate, t)}` : ""}
					</Text>
				)}
				<Box
					mt={4}
					style={{
						maxHeight: hasMultiLine ? 120 : undefined,
						overflowY: hasMultiLine ? "auto" : undefined,
					}}
				>
					<Text size="xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
						{commitMessage}
					</Text>
				</Box>
			</Box>

			<Box
				style={{
					height: 1,
					background: "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
					margin: "2px 0",
				}}
			/>

			<MenuItem
				icon={<IconGitBranch size={14} />}
				label={t("ruler.forkFromHere")}
				onClick={() => {
					onFork(commitSha);
					onClose();
				}}
			/>
		</Box>
	);
}

interface ChapterContextMenuProps {
	x: number;
	y: number;
	chapterId: string;
	chapterTitle: string;
	chapterStatus: string;
	chapterRole: string;
	reviewStatus?: string | null;
	onClose: () => void;
	onFork: (chapterId: string) => void;
	onMerge: (chapterId: string) => void;
	onRebase: (chapterId: string) => void;
	onReview: (chapterId: string) => void;
	onAbandon: (chapterId: string) => void;
	onConvertToSubagent: (chapterId: string) => void;
	onPromoteReview: (chapterId: string) => void;
	onDismissReview: (chapterId: string) => void;
}

export function ChapterContextMenu({
	x,
	y,
	chapterId,
	chapterTitle,
	chapterStatus,
	chapterRole,
	reviewStatus,
	onClose,
	onFork,
	onMerge,
	onRebase,
	onReview,
	onAbandon,
	onConvertToSubagent,
	onPromoteReview,
	onDismissReview,
}: ChapterContextMenuProps) {
	const { t } = useTranslation("graph");
	const { ref, pos } = useMenuPosition(x, y);
	const isActive = chapterStatus === "active";
	const isReview = chapterRole === "review";

	return (
		<Box
			ref={ref}
			style={{
				position: "fixed",
				left: pos.left,
				top: pos.top,
				zIndex: 1000,
				background: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))",
				border: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
				borderRadius: 8,
				padding: 4,
				minWidth: 180,
				boxShadow: "0 4px 12px light-dark(rgba(0,0,0,0.1), rgba(0,0,0,0.3))",
				userSelect: "none",
			}}
			onClick={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
		>
			<Box px={8} py={4}>
				<Text size="xs" fw={500} truncate style={{ maxWidth: 200 }}>
					{chapterTitle}
				</Text>
			</Box>

			<Box
				style={{
					height: 1,
					background: "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
					margin: "2px 0",
				}}
			/>

			{isActive && !isReview && (
				<>
					<MenuItem
						icon={<IconGitBranch size={14} />}
						label={t("contextMenu.fork")}
						onClick={() => {
							onFork(chapterId);
							onClose();
						}}
					/>
					<MenuItem
						icon={<IconGitMerge size={14} />}
						label={t("ruler.mergeToTrunk")}
						onClick={() => {
							onMerge(chapterId);
							onClose();
						}}
					/>
					<MenuItem
						icon={<IconGitPullRequest size={14} />}
						label={t("ruler.rebaseOntoTrunk")}
						onClick={() => {
							onRebase(chapterId);
							onClose();
						}}
					/>
					<MenuItem
						icon={<IconEyeCheck size={14} />}
						label={t("contextMenu.review")}
						onClick={() => {
							onReview(chapterId);
							onClose();
						}}
					/>
				</>
			)}

			{isActive && isReview && (
				<>
					<MenuItem
						icon={<IconMessageForward size={14} />}
						label={t("contextMenu.reviewActions.sendToSource")}
						disabled={reviewStatus !== "concluded"}
						onClick={() => {
							onConvertToSubagent(chapterId);
							onClose();
						}}
					/>
					<MenuItem
						icon={<IconPrompt size={14} />}
						label={t("contextMenu.reviewActions.promoteToChapter")}
						disabled={reviewStatus !== "concluded" && reviewStatus !== "reviewing"}
						onClick={() => {
							onPromoteReview(chapterId);
							onClose();
						}}
					/>
					<MenuItem
						icon={<IconX size={14} />}
						label={t("contextMenu.reviewActions.dismiss")}
						color="red"
						onClick={() => {
							onDismissReview(chapterId);
							onClose();
						}}
					/>
				</>
			)}

			{isActive && !isReview && (
				<MenuItem
					icon={<Text size="xs">✕</Text>}
					label={t("ruler.abandon")}
					color="red"
					onClick={() => {
						onAbandon(chapterId);
						onClose();
					}}
				/>
			)}
		</Box>
	);
}

function formatRelativeDate(
	dateStr: string,
	t: (key: string, opts?: Record<string, unknown>) => string,
): string {
	try {
		const d = new Date(dateStr);
		const now = Date.now();
		const diffMs = now - d.getTime();
		const diffMin = Math.floor(diffMs / 60_000);
		if (diffMin < 1) return t("ruler.justNow");
		if (diffMin < 60) return t("ruler.minutesAgo", { count: diffMin });
		const diffH = Math.floor(diffMin / 60);
		if (diffH < 24) return t("ruler.hoursAgo", { count: diffH });
		const diffD = Math.floor(diffH / 24);
		if (diffD < 30) return t("ruler.daysAgo", { count: diffD });
		return d.toLocaleDateString();
	} catch {
		return dateStr;
	}
}

function MenuItem({
	icon,
	label,
	color,
	disabled,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	color?: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Box
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 8px",
				borderRadius: 4,
				cursor: disabled ? "default" : "pointer",
				color: color ? `var(--mantine-color-${color}-5)` : undefined,
				opacity: disabled ? 0.4 : 1,
				pointerEvents: disabled ? "none" : undefined,
			}}
			className={disabled ? undefined : "ruler-menu-item"}
			onClick={disabled ? undefined : onClick}
		>
			{icon}
			<Text size="xs">{label}</Text>
		</Box>
	);
}
