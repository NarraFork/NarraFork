import { Alert, Button, Checkbox, Group, Radio, Stack, Text, Textarea } from "@mantine/core";
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
	onSubmit: (requestId: string, answers: Record<string, string>) => void;
	onDeny: (requestId: string) => void;
}

export function AskUserQuestionBanner({
	requestId,
	questions,
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
		onSubmit(requestId, answers);
	};

	return (
		<Alert color="blue" title={t("questionFromNarrator")} radius="md">
			<Stack gap="md">
				{questions.map((q) => {
					const hasCustom = !!customInputs[q.question]?.trim();
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
											disabled={hasCustom}
											onChange={(e) =>
												handleCheckboxChange(q.question, opt.label, e.currentTarget.checked)
											}
										/>
									))}
								</Stack>
							) : (
								<Radio.Group
									value={hasCustom ? "" : (selections[q.question] ?? "")}
									onChange={(val) => handleRadioChange(q.question, val)}
								>
									<Stack gap={4}>
										{q.options.map((opt) => (
											<Radio
												key={opt.label}
												value={opt.label}
												label={opt.label}
												description={opt.description}
												disabled={hasCustom}
											/>
										))}
									</Stack>
								</Radio.Group>
							)}
							<Textarea
								size="xs"
								placeholder={t("typeCustomAnswer")}
								value={customInputs[q.question] ?? ""}
								onChange={(e) => handleCustomInput(q.question, e.currentTarget.value)}
								autosize
								minRows={1}
								maxRows={3}
							/>
						</Stack>
					);
				})}
				<Group>
					<Button size="xs" onClick={handleSubmit} disabled={!allAnswered}>
						{t("submitAnswer")}
					</Button>
					<Button size="xs" color="red" variant="light" onClick={() => onDeny(requestId)}>
						{t("skipQuestion")}
					</Button>
				</Group>
			</Stack>
		</Alert>
	);
}
