import { Alert, Badge, Button, Checkbox, Group, Radio, Stack, Text, Textarea } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface Question {
	question: string;
	header: string;
	multiSelect?: boolean;
	options: { label: string; description: string }[];
}

interface AskUserQuestionBannerProps {
	requestId: string;
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
	questions,
	answers: savedAnswers,
	readOnly,
	onSubmit,
	onDeny,
}: AskUserQuestionBannerProps) {
	const { t } = useTranslation("narrator");
	const [selections, setSelections] = useState<Record<string, string>>({});
	const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

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
		onSubmit?.(requestId, answers);
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
				{questions.map((q) => {
					const hasCustom = readOnly ? false : !!customInputs[q.question]?.trim();
					const customAnswer = readOnly ? getCustomAnswer(q) : undefined;
					return (
						<Stack key={q.header} gap="xs">
							<Text size="sm" fw={500}>
								{q.question}
							</Text>
							{q.multiSelect ? (
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
							)}
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
						<Button size="xs" color="red" variant="light" onClick={() => onDeny?.(requestId)}>
							{t("skipQuestion")}
						</Button>
					</Group>
				)}
			</Stack>
		</Alert>
	);
}
