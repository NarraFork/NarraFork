import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Checkbox,
	Group,
	Modal,
	NumberInput,
	Radio,
	Stack,
	Switch,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { IconClockHour4, IconSettings } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { readSession, removeSession, writeSession } from "../../../lib/session-store";
import {
	coerceQuestions,
	formatHMS,
	getCustomSavedAnswer,
	getSelectedOptionValue,
	isSavedOptionSelected,
	type Question,
	resolveSavedAnswer,
} from "./ask-user-question-utils";

export { coerceQuestions, formatHMS } from "./ask-user-question-utils";

/**
 * Ceilings for one stored ask-question draft.
 *
 * Was 256k envelope / 120k per field. Keyed by REQUEST ID, so the id space grows
 * with every question that was never answered — a generous per-entry ceiling on an
 * unbounded key space is what pushed `sessionStorage` toward its quota. These
 * fields hold option selections and short free-text answers; anything larger stays
 * in component state and is simply not mirrored.
 */
const ASK_DRAFT_STORAGE_MAX_CHARS = 32_000;
const ASK_DRAFT_FIELD_MAX_CHARS = 24_000;

type AskDraft = {
	selections?: Record<string, string>;
	customInputs?: Record<string, string>;
};

function sanitizeDraftRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	const result: Record<string, string> = {};
	for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
		if (typeof text === "string" && text.length <= ASK_DRAFT_FIELD_MAX_CHARS) {
			result[key] = text;
		}
	}
	return result;
}

function readAskDraft(draftId: string): AskDraft | null {
	try {
		const raw = readSession("ask-draft", draftId);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as AskDraft;
		return {
			selections: sanitizeDraftRecord(parsed.selections),
			customInputs: sanitizeDraftRecord(parsed.customInputs),
		};
	} catch {
		return null;
	}
}

function persistAskDraft(
	draftId: string,
	selections: Record<string, string>,
	customInputs: Record<string, string>,
) {
	try {
		const safeSelections = sanitizeDraftRecord(selections);
		const safeCustomInputs = sanitizeDraftRecord(customInputs);
		const hasPersistableContent =
			Object.values(safeSelections).some(Boolean) || Object.values(safeCustomInputs).some(Boolean);
		if (!hasPersistableContent) {
			removeSession("ask-draft", draftId);
			return;
		}
		const serialized = JSON.stringify({
			selections: safeSelections,
			customInputs: safeCustomInputs,
		});
		if (serialized.length <= ASK_DRAFT_STORAGE_MAX_CHARS) {
			writeSession("ask-draft", draftId, serialized);
		} else {
			removeSession("ask-draft", draftId);
		}
	} catch {
		try {
			removeSession("ask-draft", draftId);
		} catch {
			// ignore storage cleanup failures
		}
	}
}

interface AskUserQuestionBannerProps {
	requestId: string;
	/** Stable local draft identity (the tool-call id survives deferral). Never used for API calls. */
	draftId?: string;
	questions: Question[];
	/** Pre-filled answers — used for read-only display of completed questions */
	answers?: Record<string, string>;
	/** When true, render in read-only mode (no submit/skip, selections locked) */
	readOnly?: boolean;
	/**
	 * Absolute epoch-ms deadline for automatic reflection. When set (and not
	 * read-only), a live countdown is shown until the user interacts, which
	 * disarms the timer.
	 */
	reflectionDeadline?: number | null;
	onSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onDeny?: (requestId: string) => void;
	/**
	 * Run the model's own answer instead. Omit for questions where that makes no sense
	 * (asynchronous ones), which also hides the button — see the render note below.
	 */
	onReflect?: (requestId: string) => Promise<void> | void;
	/**
	 * Label for the decline action. Defaults to "skip". An asynchronous question passes
	 * its own wording, because "skip" understates what happens there: the agent is told
	 * to decide for itself and moves on permanently.
	 */
	denyLabel?: string;
	/** Show the submit/decline buttons as busy while a request is in flight. */
	busy?: boolean;
	/**
	 * Release the blocked session without answering, moving this question to the async
	 * inbox. Offered only for a BLOCKING prompt — an async question is already deferred,
	 * so the button would be a no-op there and is hidden when this is absent.
	 */
	onDefer?: (requestId: string) => Promise<void> | void;
}

export function AskUserQuestionBanner({
	requestId,
	draftId = requestId,
	questions: rawQuestions,
	answers: savedAnswers,
	readOnly,
	reflectionDeadline,
	onSubmit,
	onDeny,
	onReflect,
	denyLabel,
	busy,
	onDefer,
}: AskUserQuestionBannerProps) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const qc = useQueryClient();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const { data: settingsData, isLoading: settingsLoading } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const updateSettingsMutation = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => {
			qc.setQueryData(["settings"], data);
			qc.invalidateQueries({ queryKey: ["settings"] });
		},
	});
	const questionReflectionEnabled = settingsData?.agent?.questionReflectionEnabled ?? false;
	const questionReflectionTimeoutMs = settingsData?.agent?.questionReflectionTimeoutMs ?? 300000;
	const settingsDisabled = settingsLoading || updateSettingsMutation.isPending;
	const updateQuestionReflectionEnabled = (enabled: boolean) => {
		updateSettingsMutation.mutate({ agent: { questionReflectionEnabled: enabled } });
	};
	const updateQuestionReflectionTimeout = (secondsValue: string | number) => {
		if (typeof secondsValue !== "number" || !Number.isFinite(secondsValue)) return;
		const timeoutMs = Math.max(10000, Math.min(3600000, Math.round(secondsValue * 1000)));
		updateSettingsMutation.mutate({ agent: { questionReflectionTimeoutMs: timeoutMs } });
	};
	// Defensive: questions may come from untyped JSON or as a stringified array
	const questions = coerceQuestions(rawQuestions);
	const draftKey = draftId;
	const storedDraftRef = useRef<AskDraft | null | undefined>(undefined);
	const getStoredDraft = () => {
		if (storedDraftRef.current === undefined) {
			// Existing async forms used the question/request id. Adopt that draft when
			// no stable tool-call draft exists, without changing the API request identity.
			storedDraftRef.current = readOnly
				? null
				: (readAskDraft(draftKey) ?? readAskDraft(requestId));
		}
		return storedDraftRef.current;
	};
	const [selections, setSelections] = useState<Record<string, string>>(
		() => getStoredDraft()?.selections ?? {},
	);
	const [customInputs, setCustomInputs] = useState<Record<string, string>>(
		() => getStoredDraft()?.customInputs ?? {},
	);
	const [reflecting, setReflecting] = useState(false);
	const [deferring, setDeferring] = useState(false);

	// --- Automatic-reflection countdown & disarm-on-interaction -----------------
	// Local override so the countdown disappears the moment the user interacts,
	// without waiting for the server round-trip / WS echo.
	const [disarmed, setDisarmed] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const disarmSentRef = useRef(false);
	const activeDeadline =
		!readOnly && !disarmed && typeof reflectionDeadline === "number" ? reflectionDeadline : null;
	const countdownMs = activeDeadline !== null ? activeDeadline - now : null;

	// Reset local disarm state if a fresh deadline arrives (new request/rearm).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when the deadline changes
	useEffect(() => {
		setDisarmed(false);
		disarmSentRef.current = false;
	}, [reflectionDeadline]);

	// Tick once per second while a countdown is visible.
	useEffect(() => {
		if (activeDeadline === null) return;
		setNow(Date.now());
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [activeDeadline]);

	// Disarm the automatic reflection timer the first time the user touches the
	// form, so the auto-answer cannot fire mid-typing. Best-effort / fire-and-forget.
	const disarmReflection = () => {
		if (readOnly || disarmSentRef.current) return;
		disarmSentRef.current = true;
		setDisarmed(true);
		if (requestId) {
			void api.disarmQuestionReflection(requestId).catch(() => {
				// Non-fatal: the timer may already have fired; the reflection UI handles it.
			});
		}
	};

	// Persist draft to sessionStorage
	useEffect(() => {
		if (readOnly) return;
		const hasContent =
			Object.values(selections).some((v) => v) || Object.values(customInputs).some((v) => v);
		if (hasContent) {
			persistAskDraft(draftKey, selections, customInputs);
		} else {
			removeSession("ask-draft", draftKey);
		}
		if (draftKey !== requestId) removeSession("ask-draft", requestId);
	}, [readOnly, draftKey, requestId, selections, customInputs]);

	// Custom input takes priority when non-empty. Drafts are keyed by internal `id`;
	// model-facing answers are keyed by `header`.
	const getAnswer = (draftId: string) => {
		const custom = customInputs[draftId]?.trim();
		return custom || selections[draftId] || "";
	};
	const handleRadioChange = (draftId: string, value: string) => {
		disarmReflection();
		setSelections((prev) => ({ ...prev, [draftId]: value }));
	};

	const handleCheckboxChange = (draftId: string, optionHeader: string, checked: boolean) => {
		disarmReflection();
		const current = selections[draftId] ? selections[draftId].split(", ") : [];
		const updated = checked
			? [...current, optionHeader]
			: current.filter((v) => v !== optionHeader);
		setSelections((prev) => ({ ...prev, [draftId]: updated.join(", ") }));
	};

	const handleCustomInput = (draftId: string, value: string) => {
		disarmReflection();
		setCustomInputs((prev) => ({ ...prev, [draftId]: value }));
	};

	const allAnswered = questions.every((q) => getAnswer(q.id));

	const handleSubmit = () => {
		if (!allAnswered) return;
		const answers: Record<string, string> = {};
		for (const q of questions) {
			// Models only see header + description; key answers by the uniquified header.
			// Coerce guarantees headers do not collide, so this cannot overwrite.
			answers[q.header] = getAnswer(q.id);
		}
		removeSession("ask-draft", draftKey);
		onSubmit?.(requestId, answers);
	};

	const handleReflect = async () => {
		if (!onReflect || reflecting) return;
		setReflecting(true);
		try {
			await onReflect(requestId);
			removeSession("ask-draft", draftKey);
		} finally {
			setReflecting(false);
		}
	};

	const alertColor = readOnly ? "gray" : "blue";

	return (
		<>
			<Alert color={alertColor} radius="md">
				<Stack gap="md">
					{questions.map((q, questionIndex) => {
						const allowSingleAnswerFallback = questions.length === 1;
						const hasCustom = readOnly ? false : !!customInputs[q.id]?.trim();
						const savedAnswer = readOnly
							? resolveSavedAnswer(q, savedAnswers, { allowSingleAnswerFallback })
							: undefined;
						const customAnswer = readOnly
							? getCustomSavedAnswer(q, savedAnswers, { allowSingleAnswerFallback })
							: undefined;
						const questionKey = `${q.id}-${questionIndex}`;
						return (
							<Stack key={questionKey} gap="xs">
								<Text size="sm" fw={500} style={{ whiteSpace: "pre-wrap" }}>
									{q.header}
								</Text>
								{q.description ? (
									<Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
										{q.description}
									</Text>
								) : null}
								{q.options.length > 0 &&
									(q.multiSelect ? (
										<Stack gap={4}>
											{q.options.map((opt) => (
												<Checkbox
													key={opt.header}
													label={opt.header}
													description={opt.description}
													disabled={readOnly || hasCustom}
													checked={
														readOnly
															? isSavedOptionSelected(q, opt.header, savedAnswers, {
																	allowSingleAnswerFallback,
																})
															: (selections[q.id]?.split(", ").includes(opt.header) ?? false)
													}
													onChange={
														readOnly
															? undefined
															: (e) =>
																	handleCheckboxChange(q.id, opt.header, e.currentTarget.checked)
													}
												/>
											))}
										</Stack>
									) : (
										<Radio.Group
											name={`${requestId}-question-${questionIndex}`}
											value={
												readOnly
													? getSelectedOptionValue(q, savedAnswers, { allowSingleAnswerFallback })
													: hasCustom
														? ""
														: (selections[q.id] ?? "")
											}
											onChange={readOnly ? () => {} : (val) => handleRadioChange(q.id, val)}
										>
											<Stack gap={4}>
												{q.options.map((opt) => (
													<Radio
														key={opt.header}
														value={opt.header}
														label={opt.header}
														description={opt.description}
														disabled={readOnly || hasCustom}
													/>
												))}
											</Stack>
										</Radio.Group>
									))}
								{readOnly ? (
									customAnswer && (
										<Text size="xs" ff="monospace" c="teal">
											{customAnswer}
										</Text>
									)
								) : (
									<Textarea
										size="xs"
										placeholder={t("typeCustomAnswer")}
										value={customInputs[q.id] ?? ""}
										onChange={(e) => handleCustomInput(q.id, e.currentTarget.value)}
										autosize
										minRows={1}
										maxRows={3}
									/>
								)}
								{readOnly && savedAnswer && (
									<Badge size="xs" color="teal" variant="light">
										{t("answered")}
									</Badge>
								)}
							</Stack>
						);
					})}
					{countdownMs !== null && (
						<Group gap={6} wrap="nowrap">
							<IconClockHour4
								size={14}
								color="var(--mantine-color-yellow-6)"
								style={{ flexShrink: 0 }}
							/>
							<Text size="xs" c="dimmed">
								{t("questionReflectionCountdown", { time: formatHMS(countdownMs) })}
							</Text>
						</Group>
					)}
					{!readOnly && (
						<Group>
							<Button
								size="xs"
								onClick={handleSubmit}
								disabled={!allAnswered || busy}
								loading={busy}
							>
								{t("submitAnswer")}
							</Button>
							{/*
							 * Reflection ("let the model answer for me") only exists for a BLOCKING
							 * question, where it is the escape hatch from a stalled session. An
							 * asynchronous question already stalls nothing, so a caller that passes
							 * no `onReflect` gets no button — offering one would advertise a feature
							 * that has no wiring behind it here.
							 */}
							{onReflect && (
								<Group gap={4} wrap="nowrap">
									<Button size="xs" variant="light" loading={reflecting} onClick={handleReflect}>
										{reflecting ? t("questionReflecting") : t("questionReflectionAnswer")}
									</Button>
									<Tooltip label={t("questionReflectionSettings")}>
										<ActionIcon
											size="sm"
											variant="subtle"
											aria-label={t("questionReflectionSettings")}
											onClick={() => setSettingsOpen(true)}
										>
											<IconSettings size={14} />
										</ActionIcon>
									</Tooltip>
								</Group>
							)}
							{/* "Answer later" keeps the DRAFT: unlike skip, the user still intends to
							    answer, so discarding what they had typed would be a data loss. */}
							{onDefer && (
								<Button
									size="xs"
									variant="subtle"
									loading={deferring}
									disabled={busy}
									onClick={async () => {
										if (deferring) return;
										setDeferring(true);
										try {
											await onDefer(requestId);
										} finally {
											setDeferring(false);
										}
									}}
								>
									{t("deferQuestion")}
								</Button>
							)}
							<Button
								size="xs"
								color="red"
								variant="light"
								disabled={busy}
								onClick={() => {
									removeSession("ask-draft", draftKey);
									onDeny?.(requestId);
								}}
							>
								{denyLabel ?? t("skipQuestion")}
							</Button>
						</Group>
					)}
				</Stack>
			</Alert>
			<Modal
				opened={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				title={t("questionReflectionSettings")}
				centered
				size="md"
			>
				<Stack gap="md">
					<Text size="sm" c="dimmed">
						{t("questionReflectionSettingsDesc")}
					</Text>
					<Switch
						label={ts("questionReflectionEnabled")}
						description={ts("questionReflectionEnabledDesc")}
						checked={questionReflectionEnabled}
						onChange={(event) => updateQuestionReflectionEnabled(event.currentTarget.checked)}
						disabled={settingsDisabled}
					/>
					<NumberInput
						label={ts("questionReflectionTimeout")}
						description={ts("questionReflectionTimeoutDesc")}
						value={questionReflectionTimeoutMs / 1000}
						onChange={updateQuestionReflectionTimeout}
						min={10}
						max={3600}
						step={10}
						decimalScale={0}
						suffix="s"
						disabled={settingsDisabled}
					/>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setSettingsOpen(false)}>
							{tc("close")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
