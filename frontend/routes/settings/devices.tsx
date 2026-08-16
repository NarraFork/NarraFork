import {
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Checkbox,
	Code,
	Divider,
	Group,
	Loader,
	Modal,
	Progress,
	Select,
	SimpleGrid,
	Stack,
	Stepper,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { CopyButton } from "../../components/common/CopyButton";
import { ExecutorInstallModal } from "../../components/settings/ExecutorInstallModal";
import { api } from "../../lib/api";
import type {
	CreateDeviceInput,
	DeviceConnectionDiagnostics,
	DeviceTransferTask,
	RemoteDevice,
	TestConnectionResult,
	UpdateDeviceInput,
} from "../../lib/api/devices";
import {
	buildDeviceRunCommand,
	isValidOptionalDeviceSlug,
	isWebSocketUrl,
} from "../../lib/device-config";
import { formatLocaleDateTime } from "../../lib/intl-format";

export const Route = createFileRoute("/settings/devices")({
	component: SettingsDevicesPage,
});

interface ProjectOption {
	id: string;
	name: string;
	status?: string;
}

interface IssuedToken {
	device: RemoteDevice;
	token: string;
}

function SettingsDevicesPage() {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const confirm = useConfirmDialog();
	const [createOpen, setCreateOpen] = useState(false);
	const [editingDevice, setEditingDevice] = useState<RemoteDevice | null>(null);
	const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);
	const [transferDevice, setTransferDevice] = useState<RemoteDevice | null>(null);
	const [diagnosticDevice, setDiagnosticDevice] = useState<RemoteDevice | null>(null);
	const [installDevice, setInstallDevice] = useState<RemoteDevice | null>(null);
	const [testResults, setTestResults] = useState<Record<string, TestConnectionResult>>({});

	const { data: devices, isLoading } = useQuery({
		queryKey: ["devices"],
		queryFn: () => api.listDevices(),
		refetchInterval: 10_000,
	});
	// Drives the "up to date / upgrade available" badge on each device card.
	const { data: executorInfo } = useQuery({
		queryKey: ["executorManifest"],
		queryFn: () => api.getExecutorManifest(),
		staleTime: 5 * 60_000,
	});
	const { data: projectRows } = useQuery({
		queryKey: ["projects", "device-scope"],
		queryFn: () => api.listProjects(),
	});
	const projects = (projectRows ?? []) as ProjectOption[];
	const projectNames = useMemo(
		() => new Map(projects.map((project) => [project.id, project.name])),
		[projects],
	);

	const createMut = useMutation({
		mutationFn: (input: CreateDeviceInput) => api.createDevice(input),
		onSuccess: (res) => {
			qc.invalidateQueries({ queryKey: ["devices"] });
			setCreateOpen(false);
			setIssuedToken({ device: res.device, token: res.token });
		},
		onError: showError,
	});
	const updateMut = useMutation({
		mutationFn: ({ id, input }: { id: string; input: UpdateDeviceInput }) =>
			api.updateDevice(id, input),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["devices"] });
			setEditingDevice(null);
			notifications.show({ color: "green", message: t("deviceUpdateDone") });
		},
		onError: showError,
	});
	const rotateMut = useMutation({
		mutationFn: (id: string) => api.rotateDeviceToken(id),
		onSuccess: (res, id) => {
			const device = devices?.find((candidate) => candidate.id === id);
			if (device) setIssuedToken({ device, token: res.token });
		},
		onError: showError,
	});
	const deleteMut = useMutation({
		mutationFn: (id: string) => api.deleteDevice(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
		onError: showError,
	});
	const testMut = useMutation({
		mutationFn: (id: string) => api.testDevice(id),
		onSuccess: (result, id) => {
			setTestResults((current) => ({ ...current, [id]: result }));
			qc.invalidateQueries({ queryKey: ["deviceDiagnostics", id] });
			qc.invalidateQueries({ queryKey: ["devices"] });
		},
		onError: showError,
	});

	const openAndTest = (device: RemoteDevice) => {
		setDiagnosticDevice(device);
		testMut.mutate(device.id);
	};

	return (
		<Box maw={980}>
			<Group justify="space-between" mb="md">
				<Title order={3}>{t("devicesSection")}</Title>
				<Button onClick={() => setCreateOpen(true)}>{t("deviceAddButton")}</Button>
			</Group>

			<Text c="dimmed" size="sm" mb="lg">
				{t("devicesDescription")}
			</Text>

			{isLoading ? (
				<Loader />
			) : !devices || devices.length === 0 ? (
				<Alert color="gray">{t("devicesEmpty")}</Alert>
			) : (
				<Stack>
					{devices.map((device) => (
						<DeviceCard
							key={device.id}
							device={device}
							projectName={device.projectId ? projectNames.get(device.projectId) : undefined}
							testResult={testResults[device.id]}
							testing={testMut.isPending && testMut.variables === device.id}
							latestExecutorVersion={executorInfo?.manifest?.version}
							onTest={() => openAndTest(device)}
							onDiagnostics={() => setDiagnosticDevice(device)}
							onEdit={() => setEditingDevice(device)}
							onTransfer={() => setTransferDevice(device)}
							onInstall={() => setInstallDevice(device)}
							onRotate={() => rotateMut.mutate(device.id)}
							onDelete={async () => {
								const ok = await confirm({
									title: t("deviceDeleteConfirmTitle"),
									message: t("deviceDeleteConfirmMessage", { name: device.name }),
									confirmLabel: t("deviceDeleteButton"),
									confirmColor: "red",
								});
								if (ok) deleteMut.mutate(device.id);
							}}
						/>
					))}
				</Stack>
			)}

			<CreateDeviceWizard
				opened={createOpen}
				onClose={() => setCreateOpen(false)}
				onSubmit={(input) => createMut.mutate(input)}
				loading={createMut.isPending}
				projects={projects}
			/>
			<EditDeviceModal
				device={editingDevice}
				onClose={() => setEditingDevice(null)}
				onSubmit={(input) => {
					if (editingDevice) updateMut.mutate({ id: editingDevice.id, input });
				}}
				loading={updateMut.isPending}
				projects={projects}
			/>
			<TokenModal
				issued={issuedToken}
				onInstall={() => {
					if (!issuedToken) return;
					const device = issuedToken.device;
					setIssuedToken(null);
					setInstallDevice(device);
				}}
				onClose={() => setIssuedToken(null)}
			/>
			<ExecutorInstallModal device={installDevice} onClose={() => setInstallDevice(null)} />
			<TransferModal device={transferDevice} onClose={() => setTransferDevice(null)} />
			<DeviceDiagnosticsModal
				device={diagnosticDevice}
				testResult={diagnosticDevice ? testResults[diagnosticDevice.id] : undefined}
				testing={testMut.isPending && testMut.variables === diagnosticDevice?.id}
				onTest={() => {
					if (diagnosticDevice) testMut.mutate(diagnosticDevice.id);
				}}
				onClose={() => setDiagnosticDevice(null)}
			/>
		</Box>
	);
}

function showError(error: unknown) {
	notifications.show({
		color: "red",
		message: error instanceof Error ? error.message : String(error),
	});
}

function DeviceCard({
	device,
	projectName,
	testResult,
	testing,
	latestExecutorVersion,
	onTest,
	onDiagnostics,
	onEdit,
	onRotate,
	onDelete,
	onTransfer,
	onInstall,
}: {
	device: RemoteDevice;
	projectName?: string;
	testResult?: TestConnectionResult;
	testing: boolean;
	latestExecutorVersion?: string;
	onTest: () => void;
	onDiagnostics: () => void;
	onEdit: () => void;
	onRotate: () => void;
	onDelete: () => void;
	onTransfer: () => void;
	onInstall: () => void;
}) {
	const { t } = useTranslation("settings");
	const platform =
		device.platformOs && device.platformArch ? `${device.platformOs}/${device.platformArch}` : "—";
	const scopeLabel =
		device.scope === "project"
			? t("deviceScopeProjectValue", { project: projectName ?? device.projectId ?? "—" })
			: t("deviceScopeGlobal");
	return (
		<Card withBorder padding="md">
			<Stack gap="sm">
				<Group justify="space-between" align="flex-start" wrap="wrap">
					<Stack gap={4} style={{ minWidth: 0 }}>
						<Group gap="xs" wrap="wrap">
							<Text fw={600}>{device.name}</Text>
							<Badge color={device.status === "online" ? "green" : "gray"} variant="light">
								{device.status === "online" ? t("deviceOnline") : t("deviceOffline")}
							</Badge>
							<Badge variant="outline">
								{device.connectionMode === "direct"
									? t("deviceModeDirectShort")
									: t("deviceModeReverseShort")}
							</Badge>
							<Badge color={device.scope === "project" ? "violet" : "blue"} variant="outline">
								{scopeLabel}
							</Badge>
							{executorVersionBadge(t, device.agentVersion, latestExecutorVersion)}
						</Group>
						{device.description ? (
							<Text size="sm" c="dimmed">
								{device.description}
							</Text>
						) : null}
						<Text size="xs" c="dimmed">
							<Code>{device.slug}</Code> · {platform} · {t("deviceTokenPrefix")}:{" "}
							{device.tokenPrefix}…
						</Text>
						{device.defaultCwd ? (
							<Text size="xs" c="dimmed">
								{t("deviceDefaultCwd")}: <Code>{device.defaultCwd}</Code>
							</Text>
						) : null}
						{device.connectionMode === "direct" && device.directUrl ? (
							<Text size="xs" c="dimmed">
								{t("deviceDirectUrlLabel")}: <Code>{device.directUrl}</Code>
							</Text>
						) : null}
						<Text size="xs" c="dimmed">
							{t("deviceLastSeen")}: {formatDateTime(device.lastSeenAt, t("deviceNeverSeen"))}
							{device.agentVersion ? ` · ${t("deviceAgentVersion")}: ${device.agentVersion}` : ""}
						</Text>
					</Stack>
					<Group gap="xs" justify="flex-end">
						<Button size="xs" variant="light" loading={testing} onClick={onTest}>
							{t("deviceTestButton")}
						</Button>
						<Button size="xs" variant="subtle" onClick={onDiagnostics}>
							{t("deviceDiagnosticsButton")}
						</Button>
						{device.status === "online" ? (
							<Button size="xs" variant="subtle" onClick={onTransfer}>
								{t("deviceTransferButton")}
							</Button>
						) : null}
						<Button size="xs" variant="subtle" onClick={onInstall}>
							{t("executorInstallButton")}
						</Button>
						<Button size="xs" variant="subtle" onClick={onEdit}>
							{t("deviceEditButton")}
						</Button>
						<Button size="xs" variant="subtle" onClick={onRotate}>
							{t("deviceRotateButton")}
						</Button>
						<Button size="xs" variant="subtle" color="red" onClick={onDelete}>
							{t("deviceDeleteButton")}
						</Button>
					</Group>
				</Group>
				{testResult ? (
					<Alert color={testResult.ok ? "green" : "red"} variant="light" py="xs">
						<Text size="xs">
							{testResult.ok ? t("deviceTestPassed") : t("deviceTestFailed")} ·{" "}
							{diagnosticStageLabel(t, testResult.stage)}
							{testResult.latencyMs !== undefined ? ` · ${testResult.latencyMs} ms` : ""}
							{testResult.message ? ` · ${testResult.message}` : ""}
						</Text>
					</Alert>
				) : null}
			</Stack>
		</Card>
	);
}

function CreateDeviceWizard({
	opened,
	onClose,
	onSubmit,
	loading,
	projects,
}: {
	opened: boolean;
	onClose: () => void;
	onSubmit: (input: CreateDeviceInput) => void;
	loading: boolean;
	projects: ProjectOption[];
}) {
	const { t } = useTranslation("settings");
	const [step, setStep] = useState(0);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");
	const [mode, setMode] = useState<"reverse" | "direct">("reverse");
	const [directUrl, setDirectUrl] = useState("");
	const [scope, setScope] = useState<"global" | "project">("global");
	const [projectId, setProjectId] = useState<string | null>(null);

	useEffect(() => {
		if (!opened) return;
		setStep(0);
		setName("");
		setSlug("");
		setDescription("");
		setMode("reverse");
		setDirectUrl("");
		setScope("global");
		setProjectId(null);
	}, [opened]);

	const projectOptions = projectSelectOptions(projects, t);
	const canContinue =
		(step === 0 && !!name.trim() && isValidOptionalDeviceSlug(slug)) ||
		(step === 1 && (mode === "reverse" || isWebSocketUrl(directUrl))) ||
		(step === 2 && (scope === "global" || !!projectId));

	return (
		<Modal opened={opened} onClose={onClose} title={t("deviceWizardTitle")} size="lg">
			<Stack>
				<Stepper active={step} onStepClick={(next) => next < step && setStep(next)} size="sm">
					<Stepper.Step label={t("deviceWizardDetailsStep")}>
						<Stack mt="md">
							<TextInput
								label={t("deviceNameLabel")}
								value={name}
								onChange={(event) => setName(event.currentTarget.value)}
								required
								autoFocus
							/>
							<TextInput
								label={t("deviceSlugLabel")}
								description={t("deviceSlugDescription")}
								placeholder={t("deviceSlugPlaceholder")}
								value={slug}
								onChange={(event) => setSlug(event.currentTarget.value.toLowerCase())}
								error={slug && !isValidOptionalDeviceSlug(slug) ? t("deviceSlugInvalid") : null}
							/>
							<Textarea
								label={t("deviceDescriptionLabel")}
								value={description}
								onChange={(event) => setDescription(event.currentTarget.value)}
								autosize
								minRows={2}
							/>
						</Stack>
					</Stepper.Step>
					<Stepper.Step label={t("deviceWizardConnectionStep")}>
						<Stack mt="md">
							<Select
								label={t("deviceModeLabel")}
								data={[
									{ value: "reverse", label: t("deviceModeReverse") },
									{ value: "direct", label: t("deviceModeDirect") },
								]}
								value={mode}
								onChange={(value) => setMode((value as "reverse" | "direct") ?? "reverse")}
							/>
							<Alert color="blue" variant="light">
								<Text size="sm">
									{mode === "reverse"
										? t("deviceModeReverseDescription")
										: t("deviceModeDirectDescription")}
								</Text>
							</Alert>
							{mode === "direct" ? (
								<TextInput
									label={t("deviceDirectUrlLabel")}
									description={t("deviceDirectUrlDescription")}
									placeholder="wss://executor.example.com:7900/ws/device"
									value={directUrl}
									onChange={(event) => setDirectUrl(event.currentTarget.value)}
									error={
										directUrl && !isWebSocketUrl(directUrl) ? t("deviceDirectUrlInvalid") : null
									}
									required
								/>
							) : null}
						</Stack>
					</Stepper.Step>
					<Stepper.Step label={t("deviceWizardScopeStep")}>
						<Stack mt="md">
							<Select
								label={t("deviceScopeLabel")}
								data={[
									{ value: "global", label: t("deviceScopeGlobal") },
									{ value: "project", label: t("deviceScopeProject") },
								]}
								value={scope}
								onChange={(value) => {
									const next = (value as "global" | "project") ?? "global";
									setScope(next);
									if (next === "global") setProjectId(null);
								}}
							/>
							<Text size="sm" c="dimmed">
								{scope === "global"
									? t("deviceScopeGlobalDescription")
									: t("deviceScopeProjectDescription")}
							</Text>
							{scope === "project" ? (
								<Select
									label={t("deviceProjectLabel")}
									placeholder={t("deviceProjectPlaceholder")}
									data={projectOptions}
									value={projectId}
									onChange={setProjectId}
									searchable
									nothingFoundMessage={t("deviceProjectNone")}
									required
								/>
							) : null}
							<Divider />
							<Text fw={600} size="sm">
								{t("deviceWizardReview")}
							</Text>
							<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
								<ReviewField label={t("deviceNameLabel")} value={name.trim()} />
								<ReviewField
									label={t("deviceModeLabel")}
									value={
										mode === "direct" ? t("deviceModeDirectShort") : t("deviceModeReverseShort")
									}
								/>
								<ReviewField
									label={t("deviceScopeLabel")}
									value={
										scope === "global"
											? t("deviceScopeGlobal")
											: (projectOptions.find((project) => project.value === projectId)?.label ??
												"—")
									}
								/>
								{mode === "direct" ? (
									<ReviewField label={t("deviceDirectUrlLabel")} value={directUrl.trim()} />
								) : null}
							</SimpleGrid>
						</Stack>
					</Stepper.Step>
				</Stepper>
				<Group justify="space-between">
					<Button
						variant="default"
						onClick={step === 0 ? onClose : () => setStep((value) => value - 1)}
					>
						{step === 0 ? t("cancel") : t("deviceWizardBack")}
					</Button>
					{step < 2 ? (
						<Button disabled={!canContinue} onClick={() => setStep((value) => value + 1)}>
							{t("deviceWizardNext")}
						</Button>
					) : (
						<Button
							loading={loading}
							disabled={!canContinue}
							onClick={() =>
								onSubmit({
									name: name.trim(),
									slug: slug.trim() || undefined,
									description: description.trim() || undefined,
									connectionMode: mode,
									directUrl: mode === "direct" ? directUrl.trim() : undefined,
									scope,
									projectId: scope === "project" ? (projectId ?? undefined) : undefined,
								})
							}
						>
							{t("deviceCreateSubmit")}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}

function EditDeviceModal({
	device,
	onClose,
	onSubmit,
	loading,
	projects,
}: {
	device: RemoteDevice | null;
	onClose: () => void;
	onSubmit: (input: UpdateDeviceInput) => void;
	loading: boolean;
	projects: ProjectOption[];
}) {
	const { t } = useTranslation("settings");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [mode, setMode] = useState<"reverse" | "direct">("reverse");
	const [directUrl, setDirectUrl] = useState("");
	const [scope, setScope] = useState<"global" | "project">("global");
	const [projectId, setProjectId] = useState<string | null>(null);

	useEffect(() => {
		if (!device) return;
		setName(device.name);
		setDescription(device.description ?? "");
		setMode(device.connectionMode);
		setDirectUrl(device.directUrl ?? "");
		setScope(device.scope);
		setProjectId(device.projectId);
	}, [device]);

	const valid =
		!!name.trim() &&
		(mode === "reverse" || isWebSocketUrl(directUrl)) &&
		(scope === "global" || !!projectId);

	return (
		<Modal opened={!!device} onClose={onClose} title={t("deviceEditTitle")} size="lg">
			<Stack>
				<TextInput
					label={t("deviceNameLabel")}
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					required
				/>
				<Textarea
					label={t("deviceDescriptionLabel")}
					value={description}
					onChange={(event) => setDescription(event.currentTarget.value)}
					autosize
					minRows={2}
				/>
				<Select
					label={t("deviceModeLabel")}
					data={[
						{ value: "reverse", label: t("deviceModeReverse") },
						{ value: "direct", label: t("deviceModeDirect") },
					]}
					value={mode}
					onChange={(value) => setMode((value as "reverse" | "direct") ?? "reverse")}
				/>
				{mode === "direct" ? (
					<TextInput
						label={t("deviceDirectUrlLabel")}
						value={directUrl}
						onChange={(event) => setDirectUrl(event.currentTarget.value)}
						error={directUrl && !isWebSocketUrl(directUrl) ? t("deviceDirectUrlInvalid") : null}
						required
					/>
				) : null}
				<Select
					label={t("deviceScopeLabel")}
					data={[
						{ value: "global", label: t("deviceScopeGlobal") },
						{ value: "project", label: t("deviceScopeProject") },
					]}
					value={scope}
					onChange={(value) => {
						const next = (value as "global" | "project") ?? "global";
						setScope(next);
						if (next === "global") setProjectId(null);
					}}
				/>
				{scope === "project" ? (
					<Select
						label={t("deviceProjectLabel")}
						data={projectSelectOptions(projects, t)}
						value={projectId}
						onChange={setProjectId}
						searchable
						nothingFoundMessage={t("deviceProjectNone")}
						required
					/>
				) : null}
				<Alert color="blue" variant="light">
					<Text size="sm">{t("deviceEditReconnectHint")}</Text>
				</Alert>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button
						loading={loading}
						disabled={!valid}
						onClick={() =>
							onSubmit({
								name: name.trim(),
								description: description.trim() || null,
								connectionMode: mode,
								directUrl: mode === "direct" ? directUrl.trim() : null,
								scope,
								projectId: scope === "project" ? projectId : null,
							})
						}
					>
						{t("deviceSaveButton")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function DeviceDiagnosticsModal({
	device,
	testResult,
	testing,
	onTest,
	onClose,
}: {
	device: RemoteDevice | null;
	testResult?: TestConnectionResult;
	testing: boolean;
	onTest: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	const diagnosticsQuery = useQuery({
		queryKey: ["deviceDiagnostics", device?.id],
		queryFn: () => api.getDeviceDiagnostics(device?.id ?? ""),
		enabled: !!device,
		refetchInterval: device ? 3_000 : false,
	});
	const diagnostics = diagnosticsQuery.data ?? testResult?.diagnostics;

	return (
		<Modal
			opened={!!device}
			onClose={onClose}
			title={t("deviceDiagnosticsTitle", { name: device?.name ?? "" })}
			size="lg"
		>
			<Stack>
				{diagnosticsQuery.isLoading && !diagnostics ? <Loader size="sm" /> : null}
				{diagnosticsQuery.isError ? (
					<Alert color="red">{t("deviceDiagnosticsLoadFailed")}</Alert>
				) : null}
				{testResult ? (
					<Alert
						color={testResult.ok ? "green" : "red"}
						title={testResult.ok ? t("deviceTestPassed") : t("deviceTestFailed")}
					>
						<Text size="sm">
							{diagnosticStageLabel(t, testResult.stage)}
							{testResult.latencyMs !== undefined ? ` · ${testResult.latencyMs} ms` : ""}
						</Text>
						{testResult.message ? <Text size="sm">{testResult.message}</Text> : null}
					</Alert>
				) : null}
				{diagnostics ? <DiagnosticsDetails diagnostics={diagnostics} /> : null}
				<Group justify="flex-end">
					<Button variant="default" onClick={() => diagnosticsQuery.refetch()}>
						{t("deviceDiagnosticsRefresh")}
					</Button>
					<Button loading={testing} onClick={onTest}>
						{t("deviceTestButton")}
					</Button>
					<Button variant="default" onClick={onClose}>
						{t("close")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function DiagnosticsDetails({ diagnostics }: { diagnostics: DeviceConnectionDiagnostics }) {
	const { t } = useTranslation("settings");
	const platform = diagnostics.platform
		? `${diagnostics.platform.os}/${diagnostics.platform.arch}`
		: "—";
	return (
		<Stack gap="sm">
			<Group gap="xs">
				<Badge color={diagnostics.online ? "green" : "gray"}>
					{diagnostics.online ? t("deviceOnline") : t("deviceOffline")}
				</Badge>
				<Badge variant="outline">{diagnosticStageLabel(t, diagnostics.stage)}</Badge>
				<Badge variant="outline">{diagnostics.mode}</Badge>
			</Group>
			{diagnostics.lastError ? (
				<Alert color="red" title={t("deviceDiagnosticsLastError")}>
					{diagnostics.lastError}
				</Alert>
			) : null}
			<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
				<ReviewField
					label={t("deviceDiagnosticsSocketState")}
					value={diagnostics.socketState ?? "—"}
				/>
				<ReviewField label={t("deviceDiagnosticsPlatform")} value={platform} />
				<ReviewField label={t("deviceAgentVersion")} value={diagnostics.agentVersion ?? "—"} />
				<ReviewField
					label={t("deviceDiagnosticsProtocolVersion")}
					value={diagnostics.protocolVersion?.toString() ?? "—"}
				/>
				<ReviewField label={t("deviceDefaultCwd")} value={diagnostics.defaultCwd ?? "—"} />
				<ReviewField label={t("deviceDirectUrlLabel")} value={diagnostics.directUrl ?? "—"} />
				<ReviewField
					label={t("deviceLastSeen")}
					value={formatDateTime(diagnostics.lastSeenAt, t("deviceNeverSeen"))}
				/>
				<ReviewField
					label={t("deviceDiagnosticsLastEvent")}
					value={formatDateTime(diagnostics.lastEventAt, "—")}
				/>
			</SimpleGrid>
			{diagnostics.capabilities ? (
				<Stack gap={4}>
					<Text size="xs" fw={600} c="dimmed">
						{t("deviceDiagnosticsCapabilities")}
					</Text>
					<Code block>{JSON.stringify(diagnostics.capabilities, null, 2)}</Code>
				</Stack>
			) : null}
		</Stack>
	);
}

function ReviewField({ label, value }: { label: string; value: string }) {
	return (
		<Box>
			<Text size="xs" c="dimmed">
				{label}
			</Text>
			<Text size="sm" style={{ overflowWrap: "anywhere" }}>
				{value || "—"}
			</Text>
		</Box>
	);
}

function TransferModal({ device, onClose }: { device: RemoteDevice | null; onClose: () => void }) {
	const { t } = useTranslation("settings");
	const [direction, setDirection] = useState<"download" | "upload">("download");
	const [remotePath, setRemotePath] = useState("");
	const [localPath, setLocalPath] = useState("");
	const [recursive, setRecursive] = useState(false);
	const [taskId, setTaskId] = useState<string | null>(null);

	useEffect(() => {
		if (!device) return;
		setDirection("download");
		setRemotePath("");
		setLocalPath("");
		setRecursive(false);
		setTaskId(null);
	}, [device]);

	const tasksQuery = useQuery<DeviceTransferTask[]>({
		queryKey: ["device-transfer-tasks", device?.id],
		queryFn: () => api.listTransferTasks(device?.id ?? ""),
		enabled: !!device,
		refetchInterval: (query) =>
			query.state.data?.some((task) => task.status === "queued" || task.status === "running")
				? 1_000
				: false,
	});
	const taskQuery = useQuery<DeviceTransferTask>({
		queryKey: ["device-transfer-task", device?.id, taskId],
		queryFn: () => api.getTransferTask(device?.id ?? "", taskId ?? ""),
		enabled: !!device && !!taskId,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "queued" || status === "running" ? 750 : false;
		},
	});
	const task = taskQuery.data;
	const transferMut = useMutation({
		mutationFn: () => {
			if (!device) throw new Error("no device");
			return api.startTransferTask(device.id, { direction, remotePath, localPath, recursive });
		},
		onSuccess: (created) => {
			setTaskId(created.id);
			void tasksQuery.refetch();
		},
		onError: showError,
	});
	const controlMut = useMutation({
		mutationFn: (action: "pause" | "resume" | "cancel") => {
			if (!device || !taskId) throw new Error("no transfer task");
			if (action === "pause") return api.pauseTransferTask(device.id, taskId);
			if (action === "resume") return api.resumeTransferTask(device.id, taskId);
			return api.cancelTransferTask(device.id, taskId);
		},
		onSuccess: async (updated) => {
			await Promise.all([taskQuery.refetch(), tasksQuery.refetch()]);
			return updated;
		},
		onError: showError,
	});
	const progress = task?.totalBytes
		? Math.min(100, (task.bytesTransferred / task.totalBytes) * 100)
		: 0;

	return (
		<Modal
			opened={!!device}
			onClose={onClose}
			title={t("deviceTransferTitle", { name: device?.name ?? "" })}
		>
			<Stack>
				{tasksQuery.data?.length ? (
					<Select
						label={t("deviceTransferRecentTask")}
						placeholder={t("deviceTransferNewTask")}
						clearable
						value={taskId}
						onChange={setTaskId}
						data={tasksQuery.data.map((item) => ({
							value: item.id,
							label: `${item.direction === "download" ? "↓" : "↑"} ${item.remotePath} · ${t(`deviceTransferStatus.${item.status}`)}`,
						}))}
					/>
				) : null}
				{taskId ? (
					task ? (
						<>
							<Group justify="space-between">
								<Text size="sm">{t("deviceTransferTaskId", { id: task.id })}</Text>
								<Badge>{t(`deviceTransferStatus.${task.status}`)}</Badge>
							</Group>
							<Progress value={progress} animated={task.status === "running"} />
							<Text size="xs" c="dimmed">
								{formatBytes(task.bytesTransferred)} / {formatBytes(task.totalBytes ?? 0)}
							</Text>
							{task.error && <Alert color="red">{task.error}</Alert>}
							<Group justify="flex-end">
								{task.status === "running" || task.status === "queued" ? (
									<Button variant="default" onClick={() => controlMut.mutate("pause")}>
										{t("deviceTransferPause")}
									</Button>
								) : null}
								{task.status === "paused" || task.status === "failed" ? (
									<Button onClick={() => controlMut.mutate("resume")}>
										{t("deviceTransferResume")}
									</Button>
								) : null}
								{!["completed", "cancelled"].includes(task.status) ? (
									<Button color="red" variant="light" onClick={() => controlMut.mutate("cancel")}>
										{t("deviceTransferCancelTask")}
									</Button>
								) : null}
								<Button variant="default" onClick={onClose}>
									{t("close")}
								</Button>
							</Group>
						</>
					) : taskQuery.isError ? (
						<Alert color="red">
							{taskQuery.error instanceof Error ? taskQuery.error.message : String(taskQuery.error)}
						</Alert>
					) : (
						<Group justify="center" py="md">
							<Loader size="sm" />
						</Group>
					)
				) : (
					<>
						<Select
							label={t("deviceTransferDirection")}
							data={[
								{ value: "download", label: t("deviceTransferDownload") },
								{ value: "upload", label: t("deviceTransferUpload") },
							]}
							value={direction}
							onChange={(value) => setDirection((value as "download" | "upload") ?? "download")}
						/>
						<TextInput
							label={t("deviceTransferRemotePath")}
							placeholder="/home/user/file.bin"
							value={remotePath}
							onChange={(event) => setRemotePath(event.currentTarget.value)}
						/>
						<TextInput
							label={t("deviceTransferLocalPath")}
							placeholder="/path/on/server/file.bin"
							value={localPath}
							onChange={(event) => setLocalPath(event.currentTarget.value)}
						/>
						<Checkbox
							label={t("deviceTransferRecursive")}
							checked={recursive}
							onChange={(event) => setRecursive(event.currentTarget.checked)}
						/>
						<Group justify="flex-end">
							<Button variant="default" onClick={onClose}>
								{t("cancel")}
							</Button>
							<Button
								loading={transferMut.isPending}
								disabled={!remotePath.trim() || !localPath.trim()}
								onClick={() => transferMut.mutate()}
							>
								{t("deviceTransferStart")}
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Modal>
	);
}

function TokenModal({
	issued,
	onInstall,
	onClose,
}: {
	issued: IssuedToken | null;
	onInstall: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	const [manualOpen, setManualOpen] = useState(false);
	// The generated installer is the primary path; the raw command is kept behind a
	// disclosure for operators who install by hand.
	const command = issued
		? buildDeviceRunCommand(issued.device.connectionMode, issued.device.slug, "file", {
				serverBaseUrl: window.location.origin,
			})
		: "";
	return (
		<Modal opened={!!issued} onClose={onClose} title={t("deviceTokenModalTitle")} size="lg">
			{issued ? (
				<Stack>
					<Alert color="yellow">{t("deviceTokenWarning")}</Alert>
					<Text size="sm">{t("deviceTokenForDevice", { name: issued.device.name })}</Text>
					<Code block>{issued.token}</Code>
					<CopyButton value={issued.token}>
						{({ copied, copy }) => (
							<Button onClick={copy} variant="light">
								{copied ? t("copied") : t("copy")}
							</Button>
						)}
					</CopyButton>
					<Divider />
					<Text size="sm">{t("deviceTokenNextStep")}</Text>
					<Group>
						<Button onClick={onInstall}>{t("executorInstallGenerate")}</Button>
						<Button variant="subtle" onClick={() => setManualOpen((open) => !open)}>
							{manualOpen ? t("deviceManualInstallHide") : t("deviceManualInstallShow")}
						</Button>
					</Group>
					{manualOpen ? (
						<Stack gap="xs">
							<Text size="xs" c="dimmed">
								{t("deviceRunHint")}
							</Text>
							<Code block>{command}</Code>
							<CopyButton value={command}>
								{({ copied, copy }) => (
									<Button onClick={copy} variant="default">
										{copied ? t("copied") : t("deviceCopyCommand")}
									</Button>
								)}
							</CopyButton>
							<Text size="xs" c="dimmed">
								{t("deviceTokenFileHint")}
							</Text>
						</Stack>
					) : null}
				</Stack>
			) : null}
		</Modal>
	);
}

function projectSelectOptions(
	projects: ProjectOption[],
	t: (key: string, values?: Record<string, unknown>) => string,
) {
	return projects.map((project) => ({
		value: project.id,
		label:
			project.status === "archived"
				? t("deviceProjectArchivedValue", { project: project.name })
				: project.name,
	}));
}

/**
 * Compare the version a device reported at handshake against the latest published
 * release. Rendered as a badge so version skew is visible without opening
 * diagnostics.
 */
function executorVersionBadge(
	t: (key: string, values?: Record<string, unknown>) => string,
	agentVersion: string | null,
	latestVersion: string | undefined,
) {
	if (!agentVersion || !latestVersion) return null;
	if (agentVersion === latestVersion) {
		return (
			<Badge color="green" variant="light">
				{t("executorVersionCurrent")}
			</Badge>
		);
	}
	return (
		<Badge color="orange" variant="light">
			{t("executorVersionUpgradeAvailable", { version: latestVersion })}
		</Badge>
	);
}

function diagnosticStageLabel(
	t: (key: string, values?: Record<string, unknown>) => string,
	stage: string,
): string {
	const key = `deviceDiagnosticStage_${stage}`;
	const translated = t(key);
	return translated === key ? stage : translated;
}

function formatDateTime(value: string | number | null | undefined, fallback: string): string {
	if (value === null || value === undefined || value === "") return fallback;
	return formatLocaleDateTime(value) || fallback;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
