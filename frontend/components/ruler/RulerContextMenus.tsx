import { Box, Text } from "@mantine/core";
import { IconEyeCheck, IconGitBranch, IconGitMerge } from "@tabler/icons-react";
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
	hasSegment: boolean;
	onClose: () => void;
	onFork: (commitSha: string) => void;
}

export function TickContextMenu({
	x,
	y,
	commitSha,
	commitMessage,
	onClose,
	onFork,
}: TickContextMenuProps) {
	const { t } = useTranslation("graph");
	const { ref, pos } = useMenuPosition(x, y);
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
			}}
			onClick={(e) => e.stopPropagation()}
		>
			{/* Commit info header */}
			<Box px={8} py={4}>
				<Text size="xs" c="dimmed" truncate style={{ maxWidth: 200 }}>
					{commitSha.slice(0, 8)} — {commitMessage}
				</Text>
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
	onClose: () => void;
	onFork: (chapterId: string) => void;
	onMerge: (chapterId: string) => void;
	onReview: (chapterId: string) => void;
	onAbandon: (chapterId: string) => void;
}

export function ChapterContextMenu({
	x,
	y,
	chapterId,
	chapterTitle,
	chapterStatus,
	chapterRole,
	onClose,
	onFork,
	onMerge,
	onReview,
	onAbandon,
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
			}}
			onClick={(e) => e.stopPropagation()}
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
						icon={<IconEyeCheck size={14} />}
						label={t("contextMenu.review")}
						onClick={() => {
							onReview(chapterId);
							onClose();
						}}
					/>
				</>
			)}

			{isActive && (
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

function MenuItem({
	icon,
	label,
	color,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	color?: string;
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
				cursor: "pointer",
				color: color ? `var(--mantine-color-${color}-5)` : undefined,
			}}
			className="ruler-menu-item"
			onClick={onClick}
		>
			{icon}
			<Text size="xs">{label}</Text>
		</Box>
	);
}
