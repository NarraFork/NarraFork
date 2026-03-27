import { Button, Code, Group, Modal, ScrollArea, Stack, Text, Textarea } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface ModelTestDialogProps {
	opened: boolean;
	onClose: () => void;
	modelValue: string;
}

const DEFAULT_PROMPT = "Please introduce yourself in one sentence. / 请用一句话介绍你自己。";

export function ModelTestDialog({ opened, onClose, modelValue }: ModelTestDialogProps) {
	const { t } = useTranslation("settings");
	const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

	const testMut = useMutation({
		mutationFn: () => api.testModel(modelValue, prompt),
	});

	const handleTest = () => {
		testMut.mutate();
	};

	const handleClose = () => {
		testMut.reset();
		onClose();
	};

	return (
		<Modal opened={opened} onClose={handleClose} title={t("modelTestTitle")} size="lg">
			<Stack gap="md">
				<Group gap="xs">
					<Text size="sm" c="dimmed">
						{t("modelTestModel")}:
					</Text>
					<Code>{modelValue}</Code>
				</Group>

				<Textarea
					label={t("modelTestPrompt")}
					value={prompt}
					onChange={(e) => setPrompt(e.currentTarget.value)}
					minRows={3}
					maxRows={8}
					autosize
				/>

				<Button onClick={handleTest} loading={testMut.isPending} disabled={!prompt.trim()}>
					{testMut.isPending ? t("modelTestRunning") : t("modelTestRun")}
				</Button>

				{testMut.isError && (
					<Text size="sm" c="red">
						{testMut.error instanceof Error ? testMut.error.message : String(testMut.error)}
					</Text>
				)}

				{testMut.isSuccess && (
					<Stack gap="xs">
						<Text size="sm" fw={500}>
							{t("modelTestResult")}
						</Text>
						<ScrollArea.Autosize mah={300}>
							<Code block style={{ whiteSpace: "pre-wrap" }}>
								{testMut.data.text}
							</Code>
						</ScrollArea.Autosize>
					</Stack>
				)}
			</Stack>
		</Modal>
	);
}
