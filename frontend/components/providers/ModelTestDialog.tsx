import {
	Alert,
	Badge,
	Button,
	Code,
	Group,
	Modal,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/api/client";
import type {
	ModelTestDiagnostics,
	ModelTestErrorDetails,
	ModelTestNetworkErrorCategory,
	ModelTestRequestAttempt,
} from "../../lib/api/settings";
import { CopyButton } from "../common/CopyButton";

interface ModelTestDialogProps {
	opened: boolean;
	onClose: () => void;
	/** Concrete model reference sent to the diagnostic endpoint. */
	modelValue: string;
	/** Original narrator selection (for example an aggregation reference). */
	selectedModelValue?: string;
	sourceError?: string;
}

interface RequestUrl {
	url: string;
	method: string;
}

const DEFAULT_PROMPT = "Please introduce yourself in one sentence. / 请用一句话介绍你自己。";
const MAX_MODEL_TEST_RESULT_CHARS = 60_000;

/** Extract captured request URLs from a failed test (legacy error response body). */
function requestUrlsFromError(error: unknown): RequestUrl[] {
	if (error instanceof ApiError) {
		const urls = error.data?.requestUrls;
		if (Array.isArray(urls)) return urls as RequestUrl[];
	}
	return [];
}

function diagnosticsFromError(error: unknown): ModelTestDiagnostics | undefined {
	if (!(error instanceof ApiError)) return undefined;
	const diagnostics = error.data?.diagnostics;
	if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
		return undefined;
	}
	const candidate = diagnostics as Partial<ModelTestDiagnostics>;
	if (typeof candidate.id !== "string" || !Array.isArray(candidate.requests)) return undefined;
	return diagnostics as ModelTestDiagnostics;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatBytes(value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function outcomeColor(outcome: ModelTestRequestAttempt["outcome"]): string {
	switch (outcome) {
		case "success":
			return "green";
		case "http_error":
			return "orange";
		case "aborted":
			return "gray";
		default:
			return "red";
	}
}

function categoryKey(category: ModelTestNetworkErrorCategory): string {
	return `modelTestErrorCategory_${category}`;
}

function hintKey(category: ModelTestNetworkErrorCategory): string {
	return `modelTestHint_${category}`;
}

function primaryCategory(
	diagnostics: ModelTestDiagnostics,
): ModelTestNetworkErrorCategory | undefined {
	return (
		diagnostics.error?.category ??
		diagnostics.requests.find((request) => request.category)?.category
	);
}

function errorLines(error: ModelTestErrorDetails): string[] {
	const lines: string[] = [error.message];
	for (const [label, value] of [
		["code", error.code],
		["errno", error.errno],
		["status", error.status],
		["reason", error.reason],
		["syscall", error.syscall],
		["hostname", error.hostname],
		["address", error.address],
		["port", error.port],
		["path", error.path],
	] as const) {
		if (value !== undefined && value !== "") lines.push(`${label}: ${value}`);
	}
	return lines;
}

function ErrorDetailsView({
	error,
	t,
	depth = 0,
}: {
	error: ModelTestErrorDetails;
	t: TFunction;
	depth?: number;
}) {
	return (
		<Paper withBorder p="sm" bg={depth > 0 ? "var(--mantine-color-dark-7)" : undefined}>
			<Stack gap="xs">
				<Group gap="xs">
					<Text size="sm" fw={500}>
						{depth > 0 ? t("modelTestCause") : t("modelTestErrorDetails")}
					</Text>
					{error.category && (
						<Badge size="sm" color="red" variant="light">
							{t(categoryKey(error.category))}
						</Badge>
					)}
					{error.name && (
						<Badge size="sm" color="gray" variant="light">
							{error.name}
						</Badge>
					)}
				</Group>
				<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
					{errorLines(error).join("\n")}
				</Code>
				{error.cause && depth < 3 && (
					<ErrorDetailsView error={error.cause} t={t} depth={depth + 1} />
				)}
			</Stack>
		</Paper>
	);
}

function RequestAttemptView({ attempt, t }: { attempt: ModelTestRequestAttempt; t: TFunction }) {
	const bodySize = formatBytes(attempt.requestBodyBytes);
	return (
		<Paper withBorder p="sm">
			<Stack gap="xs">
				<Group justify="space-between" align="flex-start" wrap="wrap">
					<Group gap="xs">
						<Text size="sm" fw={600}>
							{t("modelTestAttempt", { index: attempt.sequence })}
						</Text>
						<Badge size="sm" variant="light">
							{attempt.method}
						</Badge>
						{attempt.verbose && (
							<Badge size="sm" color="yellow" variant="light">
								{t("modelTestVerboseBadge")}
							</Badge>
						)}
						{attempt.outcome && (
							<Badge size="sm" color={outcomeColor(attempt.outcome)} variant="light">
								{t(`modelTestOutcome_${attempt.outcome}`)}
							</Badge>
						)}
						{attempt.status !== undefined && (
							<Badge size="sm" color={attempt.status >= 400 ? "orange" : "green"} variant="light">
								HTTP {attempt.status}
							</Badge>
						)}
					</Group>
					{attempt.durationMs !== undefined && (
						<Text size="xs" c="dimmed">
							{attempt.durationMs} ms
						</Text>
					)}
				</Group>
				<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
					{attempt.url}
				</Code>
				<Group gap="md" wrap="wrap">
					<Text size="xs" c="dimmed">
						{t("modelTestRoute")}: {t(`modelTestRoute_${attempt.route ?? "direct"}`)}
					</Text>
					{bodySize && (
						<Text size="xs" c="dimmed">
							{t("modelTestRequestBodySize")}: {bodySize}
						</Text>
					)}
					{attempt.category && (
						<Text size="xs" c="dimmed">
							{t("modelTestErrorCategory")}: {t(categoryKey(attempt.category))}
						</Text>
					)}
				</Group>
				{attempt.proxyUrl && (
					<Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
						{t("modelTestProxy")}: {attempt.proxyUrl}
					</Text>
				)}
				{attempt.responseHeaders && Object.keys(attempt.responseHeaders).length > 0 && (
					<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
						{Object.entries(attempt.responseHeaders)
							.map(([key, value]) => `${key}: ${value}`)
							.join("\n")}
					</Code>
				)}
				{attempt.error && <ErrorDetailsView error={attempt.error} t={t} />}
			</Stack>
		</Paper>
	);
}

export function formatModelTestDiagnosticReport(options: {
	model: string;
	selectedModel?: string;
	error?: string;
	sourceError?: string;
	diagnostics?: ModelTestDiagnostics;
	requestUrls?: RequestUrl[];
}): string {
	return JSON.stringify(
		{
			model: options.model,
			selectedModel: options.selectedModel ?? options.model,
			testModel: options.model,
			sourceError: options.sourceError,
			error: options.error,
			diagnostics: options.diagnostics,
			requestUrls: options.diagnostics ? undefined : options.requestUrls,
		},
		null,
		2,
	);
}

export function ModelTestDialog({
	opened,
	onClose,
	modelValue,
	selectedModelValue,
	sourceError,
}: ModelTestDialogProps) {
	const { t } = useTranslation("settings");
	const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
	const selectedDisplayModel = selectedModelValue ?? modelValue;

	const testMut = useMutation({
		mutationFn: () => api.testModel(modelValue, prompt),
	});
	const displayedResult =
		testMut.data?.text && testMut.data.text.length > MAX_MODEL_TEST_RESULT_CHARS
			? testMut.data.text.slice(0, MAX_MODEL_TEST_RESULT_CHARS)
			: testMut.data?.text;
	const resultTruncated = !!testMut.data?.text && displayedResult !== testMut.data.text;
	const displayedError = testMut.isError ? errorMessage(testMut.error) : undefined;
	const diagnostics = testMut.isSuccess
		? testMut.data?.diagnostics
		: diagnosticsFromError(testMut.error);
	const category = diagnostics ? primaryCategory(diagnostics) : undefined;

	// Actual request URLs: from success payload, or from the legacy error body on failure.
	const requestUrls: RequestUrl[] = testMut.isSuccess
		? (testMut.data?.requestUrls ?? [])
		: requestUrlsFromError(testMut.error);
	const diagnosticReport = formatModelTestDiagnosticReport({
		model: modelValue,
		selectedModel: selectedModelValue,
		sourceError,
		error: displayedError,
		diagnostics,
		requestUrls,
	});

	const handleTest = () => {
		testMut.mutate();
	};

	const handleClose = () => {
		testMut.reset();
		onClose();
	};

	return (
		<Modal opened={opened} onClose={handleClose} title={t("modelTestTitle")} size="xl">
			<Stack gap="md">
				<Group gap="xs">
					<Text size="sm" c="dimmed">
						{t("modelTestSelectedModel")}:
					</Text>
					<Code>{selectedDisplayModel}</Code>
				</Group>
				{selectedDisplayModel !== modelValue && (
					<Group gap="xs">
						<Text size="sm" c="dimmed">
							{t("modelTestResolvedMember")}:
						</Text>
						<Code>{modelValue}</Code>
					</Group>
				)}

				{sourceError && (
					<Alert color="orange" title={t("modelTestSourceError")}>
						<Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
							{sourceError}
						</Text>
					</Alert>
				)}

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
					<Alert color="red" title={t("modelTestFailed")}>
						<Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
							{displayedError}
						</Text>
					</Alert>
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

				{(testMut.isSuccess || testMut.isError) && diagnostics && (
					<Stack gap="sm">
						<Group justify="space-between" align="center" wrap="wrap">
							<Text size="sm" fw={600}>
								{t("modelTestDiagnostics")}
							</Text>
							<CopyButton value={diagnosticReport} timeout={1500}>
								{({ copied, copy }) => (
									<Button size="xs" variant="light" onClick={copy}>
										{copied ? t("modelTestCopied") : t("modelTestCopyDiagnostics")}
									</Button>
								)}
							</CopyButton>
						</Group>

						{diagnostics.verbose?.enabled && (
							<Alert color="yellow" title={t("modelTestVerboseEnabled")}>
								{t("modelTestVerboseWarning")}
							</Alert>
						)}

						<Paper withBorder p="sm">
							<Group gap="lg" wrap="wrap">
								<Text size="xs">
									<strong>{t("modelTestDiagnosticId")}:</strong> {diagnostics.id}
								</Text>
								<Text size="xs">
									<strong>{t("modelTestResolvedMember")}:</strong> {diagnostics.resolvedProvider} /{" "}
									{diagnostics.resolvedModel}
								</Text>
								<Text size="xs">
									<strong>{t("modelTestTimestamp")}:</strong> {diagnostics.createdAt}
								</Text>
								<Text size="xs">
									<strong>{t("modelTestTotalDuration")}:</strong> {diagnostics.durationMs} ms
								</Text>
								<Text size="xs">
									<strong>{t("modelTestRuntime")}:</strong> {diagnostics.runtime.name}{" "}
									{diagnostics.runtime.version} / {diagnostics.runtime.platform}-
									{diagnostics.runtime.arch}
								</Text>
							</Group>
						</Paper>

						{category && (
							<Alert color="blue" title={t(categoryKey(category))}>
								{t(hintKey(category))}
							</Alert>
						)}

						{diagnostics.error && <ErrorDetailsView error={diagnostics.error} t={t} />}

						{diagnostics.requests.length > 0 && (
							<Stack gap="xs">
								<Text size="sm" fw={500}>
									{t("modelTestRequestAttempts")}
								</Text>
								<ScrollArea.Autosize mah={500}>
									<Stack gap="xs">
										{diagnostics.requests.map((attempt) => (
											<RequestAttemptView key={attempt.sequence} attempt={attempt} t={t} />
										))}
									</Stack>
								</ScrollArea.Autosize>
							</Stack>
						)}
					</Stack>
				)}

				{(testMut.isSuccess || testMut.isError) && !diagnostics && requestUrls.length > 0 && (
					<Stack gap="xs">
						<Text size="sm" fw={500}>
							{t("modelTestRequestUrls")}
						</Text>
						<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
							{requestUrls.map((request) => `${request.method} ${request.url}`).join("\n")}
						</Code>
					</Stack>
				)}
			</Stack>
		</Modal>
	);
}
