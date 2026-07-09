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
import { api } from "../../lib/api";
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

const DRAFT_KEY_PREFIX = "narrafork_ask_draft_";
const ASK_DRAFT_STORAGE_MAX_CHARS = 256_000;
const ASK_DRAFT_FIELD_MAX_CHARS = 120_000;

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

function readAskDraft(draftKey: string): AskDraft | null {
	try {
		const raw = sessionStorage.getItem(draftKey);
		if (!raw) return null;
		if (raw.length > ASK_DRAFT_STORAGE_MAX_CHARS) {
			sessionStorage.removeItem(draftKey);
			return null;
		}
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
	draftKey: string,
	selections: Record<string, string>,
	customInputs: Record<string, string>,
) {
	try {
		const safeSelections = sanitizeDraftRecord(selections);
		const safeCustomInputs = sanitizeDraftRecord(customInputs);
		const hasPersistableContent =
			Object.values(safeSelections).some(Boolean) || Object.values(safeCustomInputs).some(Boolean);
		if (!hasPersistableContent) {
			sessionStorage.removeItem(draftKey);
			return;
		}
		const serialized = JSON.stringify({
			selections: safeSelections,
			customInputs: safeCustomInputs,
		});
		if (serialized.length <= ASK_DRAFT_STORAGE_MAX_CHARS) {
			sessionStorage.setItem(draftKey, serialized);
		} else {
			sessionStorage.removeItem(draftKey);
		}
	} catch {
		try {
			sessionStorage.removeItem(draftKey);
		} catch {
			// ignore storage cleanup failures
		}
	}
}

interface AskUserQuestionBannerProps {
	requestId: string;
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
	onReflect?: (requestId: string) => Promise<void> | void;
}

export function AskUserQuestionBanner({
	requestId,
	questions: rawQuestions,
	answers: savedAnswers,
	readOnly,
	reflectionDeadline,
	onSubmit,
	onDeny,
	onReflect,
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
	const draftKey = `${DRAFT_KEY_PREFIX}${requestId}`;
	const storedDraftRef = useRef<AskDraft | null | undefined>(undefined);
	const getStoredDraft = () => {
		if (storedDraftRef.current === undefined) {
			storedDraftRef.current = readOnly ? null : readAskDraft(draftKey);
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
			sessionStorage.removeItem(draftKey);
		}
	}, [readOnly, draftKey, selections, customInputs]);

	// Custom input takes priority when non-empty
	const getAnswer = (question: string) => {
		const custom = customInputs[question]?.trim();
		return custom || selections[question] || "";
	};
	const handleRadioChange = (question: string, value: string) => {
		disarmReflection();
		setSelections((prev) => ({ ...prev, [question]: value }));
	};

	const handleCheckboxChange = (question: string, label: string, checked: boolean) => {
		disarmReflection();
		const current = selections[question] ? selections[question].split(", ") : [];
		const updated = checked ? [...current, label] : current.filter((v) => v !== label);
		setSelections((prev) => ({ ...prev, [question]: updated.join(", ") }));
	};

	const handleCustomInput = (question: string, value: string) => {
		disarmReflection();
		setCustomInputs((prev) => ({ ...prev, [question]: value }));
	};

	const allAnswered = questions.every((q) => getAnswer(q.question));

	const handleSubmit = () => {
		if (!allAnswered) return;
		const answers: Record<string, string> = {};
		for (const q of questions) {
			answers[q.question] = getAnswer(q.question);
		}
		sessionStorage.removeItem(draftKey);
		onSubmit?.(requestId, answers);
	};

	const handleReflect = async () => {
		if (!onReflect || reflecting) return;
		setReflecting(true);
		try {
			await onReflect(requestId);
			sessionStorage.removeItem(draftKey);
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
						const hasCustom = readOnly ? false : !!customInputs[q.question]?.trim();
						const savedAnswer = readOnly
							? resolveSavedAnswer(q, savedAnswers, { allowSingleAnswerFallback })
							: undefined;
						const customAnswer = readOnly
							? getCustomSavedAnswer(q, savedAnswers, { allowSingleAnswerFallback })
							: undefined;
						const questionKey = `${q.question}-${questionIndex}`;
						return (
							<Stack key={questionKey} gap="xs">
								<Text size="sm" fw={500}>
									{q.header}
								</Text>
								{q.options.length > 0 &&
									(q.multiSelect ? (
										<Stack gap={4}>
											{q.options.map((opt) => (
												<Checkbox
													key={opt.label}
													label={opt.label}
													description={opt.description}
													disabled={readOnly || hasCustom}
													checked={
														readOnly
															? isSavedOptionSelected(q, opt.label, savedAnswers, {
																	allowSingleAnswerFallback,
																})
															: undefined
													}
													onChange={
														readOnly
															? undefined
															: (e) =>
																	handleCheckboxChange(
																		q.question,
																		opt.label,
																		e.currentTarget.checked,
																	)
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
														: (selections[q.question] ?? "")
											}
											onChange={readOnly ? () => {} : (val) => handleRadioChange(q.question, val)}
										>
											<Stack gap={4}>
												{q.options.map((opt) => (
													<Radio
														key={opt.label}
														value={opt.label}
														label={opt.label}
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
										value={customInputs[q.question] ?? ""}
										onChange={(e) => handleCustomInput(q.question, e.currentTarget.value)}
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
							<Button size="xs" onClick={handleSubmit} disabled={!allAnswered}>
								{t("submitAnswer")}
							</Button>
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
							<Button
								size="xs"
								color="red"
								variant="light"
								onClick={() => {
									sessionStorage.removeItem(draftKey);
									onDeny?.(requestId);
								}}
							>
								{t("skipQuestion")}
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
