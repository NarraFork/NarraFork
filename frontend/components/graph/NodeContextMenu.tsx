import { Divider, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFsRevealCapability } from "../../hooks/usePlatform";
import { Z } from "../../lib/z-index";

const MAX_NODE_CONTEXT_TITLE_CHARS = 500;

function clampNodeContextTitle(value: string): string {
	return value.length > MAX_NODE_CONTEXT_TITLE_CHARS
		? `${value.slice(0, MAX_NODE_CONTEXT_TITLE_CHARS)}…`
		: value;
}

interface ReviewActionAvailability {
	request: boolean;
	convertToSubagent: boolean;
	promote: boolean;
	dismiss: boolean;
}

interface NodeContextMenuProps {
	x: number;
	y: number;
	nodeId: string;
	nodeData: {
		title: string;
		status: string;
		role: string;
		isRoot?: boolean;
		worktreePath?: string | null;
		reviewStatus?: string | null;
	};
	reviewActions?: ReviewActionAvailability;
	onClose: () => void;
	onFork: (nodeId: string) => void;
	onReview: (nodeId: string) => void;
	onSetRole: (nodeId: string, role: string) => void;
	onDormant: (nodeId: string) => void;
	onWake: (nodeId: string) => void;
	onUnmerge: (nodeId: string) => void;
	onDelete: (nodeId: string) => void;
	onReveal: (nodeId: string) => void;
	onConvertToSubagent: (nodeId: string) => void;
	onPromoteReview: (nodeId: string) => void;
	onDismissReview: (nodeId: string) => void;
}

export function NodeContextMenu({
	x,
	y,
	nodeId,
	nodeData,
	reviewActions,
	onClose,
	onFork,
	onReview,
	onSetRole,
	onDormant,
	onWake,
	onUnmerge,
	onDelete,
	onReveal,
	onConvertToSubagent,
	onPromoteReview,
	onDismissReview,
}: NodeContextMenuProps) {
	const { t } = useTranslation("graph");
	const isRoot = !!nodeData.isRoot;
	const displayTitle = clampNodeContextTitle(nodeData.title);
	const fsRevealCapability = useFsRevealCapability();
	const canReveal = fsRevealCapability.supported && !!nodeData.worktreePath;
	const effectiveReviewActions = reviewActions ?? {
		request: true,
		convertToSubagent: true,
		promote: true,
		dismiss: true,
	};
	const canConvertToSubagent =
		effectiveReviewActions.convertToSubagent && nodeData.reviewStatus === "concluded";
	const canPromoteReview =
		effectiveReviewActions.promote &&
		(nodeData.reviewStatus === "concluded" || nodeData.reviewStatus === "reviewing");

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay to capture clicks */}
			<div
				style={{ position: "fixed", inset: 0, zIndex: Z.contextMenuBackdrop }}
				onClick={onClose}
				onContextMenu={(e) => {
					e.preventDefault();
					onClose();
				}}
				onKeyDown={() => {}}
				role="presentation"
			/>
			<Paper
				shadow="md"
				p="xs"
				withBorder
				style={{
					position: "fixed",
					left: x,
					top: y,
					zIndex: Z.contextMenu,
					minWidth: 180,
				}}
			>
				<Stack gap={2}>
					<Text size="xs" fw={600} c="dimmed" px="xs">
						{displayTitle}
					</Text>
					<UnstyledButton px="xs" py={4} onClick={() => onFork(nodeId)} style={{ borderRadius: 4 }}>
						<Text size="sm">{t("contextMenu.fork")}</Text>
					</UnstyledButton>
					{canReveal && (
						<UnstyledButton
							px="xs"
							py={4}
							onClick={() => onReveal(nodeId)}
							style={{ borderRadius: 4 }}
						>
							<Text size="sm">{t("contextMenu.revealInExplorer")}</Text>
						</UnstyledButton>
					)}
					{nodeData.status === "active" &&
						nodeData.role !== "review" &&
						effectiveReviewActions.request && (
							<UnstyledButton
								px="xs"
								py={4}
								onClick={() => onReview(nodeId)}
								style={{ borderRadius: 4 }}
							>
								<Text size="sm" c="yellow">
									{t("contextMenu.review")}
								</Text>
							</UnstyledButton>
						)}
					{nodeData.status === "active" && nodeData.role === "review" && (
						<>
							<Divider my={4} />
							<UnstyledButton
								px="xs"
								py={4}
								onClick={() => canConvertToSubagent && onConvertToSubagent(nodeId)}
								disabled={!canConvertToSubagent}
								style={{
									borderRadius: 4,
									opacity: canConvertToSubagent ? 1 : 0.4,
								}}
							>
								<Text size="sm">{t("contextMenu.reviewActions.sendToSource")}</Text>
							</UnstyledButton>
							<UnstyledButton
								px="xs"
								py={4}
								onClick={() => canPromoteReview && onPromoteReview(nodeId)}
								disabled={!canPromoteReview}
								style={{
									borderRadius: 4,
									opacity: canPromoteReview ? 1 : 0.4,
								}}
							>
								<Text size="sm">{t("contextMenu.reviewActions.promoteToChapter")}</Text>
							</UnstyledButton>
							<UnstyledButton
								px="xs"
								py={4}
								onClick={() => effectiveReviewActions.dismiss && onDismissReview(nodeId)}
								disabled={!effectiveReviewActions.dismiss}
								style={{
									borderRadius: 4,
									opacity: effectiveReviewActions.dismiss ? 1 : 0.4,
								}}
							>
								<Text size="sm" c="red">
									{t("contextMenu.reviewActions.dismiss")}
								</Text>
							</UnstyledButton>
						</>
					)}
					{!isRoot && (
						<>
							<Divider my={4} />
							<Text size="xs" fw={600} c="dimmed" px="xs">
								{t("contextMenu.setRole")}
							</Text>
							{(["branch", "exploration"] as const).map((role) => (
								<UnstyledButton
									key={role}
									px="xs"
									py={4}
									disabled={nodeData.role === role}
									onClick={() => onSetRole(nodeId, role)}
									style={{
										borderRadius: 4,
										opacity: nodeData.role === role ? 0.5 : 1,
									}}
								>
									<Text size="sm">{t(`contextMenu.role.${role}`)}</Text>
								</UnstyledButton>
							))}
							<Divider my={4} />
							{nodeData.status === "active" && (
								<UnstyledButton
									px="xs"
									py={4}
									onClick={() => onDormant(nodeId)}
									style={{ borderRadius: 4 }}
								>
									<Text size="sm">{t("contextMenu.dormant")}</Text>
								</UnstyledButton>
							)}
							{(nodeData.status === "dormant" || nodeData.status === "merged") && (
								<UnstyledButton
									px="xs"
									py={4}
									onClick={() => onWake(nodeId)}
									style={{ borderRadius: 4 }}
								>
									<Text size="sm">{t("contextMenu.wake")}</Text>
								</UnstyledButton>
							)}
							{nodeData.status === "merged" && (
								<UnstyledButton
									px="xs"
									py={4}
									onClick={() => onUnmerge(nodeId)}
									style={{ borderRadius: 4 }}
								>
									<Text size="sm" c="orange">
										{t("contextMenu.unmerge")}
									</Text>
								</UnstyledButton>
							)}
							<Divider my={4} />
							<UnstyledButton
								px="xs"
								py={4}
								onClick={() => onDelete(nodeId)}
								style={{ borderRadius: 4 }}
							>
								<Text size="sm" c="red">
									{t("contextMenu.delete")}
								</Text>
							</UnstyledButton>
						</>
					)}
				</Stack>
			</Paper>
		</>
	);
}
