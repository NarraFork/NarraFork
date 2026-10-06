import {
	Divider,
	Paper,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
	VisuallyHidden,
} from "@mantine/core";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useFsRevealCapability } from "../../hooks/usePlatform";
import { Z } from "../../lib/z-index";

const MAX_NODE_CONTEXT_TITLE_CHARS = 500;

function clampNodeContextTitle(value: string): string {
	return value.length > MAX_NODE_CONTEXT_TITLE_CHARS
		? `${value.slice(0, MAX_NODE_CONTEXT_TITLE_CHARS)}…`
		: value;
}

/**
 * A menu action that can be unavailable, and says why.
 *
 * Uses `aria-disabled` plus a `data-disabled` style hook instead of the native
 * `disabled` attribute. `<button disabled>` receives no pointer events at all, so the
 * wrapping Mantine `Tooltip` never saw a hover and the explanation
 * (`forkRequiresActive` / `dormantRequiresWorktree`) could not be shown — `opacity: 0.4`
 * was the only signal, and a screen reader heard "disabled" with no reason. A disabled
 * button is also dropped from the tab order, so the reason was unreachable by keyboard
 * even in principle.
 *
 * Staying focusable keeps both channels open: the tooltip fires on hover and focus, and
 * the reason is also attached through `aria-describedby` so it is announced whether or
 * not the tooltip is open. The click guard has to live here instead of in the DOM, which
 * is why `onClick` is only called when the action is available.
 */
function MenuAction({
	label,
	color,
	reason,
	available,
	onSelect,
}: {
	label: string;
	color?: string;
	/** Why the action is unavailable. Shown as a tooltip and as the accessible description. */
	reason?: string;
	available: boolean;
	onSelect: () => void;
}) {
	const reasonId = useId();
	const button = (
		<UnstyledButton
			px="xs"
			py={4}
			onClick={() => available && onSelect()}
			aria-disabled={available ? undefined : true}
			data-disabled={available ? undefined : true}
			aria-describedby={!available && reason ? reasonId : undefined}
			style={{
				borderRadius: 4,
				opacity: available ? 1 : 0.4,
				cursor: available ? undefined : "not-allowed",
			}}
		>
			<Text size="sm" c={color}>
				{label}
			</Text>
		</UnstyledButton>
	);
	if (available || !reason) return button;
	return (
		<>
			<Tooltip label={reason} position="right" withinPortal>
				{button}
			</Tooltip>
			{/* Sibling, not a child of the button: nesting it would fold the reason into the
			    button's accessible name, so it would be read out as part of every label. */}
			<VisuallyHidden id={reasonId}>{reason}</VisuallyHidden>
		</>
	);
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
	// Mirrors `chapterFork.fork`, which accepts an active OR dormant parent and rejects
	// merged/abandoned. Dormant is deliberately allowed: it is an ordinary resting state
	// that auto-dormant produces on a timer, and forking one resolves the start commit
	// from the branch rather than a live worktree, so no worktree is needed.
	const canFork = nodeData.status === "active" || nodeData.status === "dormant";
	// Mirrors `chapterCleanup.dormant`, which requires BOTH an active status and a
	// worktree — a chapter can be active with `worktreePath: null` (e.g. after a
	// merge that kept the directory but cleared the column), and the status check
	// alone let that through.
	const canDormant = nodeData.status === "active" && !!nodeData.worktreePath;
	// Dormant only. `chapterCleanup.wake` now refuses a merged chapter and points at
	// unmerge instead: waking one used to erase the merge coordinates while leaving its
	// changes applied in the target, producing a chapter that looked independent but
	// could no longer be unmerged and would re-apply its diff if merged again.
	const canWake = nodeData.status === "dormant";
	// Same active-or-dormant rule as fork, mirroring `reviewService.createReview`.
	const canReview = nodeData.status === "active" || nodeData.status === "dormant";
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
					<MenuAction
						label={t("contextMenu.fork")}
						reason={t("contextMenu.forkRequiresActive")}
						available={canFork}
						onSelect={() => onFork(nodeId)}
					/>
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
					{/* Dormant included: `reviewService.createReview` accepts active OR dormant
					    sources, for the same reason fork does — dormancy is a timer-driven
					    resting state, and refusing it made auto-dormant silently remove the
					    review action from older chapters. */}
					{canReview && nodeData.role !== "review" && effectiveReviewActions.request && (
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
								<MenuAction
									label={t("contextMenu.dormant")}
									reason={t("contextMenu.dormantRequiresWorktree")}
									available={canDormant}
									onSelect={() => onDormant(nodeId)}
								/>
							)}
							{canWake && (
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
