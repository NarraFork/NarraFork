import {
	Alert,
	Button,
	Group,
	NativeSelect,
	Paper,
	Stack,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { api } from "../../lib/api";

type TaskInput = Parameters<typeof api.createBackgroundTask>[1];
type BrowserInput = Parameters<typeof api.createBrowserSession>[1];
const MIN_BROWSER_TTL_MS = 1_000;
const MAX_RESOURCE_DURATION_MS = 86_400_000;

function parseOptionalDuration(value: string, min: number, max: number): number | undefined | null {
	const raw = value.trim();
	if (!raw) return undefined;
	const ms = Number(raw);
	return /^\d+$/.test(raw) && Number.isSafeInteger(ms) && ms >= min && ms <= max ? ms : null;
}

function isHttpUrl(raw: string): boolean {
	if (!/^https?:\/\//i.test(raw)) return false;
	try {
		const url = new URL(raw);
		return Boolean(url.hostname) && !url.username && !url.password;
	} catch {
		return false;
	}
}

/** A ref blocks a second submit even before React commits the pending UI. */
function useManualCreation() {
	const submitting = useRef(false);
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<{ message?: string } | null>(null);

	async function submit(run: () => Promise<unknown>, onSuccess: () => void) {
		if (submitting.current) return;
		submitting.current = true;
		setPending(true);
		setFailure(null);
		try {
			await run();
		} catch (error) {
			setFailure({ message: error instanceof Error ? error.message : undefined });
			return;
		} finally {
			submitting.current = false;
			setPending(false);
		}
		onSuccess();
	}

	return { submit, pending, failure, clearFailure: () => setFailure(null) };
}

function CreationForm({
	label,
	failureTitle,
	pending,
	failure,
	onSubmit,
	onClose,
	children,
}: {
	label: string;
	failureTitle: string;
	pending: boolean;
	failure: { message?: string } | null;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	onClose: () => void;
	children: ReactNode;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Paper withBorder p="xs" radius="sm">
			<form noValidate aria-label={label} aria-busy={pending} onSubmit={onSubmit}>
				<fieldset disabled={pending} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
					<Stack gap="xs">
						{children}
						{failure && (
							<Alert color="red" title={failureTitle} style={{ overflowWrap: "anywhere" }}>
								{failure.message || t("manualResources.tryAgain")}
							</Alert>
						)}
						<Group justify="flex-end" gap="xs">
							<Button type="button" variant="subtle" size="xs" onClick={onClose}>
								{t("cancel")}
							</Button>
							<Button type="submit" size="xs" loading={pending}>
								{label}
							</Button>
						</Group>
					</Stack>
				</fieldset>
			</form>
		</Paper>
	);
}

export function CreateBackgroundTaskForm({
	create,
}: {
	create: (data: TaskInput) => Promise<unknown>;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const [kind, setKind] = useState<TaskInput["kind"]>("task");
	const [command, setCommand] = useState("");
	const [title, setTitle] = useState("");
	const [timeout, setTimeoutValue] = useState("");
	const [validated, setValidated] = useState(false);
	const { submit, pending, failure, clearFailure } = useManualCreation();
	const timeoutMs = parseOptionalDuration(timeout, 1, MAX_RESOURCE_DURATION_MS);
	const label = t("manualResources.newTask");
	const close = () => {
		setOpened(false);
		setValidated(false);
		clearFailure();
	};

	if (!opened) {
		return (
			<Group>
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlus size={14} />}
					onClick={() => setOpened(true)}
				>
					{label}
				</Button>
			</Group>
		);
	}

	return (
		<CreationForm
			label={label}
			failureTitle={t("manualResources.taskFailed")}
			pending={pending}
			failure={failure}
			onClose={close}
			onSubmit={(event) => {
				event.preventDefault();
				setValidated(true);
				if (!command.trim() || timeoutMs === null) return;
				const trimmedTitle = title.trim();
				void submit(
					() => create({ kind, command, title: trimmedTitle || undefined, timeoutMs }),
					() => {
						setKind("task");
						setCommand("");
						setTitle("");
						setTimeoutValue("");
						close();
					},
				);
			}}
		>
			<NativeSelect
				size="xs"
				label={t("manualResources.kind")}
				data={[
					{ value: "task", label: t("backgroundTasks.kindTask") },
					{ value: "service", label: t("backgroundTasks.kindService") },
				]}
				value={kind}
				onChange={(event) => setKind(event.currentTarget.value === "service" ? "service" : "task")}
			/>
			<Textarea
				size="xs"
				label={t("manualResources.command")}
				description={t("manualResources.commandDirectory")}
				maxLength={8_192}
				required
				styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
				value={command}
				onChange={(event) => setCommand(event.currentTarget.value)}
				error={validated && !command.trim() && t("manualResources.commandRequired")}
			/>
			<TextInput
				size="xs"
				label={t("manualResources.taskTitle")}
				maxLength={120}
				value={title}
				onChange={(event) => setTitle(event.currentTarget.value)}
			/>
			<TextInput
				size="xs"
				inputMode="numeric"
				label={t("manualResources.timeout")}
				description={t("manualResources.useDefault")}
				value={timeout}
				onChange={(event) => setTimeoutValue(event.currentTarget.value)}
				error={validated && timeoutMs === null && t("manualResources.timeoutInvalid")}
			/>
		</CreationForm>
	);
}

export function CreateBrowserSessionForm({
	create,
}: {
	create: (data: BrowserInput) => Promise<unknown>;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const [url, setUrl] = useState("");
	const [ttl, setTtl] = useState("");
	const [validated, setValidated] = useState(false);
	const { submit, pending, failure, clearFailure } = useManualCreation();
	const ttlMs = parseOptionalDuration(ttl, MIN_BROWSER_TTL_MS, MAX_RESOURCE_DURATION_MS);
	const validUrl = isHttpUrl(url.trim());
	const label = t("manualResources.newBrowser");
	const close = () => {
		setOpened(false);
		setValidated(false);
		clearFailure();
	};

	if (!opened) {
		return (
			<Group>
				<Button
					size="xs"
					variant="light"
					color="teal"
					leftSection={<IconPlus size={14} />}
					onClick={() => setOpened(true)}
				>
					{label}
				</Button>
			</Group>
		);
	}

	return (
		<CreationForm
			label={label}
			failureTitle={t("manualResources.browserFailed")}
			pending={pending}
			failure={failure}
			onClose={close}
			onSubmit={(event) => {
				event.preventDefault();
				setValidated(true);
				if (!validUrl || ttlMs === null) return;
				void submit(
					() => create({ url: url.trim(), ttlMs }),
					() => {
						setUrl("");
						setTtl("");
						close();
					},
				);
			}}
		>
			<TextInput
				size="xs"
				type="url"
				label={t("manualResources.browserUrl")}
				description={t("manualResources.managedHeadless")}
				placeholder="https://example.com/"
				maxLength={4_096}
				required
				value={url}
				onChange={(event) => setUrl(event.currentTarget.value)}
				error={validated && !validUrl && t("manualResources.urlInvalid")}
			/>
			<TextInput
				size="xs"
				inputMode="numeric"
				label={t("manualResources.browserTtl")}
				description={t("manualResources.useDefault")}
				value={ttl}
				onChange={(event) => setTtl(event.currentTarget.value)}
				error={validated && ttlMs === null && t("manualResources.ttlInvalid")}
			/>
		</CreationForm>
	);
}
