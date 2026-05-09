import { Alert, Badge, Button, Checkbox, Group, Radio, Stack, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

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

interface Question {
	question: string;
	header: string;
	multiSelect?: boolean;
	options: { label: string; description: string }[];
}

/**
 * Coerce a possibly-stringified questions value into a Question[].
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON from various providers
export function coerceQuestions(raw: any): Question[] {
	if (Array.isArray(raw)) return raw;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// not valid JSON — fall through
		}
	}
	return [];
}

interface AskUserQuestionBannerProps {
	requestId: string;
	narratorId: string;
	questions: Question[];
	/** Pre-filled answers — used for read-only display of completed questions */
	answers?: Record<string, string>;
	/** When true, render in read-only mode (no submit/skip, selections locked) */
	readOnly?: boolean;
	onSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onDeny?: (requestId: string) => void;
}

export function AskUserQuestionBanner({
	requestId,
	narratorId,
	questions: rawQuestions,
	answers: savedAnswers,
	readOnly,
	onSubmit,
	onDeny,
}: AskUserQuestionBannerProps) {
	const { t } = useTranslation("narrator");
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
	const [suggesting, setSuggesting] = useState(false);

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
		setSelections((prev) => ({ ...prev, [question]: value }));
	};

	const handleCheckboxChange = (question: string, label: string, checked: boolean) => {
		const current = selections[question] ? selections[question].split(", ") : [];
		const updated = checked ? [...current, label] : current.filter((v) => v !== label);
		setSelections((prev) => ({ ...prev, [question]: updated.join(", ") }));
	};

	const handleCustomInput = (question: string, value: string) => {
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

	const handleSuggest = async () => {
		setSuggesting(true);
		try {
			const { answers } = await api.suggestAnswers(narratorId, questions);
			const newSelections: Record<string, string> = {};
			const newCustom: Record<string, string> = {};
			for (const q of questions) {
				const suggested = answers[q.question];
				if (!suggested) continue;
				const optionLabels = q.options.map((o) => o.label);
				if (q.multiSelect) {
					// Match comma-separated labels against options
					const parts = suggested.split(", ").filter((p) => optionLabels.includes(p));
					if (parts.length) {
						newSelections[q.question] = parts.join(", ");
					} else {
						newCustom[q.question] = suggested;
					}
				} else if (optionLabels.includes(suggested)) {
					newSelections[q.question] = suggested;
				} else {
					newCustom[q.question] = suggested;
				}
			}
			setSelections((prev) => ({ ...prev, ...newSelections }));
			setCustomInputs((prev) => ({ ...prev, ...newCustom }));
		} catch {
			notifications.show({
				message: t("suggestFailed"),
				color: "red",
				autoClose: 3000,
			});
		} finally {
			setSuggesting(false);
		}
	};

	/** Check if a saved answer matches a specific option label (exact or within comma-separated list) */
	const isOptionSelected = (question: string, optLabel: string) => {
		const answer = savedAnswers?.[question];
		if (!answer) return false;
		return answer === optLabel || answer.split(", ").includes(optLabel);
	};

	/** Check if the saved answer is a custom (free-text) response not matching any option */
	const getCustomAnswer = (q: Question) => {
		const answer = savedAnswers?.[q.question];
		if (!answer) return undefined;
		const optionLabels = q.options.map((o) => o.label);
		// If the answer doesn't match any option (or combination), it's custom
		const parts = answer.split(", ");
		if (parts.every((p) => optionLabels.includes(p))) return undefined;
		return answer;
	};
	const alertColor = readOnly ? "gray" : "blue";

	return (
		<Alert color={alertColor} radius="md">
			<Stack gap="md">
				{questions.map((q, questionIndex) => {
					const hasCustom = readOnly ? false : !!customInputs[q.question]?.trim();
					const customAnswer = readOnly ? getCustomAnswer(q) : undefined;
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
												checked={readOnly ? isOptionSelected(q.question, opt.label) : undefined}
												onChange={
													readOnly
														? undefined
														: (e) =>
																handleCheckboxChange(q.question, opt.label, e.currentTarget.checked)
												}
											/>
										))}
									</Stack>
								) : (
									<Radio.Group
										name={`${requestId}-question-${questionIndex}`}
										value={
											readOnly
												? isOptionSelected(q.question, savedAnswers?.[q.question] ?? "")
													? savedAnswers?.[q.question]
													: ""
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
							{readOnly && savedAnswers?.[q.question] && (
								<Badge size="xs" color="teal" variant="light">
									{t("answered")}
								</Badge>
							)}
						</Stack>
					);
				})}
				{!readOnly && (
					<Group>
						<Button size="xs" onClick={handleSubmit} disabled={!allAnswered}>
							{t("submitAnswer")}
						</Button>
						<Button size="xs" variant="light" loading={suggesting} onClick={handleSuggest}>
							{suggesting ? t("suggesting") : t("suggestAnswer")}
						</Button>
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
	);
}
