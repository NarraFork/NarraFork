/**
 * Inline permission form rendered inside a tool call card (and, via the vlist
 * permission bridge, inside the exact virtual list).
 *
 * Extracted from ToolCallCard.tsx: the form is strongly interactive (textarea,
 * keyboard-driven button bar, draft persistence), which makes it unusable as a
 * zero-DOM measured copy — the vlist mounts the real component as a live node.
 * Keeping it in the 6k-line card module meant every such bridge pulled the
 * whole classic renderer into its import graph.
 */

import { usePermissionFilePreview } from "@frontend/hooks/useNarrator";
import { readSession, removeSession, writeSession } from "@frontend/lib/session-store";
import type { PendingPermission } from "@frontend/types/narrator";
import {
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Modal,
	Paper,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { type CSSProperties, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorPermissionsCapability } from "../../../hooks/usePlatform";
import { DiffView } from "../diff/DiffView";
import { MESSAGE_SELECTION_IGNORE_ATTR } from "../message/MessageSelectionCtx";
import { AskUserQuestionBanner, coerceQuestions } from "../question/AskUserQuestionBanner";
import { PermEnterHintCtx } from "../tool-call/tool-call-contexts";
import { PermissionRuleRequestDetails } from "./PermissionRuleRequestDetails";

const noop = () => {};

// --- StructSed change preview ---

/**
 * What a pending StructSed call would change.
 *
 * Edit and Write carry their change in their input (old/new string, content), so the tool
 * card already shows it. StructSed carries only a selector (`symbol` / `address`) plus the
 * command, and approval is only ever asked for the real write (a dry run is read-only), so
 * there is no dry-run output on the card either. The server re-runs the tool's own pipeline
 * as a dry run and returns the changed window, which is shown here as a diff.
 */
function StructSedChangePreview({ permission }: { permission: PendingPermission }) {
	const { t } = useTranslation("narrator");
	const narratorId = permission.ownerNarratorId ?? "";
	const toolUseId = permission.toolUseId ?? null;
	const { data, isLoading, error } = usePermissionFilePreview(
		narratorId,
		toolUseId,
		!!narratorId && !!toolUseId,
	);
	if (!narratorId || !toolUseId) return null;
	if (isLoading) {
		return (
			<Group gap="xs" mb="xs">
				<Loader size="xs" />
				<Text size="xs" c="dimmed">
					{t("fileMod_previewLoading")}
				</Text>
			</Group>
		);
	}
	if (error) {
		return (
			<Text size="xs" c="red" mb="xs" style={{ overflowWrap: "anywhere" }}>
				{t("fileMod_previewFailed", {
					error: error instanceof Error ? error.message : String(error),
				})}
			</Text>
		);
	}
	const hunks = data?.diffHunks ?? [];
	if (hunks.length === 0) {
		return data ? (
			<Text size="xs" c="dimmed" mb="xs">
				{t("fileMod_diffTooLarge")}
			</Text>
		) : null;
	}
	const language = (data?.filePath ?? "").split(".").pop() ?? "";
	// One diff per changed region: a move is a removal here and an insertion there, and
	// showing them as one window would pull in every untouched line between them.
	return (
		<Stack gap={6} mb="xs">
			{hunks.map((hunk) => (
				<DiffView
					key={`${hunk.oldStart}:${hunk.newStart}`}
					oldStr={hunk.oldText}
					newStr={hunk.newText}
					startLine={hunk.oldStart}
					newStartLine={hunk.newStart}
					maxHeight={hunks.length > 1 ? 240 : 360}
					language={language}
				/>
			))}
			{data?.diffOmittedHunks ? (
				<Text size="xs" c="dimmed">
					{t("fileMod_diffHunksOmitted", { count: data.diffOmittedHunks })}
				</Text>
			) : null}
		</Stack>
	);
}

// --- Permission button bar with keyboard navigation ---

interface PermButton {
	label: string;
	color: string;
	variant?: string;
	onClick: () => void;
}

/**
 * Renders a row of permission buttons with keyboard-driven focus highlight.
 * Reports button count to the parent via setButtonCount so the global
 * keydown handler knows the navigation range.
 */
function PermButtonBar({
	buttons,
	focusIndex,
	setButtonCount,
	registerActions,
}: {
	buttons: PermButton[];
	focusIndex: number | null;
	setButtonCount: (n: number) => void;
	registerActions: (actions: (() => void)[]) => void;
}) {
	useEffect(() => {
		setButtonCount(buttons.length);
		registerActions(buttons.map((b) => b.onClick));
	}, [buttons, setButtonCount, registerActions]);

	return (
		<Group gap="sm">
			{buttons.map((btn, i) => {
				const focused = focusIndex === i;
				return (
					<Button
						key={`${btn.label}-${btn.color}`}
						size="sm"
						color={btn.color}
						variant={btn.variant as "light" | "subtle" | undefined}
						onClick={btn.onClick}
						className={focused ? "perm-btn-pulse" : undefined}
						style={
							focused
								? ({
										"--perm-pulse-color": `var(--mantine-color-${btn.color}-filled)`,
									} as CSSProperties)
								: undefined
						}
					>
						{btn.label}
						{focused && (
							<Text span size="xs" ml={4} opacity={0.7}>
								⏎
							</Text>
						)}
					</Button>
				);
			})}
		</Group>
	);
}

// --- Permission draft persistence ---

/**
 * Ceiling for one stored permission draft (feedback + edited plan).
 *
 * Was 256k envelope / 120k per field. These drafts are keyed by PERMISSION ID, an
 * id space that grows with every prompt the user never decided, so a generous
 * per-entry ceiling multiplied straight into `sessionStorage` pressure. An edited
 * plan is the larger of the two fields and still fits comfortably here; anything
 * past it is kept in component state and simply not mirrored.
 */
const PERMISSION_DRAFT_STORAGE_MAX_CHARS = 32_000;
const PERMISSION_DRAFT_FIELD_MAX_CHARS = 24_000;

interface StoredPermissionDraft {
	feedback: string;
	editedPlan: string | null;
}

function readStoredPermissionDraft(draftId: string): StoredPermissionDraft | null {
	try {
		const raw = readSession("permission-draft", draftId);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { feedback?: unknown; editedPlan?: unknown };
		const feedback =
			typeof parsed.feedback === "string" &&
			parsed.feedback.length <= PERMISSION_DRAFT_FIELD_MAX_CHARS
				? parsed.feedback
				: "";
		const editedPlan =
			typeof parsed.editedPlan === "string" &&
			parsed.editedPlan.length <= PERMISSION_DRAFT_FIELD_MAX_CHARS
				? parsed.editedPlan
				: null;
		return { feedback, editedPlan };
	} catch {
		return null;
	}
}

function canPersistPermissionDraft(feedback: string, editedPlan: string | null): boolean {
	if (feedback.length > PERMISSION_DRAFT_FIELD_MAX_CHARS) return false;
	if (editedPlan && editedPlan.length > PERMISSION_DRAFT_FIELD_MAX_CHARS) return false;
	return JSON.stringify({ feedback, editedPlan }).length <= PERMISSION_DRAFT_STORAGE_MAX_CHARS;
}

export function InlinePermission({
	permission,
	readOnly,
	onDecision,
	onQuestionSubmit,
	onQuestionReflect,
	onQuestionDeny,
	onQuestionDefer,
	onPlanPreviewChange,
}: {
	permission: PendingPermission;
	readOnly?: boolean;
	onDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onQuestionReflect?: (requestId: string) => Promise<void> | void;
	onQuestionDeny?: (requestId: string) => void;
	/** Release the blocked loop and move the question to the async inbox. */
	onQuestionDefer?: (requestId: string) => Promise<void> | void;
	onPlanPreviewChange?: (requestId: string, previewPlan: string | null) => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const permissionCapability = useNarratorPermissionsCapability();
	const permissionDecisionsSupported =
		permissionCapability.supported && permissionCapability.approveDeny;
	const permissionInputSupported =
		permissionCapability.supported && permissionCapability.updatedInput;
	const effectiveReadOnly = readOnly === true || !permissionDecisionsSupported;
	const permissionTarget = permission.executionTarget ?? permission.executionTargets?.[0];
	const permissionTargetDeviceId = permissionTarget?.deviceId ?? permission.executionDeviceId;
	const permissionTargetCwd = permissionTarget?.cwd ?? permission.executionCwd;
	const permissionLexicalPath = permissionTarget?.lexicalPath ?? permission.resolvedFilePath;
	const { focusIndex, setButtonCount, setHasFeedback, registerActions, activePermissionId } =
		useContext(PermEnterHintCtx);
	const isActivePermission = permission.id === activePermissionId;
	const draftKey = permission.id;
	const storedDraftRef = useRef<StoredPermissionDraft | null | undefined>(undefined);
	const getStoredDraft = () => {
		if (storedDraftRef.current === undefined) {
			storedDraftRef.current = readStoredPermissionDraft(draftKey) ?? null;
		}
		return storedDraftRef.current;
	};
	const [feedback, setFeedback] = useState(() => getStoredDraft()?.feedback ?? "");
	const [editing, setEditing] = useState(() => {
		const storedDraft = getStoredDraft();
		if (storedDraft?.editedPlan != null) {
			const pt =
				permission.toolName === "ExitPlanMode" && typeof permission.inputJson?.plan === "string"
					? permission.inputJson.plan
					: null;
			return storedDraft.editedPlan !== pt;
		}
		return false;
	});
	const [editedPlan, setEditedPlan] = useState<string | null>(
		() => getStoredDraft()?.editedPlan ?? null,
	);

	// Persist draft to sessionStorage
	useEffect(() => {
		const hasContent = feedback || editedPlan !== null;
		if (hasContent && canPersistPermissionDraft(feedback, editedPlan)) {
			writeSession("permission-draft", draftKey, JSON.stringify({ feedback, editedPlan }));
		} else {
			removeSession("permission-draft", draftKey);
		}
	}, [draftKey, feedback, editedPlan]);

	// Notify parent when feedback presence changes so the Enter hint can auto-switch
	// Only the active (earliest) permission should drive the global Enter key behavior.
	useEffect(() => {
		if (isActivePermission) setHasFeedback(!!feedback);
	}, [feedback, setHasFeedback, isActivePermission]);
	useEffect(() => {
		if (!isActivePermission || !effectiveReadOnly) return;
		setButtonCount(0);
		registerActions([]);
	}, [effectiveReadOnly, isActivePermission, registerActions, setButtonCount]);

	// Feedback confirmation dialog state (must be before early returns)
	const [feedbackConfirmOpen, setFeedbackConfirmOpen] = useState(false);
	const [pendingCompactAfter, setPendingCompactAfter] = useState<boolean | undefined>();

	// ExitPlanMode plan content is rendered by the tool card itself. The permission
	// area only exposes approval controls and an explicit edit mode.
	const planText =
		permission.toolName === "ExitPlanMode" && typeof permission.inputJson?.plan === "string"
			? permission.inputJson.plan
			: null;
	const isExitPlan = permission.toolName === "ExitPlanMode";
	const planEdited = editedPlan !== null && editedPlan !== planText;
	const previewPlan =
		isExitPlan && planText && (editing || planEdited) ? (editedPlan ?? planText) : null;

	useEffect(() => {
		onPlanPreviewChange?.(permission.id, previewPlan);
	}, [onPlanPreviewChange, permission.id, previewPlan]);
	useEffect(() => {
		return () => onPlanPreviewChange?.(permission.id, null);
	}, [onPlanPreviewChange, permission.id]);

	// AskUserQuestion: render the full question form inline
	const askQuestions =
		permission.toolName === "AskUserQuestion"
			? coerceQuestions(permission.inputJson?.questions)
			: [];
	if (permission.toolName === "AskUserQuestion" && askQuestions.length > 0) {
		return (
			<Box mt="xs" {...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}>
				<AskUserQuestionBanner
					requestId={permission.id}
					questions={askQuestions}
					readOnly={effectiveReadOnly || !permissionInputSupported}
					reflectionDeadline={permission.reflectionDeadline}
					onSubmit={(reqId, answers) => onQuestionSubmit?.(reqId, answers)}
					onReflect={(reqId) => onQuestionReflect?.(reqId)}
					onDeny={(reqId) => onQuestionDeny?.(reqId)}
					{...(onQuestionDefer ? { onDefer: (reqId: string) => onQuestionDefer(reqId) } : {})}
				/>
			</Box>
		);
	}

	const localizedDecisionReason = permission.decisionReason ?? null;

	const handleAllow = (compactAfter?: boolean) => {
		// If ExitPlanMode and user has feedback text, show confirmation dialog
		if (isExitPlan && feedback.trim()) {
			setPendingCompactAfter(compactAfter);
			setFeedbackConfirmOpen(true);
			return;
		}
		removeSession("permission-draft", draftKey);
		onDecision?.(
			permission.id,
			"allow",
			feedback || undefined,
			compactAfter,
			planEdited ? (editedPlan ?? undefined) : undefined,
		);
	};

	const handleConfirmExecute = () => {
		setFeedbackConfirmOpen(false);
		removeSession("permission-draft", draftKey);
		onDecision?.(
			permission.id,
			"allow",
			feedback || undefined,
			pendingCompactAfter,
			planEdited ? (editedPlan ?? undefined) : undefined,
		);
	};

	const handleConfirmRevise = () => {
		setFeedbackConfirmOpen(false);
		removeSession("permission-draft", draftKey);
		onDecision?.(permission.id, "deny", feedback || undefined);
	};

	const handleStartEdit = () => {
		if (planText && editedPlan === null) {
			setEditedPlan(planText);
		}
		setEditing(true);
	};

	// Regular permission: feedback textarea + Allow/Deny buttons
	return (
		<Box mt="xs" {...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}>
			{/* ExitPlanMode is a plan-approval gate, not a filesystem/command action:
			    its routed "target" is just the plan file the platform already read.
			    Showing device/cwd/lexical/canonical paths there is noise, and the
			    block's variable height fought the plan card's measured geometry. */}
			{permission.toolName === "RequestPermissionRule" && (
				<PermissionRuleRequestDetails permission={permission} />
			)}
			{permissionTargetDeviceId &&
				!isExitPlan &&
				permission.toolName !== "RequestPermissionRule" && (
					<Paper withBorder p="xs" mb="xs" radius="sm">
						<Group gap="xs" mb={permissionTargetCwd || permissionLexicalPath ? 4 : 0} wrap="wrap">
							<Text size="xs" fw={600}>
								{t("executionTarget")}
							</Text>
							<Badge
								size="xs"
								variant="light"
								color={permissionTargetDeviceId === "local" ? "gray" : "indigo"}
							>
								{permissionTargetDeviceId === "local"
									? t("executionTargetLocal")
									: permissionTargetDeviceId}
							</Badge>
							{permissionTarget?.pathFlavor && (
								<Badge size="xs" variant="outline" color="blue">
									{t("executionTargetPathFlavor", { flavor: permissionTarget.pathFlavor })}
								</Badge>
							)}
							{permissionTarget?.runtimeGeneration != null && (
								<Badge size="xs" variant="outline" color="grape">
									{t("executionTargetRuntimeGeneration", {
										generation: permissionTarget.runtimeGeneration,
									})}
								</Badge>
							)}
						</Group>
						{permissionTargetCwd && (
							<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
								{t("executionTargetCwd", { cwd: permissionTargetCwd })}
							</Text>
						)}
						{permissionLexicalPath && (
							<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
								{t("executionTargetLexicalPath", { path: permissionLexicalPath })}
							</Text>
						)}
						{permissionTarget?.canonicalPath && (
							<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
								{t("executionTargetCanonicalPath", { path: permissionTarget.canonicalPath })}
							</Text>
						)}
					</Paper>
				)}
			{permission.toolName === "StructSed" && <StructSedChangePreview permission={permission} />}
			{planEdited && !editing && (
				<Badge size="xs" color="indigo" variant="light" mb={4}>
					{t("planEdited")}
				</Badge>
			)}
			{planText && editing && (
				<Textarea
					mb="xs"
					value={editedPlan ?? planText}
					onChange={(e) => setEditedPlan(e.currentTarget.value)}
					autosize
					minRows={8}
					maxRows={30}
					disabled={effectiveReadOnly || !permissionInputSupported}
					styles={{ input: { fontFamily: "monospace", fontSize: "var(--mantine-font-size-xs)" } }}
				/>
			)}
			{localizedDecisionReason && (
				<Text size="xs" c="dimmed" mb={4}>
					{localizedDecisionReason}
				</Text>
			)}
			<Textarea
				size="xs"
				placeholder={t("feedbackPlaceholder")}
				value={feedback}
				onChange={(e) => setFeedback(e.currentTarget.value)}
				onKeyDown={(e) => {
					// Enter in feedback textarea → deny with feedback
					if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && feedback.trim()) {
						e.preventDefault();
						removeSession("permission-draft", draftKey);
						onDecision?.(permission.id, "deny", feedback);
					}
				}}
				autosize
				minRows={1}
				maxRows={3}
				mb="xs"
				disabled={effectiveReadOnly}
			/>
			{effectiveReadOnly ? (
				<Text size="xs" c="dimmed">
					{t("permissionActionsUnavailable")}
				</Text>
			) : (
				<PermButtonBar
					focusIndex={isActivePermission ? focusIndex : null}
					buttons={(() => {
						const btns: PermButton[] = [];
						if (!editing) {
							btns.push({
								label: isExitPlan
									? t("planExecute")
									: permission.toolName === "RequestPermissionRule"
										? t("permissionRuleRequest.approve")
										: tc("allow"),
								color: "green",
								onClick: () => handleAllow(),
							});
						}
						if (!editing && isExitPlan) {
							btns.push({
								label: t("acceptAndResetContext"),
								color: "teal",
								variant: "light",
								onClick: () => handleAllow(true),
							});
						}
						if (isExitPlan && planText && permissionInputSupported) {
							btns.push({
								label: editing ? t("planEditDone") : t("planEdit"),
								color: "indigo",
								variant: "light",
								onClick: () => {
									if (editing) setEditing(false);
									else handleStartEdit();
								},
							});
						}
						if ((planEdited || editing) && permissionInputSupported) {
							btns.push({
								label: t("planEditReset"),
								color: "gray",
								variant: "subtle",
								onClick: () => {
									setEditedPlan(null);
									setEditing(false);
								},
							});
						}
						if (!editing) {
							btns.push({
								label:
									isExitPlan && feedback.trim()
										? t("planRevise")
										: permission.toolName === "RequestPermissionRule"
											? t("permissionRuleRequest.deny")
											: tc("deny"),
								color: "red",
								variant: "light",
								onClick: () => {
									removeSession("permission-draft", draftKey);
									onDecision?.(permission.id, "deny", feedback || undefined);
								},
							});
						}
						return btns;
					})()}
					setButtonCount={isActivePermission ? setButtonCount : noop}
					registerActions={isActivePermission ? registerActions : noop}
				/>
			)}
			{isExitPlan && (
				<Modal
					opened={feedbackConfirmOpen}
					onClose={() => setFeedbackConfirmOpen(false)}
					title={t("planFeedbackConfirmTitle")}
					centered
					size="sm"
				>
					<Text size="sm" mb="lg">
						{t("planFeedbackConfirmMessage")}
					</Text>
					<Group justify="flex-end" gap="sm">
						<Button variant="light" color="red" onClick={handleConfirmRevise}>
							{t("planRevise")}
						</Button>
						<Button color="green" onClick={handleConfirmExecute}>
							{t("planExecuteWithoutRevision")}
						</Button>
					</Group>
				</Modal>
			)}
		</Box>
	);
}
