import { Button, Code, Group, Modal, ScrollArea, Stack, Text, Textarea } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/api/client";

interface ModelTestDialogProps {
	opened: boolean;
	onClose: () => void;
	modelValue: string;
}

interface RequestUrl {
	url: string;
	method: string;
}

/** Extract captured request URLs from a failed test (error response body). */
function requestUrlsFromError(error: unknown): RequestUrl[] {
	if (error instanceof ApiError) {
		const urls = error.data?.requestUrls;
		if (Array.isArray(urls)) return urls as RequestUrl[];
	}
	return [];
}

const DEFAULT_PROMPT = "Please introduce yourself in one sentence. / 请用一句话介绍你自己。";
const MAX_MODEL_TEST_RESULT_CHARS = 60_000;

export function ModelTestDialog({ opened, onClose, modelValue }: ModelTestDialogProps) {
	const { t } = useTranslation("settings");
	const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

	const testMut = useMutation({
		mutationFn: () => api.testModel(modelValue, prompt),
	});
	const displayedResult =
		testMut.data?.text && testMut.data.text.length > MAX_MODEL_TEST_RESULT_CHARS
			? testMut.data.text.slice(0, MAX_MODEL_TEST_RESULT_CHARS)
			: testMut.data?.text;
	const resultTruncated = !!testMut.data?.text && displayedResult !== testMut.data.text;

	// Actual request URLs: from success payload, or from the error body on failure.
	const requestUrls: RequestUrl[] = testMut.isSuccess
		? (testMut.data?.requestUrls ?? [])
		: requestUrlsFromError(testMut.error);

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
						{resultTruncated && (
							<Text size="xs" c="yellow">
								{t("modelTestResultTruncated")}
							</Text>
						)}
						<ScrollArea.Autosize mah={300}>
							<Code block style={{ whiteSpace: "pre-wrap" }}>
								{displayedResult}
							</Code>
						</ScrollArea.Autosize>
					</Stack>
				)}

				{(testMut.isSuccess || testMut.isError) && requestUrls.length > 0 && (
					<Stack gap="xs">
						<Text size="sm" fw={500}>
							{t("modelTestRequestUrls")}
						</Text>
						<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
							{requestUrls.map((r) => `${r.method} ${r.url}`).join("\n")}
						</Code>
					</Stack>
				)}
			</Stack>
		</Modal>
	);
}
