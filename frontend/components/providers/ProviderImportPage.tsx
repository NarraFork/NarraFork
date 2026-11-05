import {
	Alert,
	Anchor,
	Badge,
	Button,
	Checkbox,
	Group,
	Loader,
	Paper,
	PasswordInput,
	SegmentedControl,
	Select,
	Stack,
	Table,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	applyLinkCredentials,
	type ImportFetchAttempt,
	type ImportPreviewResponse,
	importUrlHost,
	type ParsedImportInput,
	type ProviderImportPayload,
	parseImportInput,
	validateImportPayload,
} from "@shared/provider-import";
import {
	IconAlertTriangle,
	IconArrowLeft,
	IconCircleCheck,
	IconFileImport,
	IconLink,
	IconPlugConnected,
} from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { CUSTOM_API_PROTOCOL_LABEL_KEYS } from "./CustomApiProviderSection";
import {
	type ProtocolSelfTestResult,
	readLastSelfTest,
	registerProtocolHandler,
	runProtocolSelfTest,
} from "./protocol-handler";
import {
	type RefreshableProvider,
	refreshImportedModels,
	showRefreshOutcomes,
} from "./refresh-imported-models";

/** Where the payload came from; only a domain fetch proves who published it. */
type ImportSource = { kind: "remote"; host: string } | { kind: "inline" };

interface EntryDraft {
	include: boolean;
	action: "add" | "replace-key";
	targetId?: string;
	name: string;
	prefix: string;
	apiKey: string;
	/** True when the key arrived with the code or link rather than being typed here. */
	keyFromSource: boolean;
}

interface Loaded {
	payload: ProviderImportPayload;
	source: ImportSource;
	ignoredFields: string[];
	droppedApiKey: boolean;
	preview: ImportPreviewResponse;
	drafts: EntryDraft[];
}

interface ProviderImportPageProps {
	/** What the page was opened with (protocol handler or fallback link), already cleared from the URL. */
	initialInput: ParsedImportInput | null;
	onClose: (providerId?: string) => void;
	onImported: (settings: Record<string, unknown>) => void;
}

/** Result of listing models with one key before importing; `apiKey` is the value checked. */
type KeyCheck =
	| { status: "checking"; apiKey: string }
	| { status: "ok"; apiKey: string; count: number }
	| { status: "failed"; apiKey: string; error: string };

/** The payload as it would be committed: keys come from the drafts, not the source. */
function payloadFromDrafts(loaded: Loaded): ProviderImportPayload {
	return {
		...loaded.payload,
		providers: loaded.payload.providers.map((entry, index) => {
			const key = loaded.drafts[index]?.apiKey.trim();
			const { apiKey: _ignored, ...rest } = entry;
			return { ...rest, ...(key ? { apiKey: key } : {}) };
		}),
	};
}

function maskKey(key: string): string {
	return key.length <= 8 ? "••••" : `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

export function ProviderImportPage({ initialInput, onClose, onImported }: ProviderImportPageProps) {
	const { t } = useTranslation("settings");
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attempts, setAttempts] = useState<ImportFetchAttempt[]>([]);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [importDisabled, setImportDisabled] = useState(false);
	const [checks, setChecks] = useState<Record<string, KeyCheck>>({});
	const [checkTruncated, setCheckTruncated] = useState(false);

	/** List models with every provider key in `payload` before anything is saved. */
	const runChecks = useCallback(async (payload: ProviderImportPayload) => {
		const pending: Record<string, KeyCheck> = {};
		payload.providers.forEach((entry, index) => {
			if (entry.apiKey) pending[index] = { status: "checking", apiKey: entry.apiKey };
		});
		setChecks(pending);
		setCheckTruncated(false);
		if (Object.keys(pending).length === 0) return;
		try {
			const response = await api.providerImportCheck(payload);
			const next: Record<string, KeyCheck> = {};
			for (const result of response.results) {
				const apiKey = pending[result.entry]?.apiKey ?? "";
				next[result.entry] = result.ok
					? { status: "ok", apiKey, count: result.count ?? 0 }
					: { status: "failed", apiKey, error: result.error ?? "" };
			}
			setChecks(next);
			setCheckTruncated(response.truncated);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			setChecks(
				Object.fromEntries(
					Object.entries(pending).map(([key, check]) => [
						key,
						{ status: "failed", apiKey: check.apiKey, error },
					]),
				),
			);
		}
	}, []);

	const errorText = useCallback(
		(code: string, detail?: string) =>
			detail ? `${t(`providerImportError_${code}`)} (${detail})` : t(`providerImportError_${code}`),
		[t],
	);

	const load = useCallback(
		async (parsed: ParsedImportInput) => {
			setError(null);
			setAttempts([]);
			setLoaded(null);
			if (parsed.kind === "error") {
				setError(errorText(parsed.error));
				return;
			}
			setBusy(true);
			try {
				let payload: ProviderImportPayload;
				let source: ImportSource;
				let ignoredFields: string[];
				let droppedApiKey = false;
				if (parsed.kind === "payload") {
					const validation = validateImportPayload(parsed.raw, { allowApiKey: true });
					if (!validation.ok) {
						setError(errorText(validation.error, validation.detail));
						return;
					}
					payload = validation.payload;
					ignoredFields = validation.ignoredFields;
					source = { kind: "inline" };
				} else {
					const fetched = await api.providerImportFetch(parsed.input, parsed.exact);
					setAttempts(fetched.attempts);
					if (!fetched.ok) {
						setError(errorText(fetched.error));
						return;
					}
					payload = applyLinkCredentials(fetched.payload, parsed);
					ignoredFields = fetched.ignoredFields;
					droppedApiKey = fetched.droppedApiKey;
					source = { kind: "remote", host: fetched.host };
				}
				const preview = await api.providerImportPreview(payload);
				const drafts = payload.providers.map((entry, index): EntryDraft => {
					const duplicates = preview.entries[index]?.duplicates ?? [];
					const sameKey = duplicates.find((duplicate) => duplicate.sameKey);
					return {
						// Reusing an address creates a separate provider; only an identical key is skipped.
						include: !sameKey,
						action: "add",
						targetId: (sameKey ?? duplicates[0])?.id,
						name: entry.name,
						prefix: preview.entries[index]?.suggestedPrefix ?? entry.prefix ?? "",
						apiKey: entry.apiKey ?? "",
						keyFromSource: !!entry.apiKey,
					};
				});
				setLoaded({ payload, source, ignoredFields, droppedApiKey, preview, drafts });
				// Keys that arrived with the code or link are checked right away.
				void runChecks(payload);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[errorText, runChecks],
	);

	// Load what the page was opened with exactly once (StrictMode re-runs effects).
	const initialRef = useRef(initialInput);
	// Opened with a link: show a reading state instead of the input step until it resolves.
	const [loadingInitial, setLoadingInitial] = useState(!!initialInput);
	useEffect(() => {
		const input = initialRef.current;
		initialRef.current = null;
		if (input) void load(input).finally(() => setLoadingInitial(false));
	}, [load]);

	/** Step 2 → step 1; what was typed stays in the input. */
	const backToInput = () => {
		setLoaded(null);
		setChecks({});
		setCheckTruncated(false);
		setError(null);
		setAttempts([]);
	};

	const updateDraft = (index: number, patch: Partial<EntryDraft>) =>
		setLoaded((current) =>
			current
				? {
						...current,
						drafts: current.drafts.map((draft, i) =>
							i === index ? { ...draft, ...patch } : draft,
						),
					}
				: current,
		);

	const commit = async () => {
		if (!loaded) return;
		setBusy(true);
		try {
			const payload = payloadFromDrafts(loaded);
			const decisions = loaded.drafts.map((draft) => {
				if (!draft.include) return { action: "skip" as const };
				if (draft.action === "replace-key")
					return { action: "replace-key" as const, targetId: draft.targetId };
				return {
					action: "add" as const,
					name: draft.name,
					prefix: draft.prefix,
					disabled: importDisabled,
				};
			});
			const { results, refresh } = await api.providerImportCommit(payload, decisions);
			const settings = (await api.getSettings()) as unknown as Record<string, unknown> & {
				customApiProviders?: RefreshableProvider[];
			};
			// Fill model lists like the add flow, disabled imports included so enabling them later
			// needs nothing more; failures are reported below and can be retried from settings.
			const outcomes = await refreshImportedModels(refresh, settings.customApiProviders ?? [], t);
			const first = results.find((result) => result.status !== "skipped")?.providerId;
			onImported(settings);
			const added = results.filter((result) => result.status === "added").length;
			const updated = results.filter((result) => result.status === "updated").length;
			notifications.show({
				color: "green",
				title: t("providerImportDone"),
				message: t("providerImportDoneDetail", { added, updated }),
			});
			showRefreshOutcomes(t, outcomes);
			onClose(first);
		} catch (err) {
			notifications.show({
				color: "red",
				title: t("providerImportFailed"),
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const canCommit =
		!!loaded &&
		loaded.drafts.some((draft) => draft.include) &&
		loaded.drafts.every(
			(draft) =>
				!draft.include ||
				(draft.action === "replace-key"
					? !!draft.targetId && !!draft.apiKey.trim()
					: !!draft.name.trim() && !!draft.prefix.trim()),
		);

	return (
		<Stack gap="md" maw={880}>
			<Group gap="sm">
				<Button
					variant="subtle"
					leftSection={<IconArrowLeft size={16} />}
					onClick={loaded ? backToInput : () => onClose()}
					disabled={busy}
				>
					{loaded ? t("providerImportBack") : t("addProviderCancel")}
				</Button>
				<Title order={2}>
					{loaded ? t("providerImportReviewTitle") : t("providerImportTitle")}
				</Title>
			</Group>

			{/* Step 1: where the configuration comes from. Step 2 (below) shows only what it imports. */}
			{!loaded && loadingInitial && (
				<Group gap="sm">
					<Loader size="sm" />
					<Text size="sm" c="dimmed">
						{t("providerImportLoading")}
					</Text>
				</Group>
			)}
			{!loaded && !loadingInitial && (
				<>
					<Paper withBorder p="md" radius="md">
						<Stack gap="xs">
							<Textarea
								label={t("providerImportInput")}
								description={t("providerImportInputDesc")}
								placeholder={t("providerImportInputPlaceholder")}
								autosize
								minRows={2}
								maxRows={6}
								value={text}
								onChange={(event) => setText(event.currentTarget.value)}
								disabled={busy}
							/>
							<Group justify="flex-end">
								<Button
									leftSection={<IconFileImport size={16} />}
									loading={busy && !loaded}
									disabled={!text.trim()}
									onClick={() => void load(parseImportInput(text))}
								>
									{t("providerImportRead")}
								</Button>
							</Group>
						</Stack>
					</Paper>

					<LinkHandlerPanel />

					{error && (
						<Alert color="red" icon={<IconAlertTriangle size={16} />}>
							<Stack gap="xs">
								<Text size="sm">{error}</Text>
								{attempts.length > 0 && <AttemptTable attempts={attempts} />}
							</Stack>
						</Alert>
					)}
				</>
			)}

			{loaded && (
				<Stack gap="sm">
					{loaded.source.kind === "remote" ? (
						<Alert color="green" icon={<IconCircleCheck size={16} />}>
							{t("providerImportSourceVerified", { host: loaded.source.host })}
						</Alert>
					) : (
						<Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
							{t("providerImportSourceUnverified")}
						</Alert>
					)}
					{(loaded.payload.issuer?.name || loaded.payload.keyUrl) && (
						<Group gap="xs">
							{loaded.payload.issuer?.name && (
								<Text size="sm">
									{t("providerImportIssuer", { name: loaded.payload.issuer.name })}
								</Text>
							)}
							{loaded.payload.keyUrl && (
								<Anchor size="sm" href={loaded.payload.keyUrl} target="_blank" rel="noreferrer">
									{t("providerImportGetKey")}
								</Anchor>
							)}
						</Group>
					)}

					{loaded.payload.providers.map((entry, index) => {
						const draft = loaded.drafts[index];
						const duplicates = loaded.preview.entries[index]?.duplicates ?? [];
						const sameKey = duplicates.find((duplicate) => duplicate.sameKey);
						const target = duplicates.find((duplicate) => duplicate.id === draft?.targetId);
						if (!draft) return null;
						return (
							<Paper
								// biome-ignore lint/suspicious/noArrayIndexKey: the payload is fixed once loaded and may repeat a base URL
								key={`${entry.baseUrl}-${index}`}
								withBorder
								p="md"
								radius="md"
							>
								<Stack gap="xs" style={draft.include ? undefined : { opacity: 0.6 }}>
									<Group justify="space-between">
										<Checkbox
											label={<Text fw={600}>{entry.name}</Text>}
											checked={draft.include}
											onChange={(event) =>
												updateDraft(index, { include: event.currentTarget.checked })
											}
										/>
										<Badge variant="light">
											{t(CUSTOM_API_PROTOCOL_LABEL_KEYS[entry.protocol])}
										</Badge>
									</Group>
									<Text size="sm">
										{t("providerImportPrimary")}{" "}
										<Text span fw={700} c="orange">
											{importUrlHost(entry.baseUrl)}
										</Text>{" "}
										<Text span c="dimmed" size="xs">
											{entry.baseUrl}
										</Text>
									</Text>
									{entry.baseUrls && entry.baseUrls.length > 0 && (
										<Text size="sm">
											{t("providerImportMirrors")}{" "}
											<Text span fw={600} c="orange">
												{entry.baseUrls.map(importUrlHost).join(", ")}
											</Text>
										</Text>
									)}

									{duplicates.length > 0 && (
										<Alert color="blue" p="xs">
											<Stack gap={6}>
												<Text size="xs">
													{sameKey
														? t("providerImportDuplicateSameKey", { name: sameKey.name })
														: duplicates.length > 1
															? t("providerImportDuplicateMany", { count: duplicates.length })
															: t("providerImportDuplicate", { name: duplicates[0]?.name ?? "" })}
												</Text>
												{/* Several providers can share an address; choose whose key to replace. */}
												{draft.include &&
													draft.action === "replace-key" &&
													duplicates.length > 1 && (
														<Select
															size="xs"
															label={t("providerImportTargetSite")}
															allowDeselect={false}
															value={draft.targetId ?? null}
															data={duplicates.map((duplicate) => ({
																value: duplicate.id,
																label: `${duplicate.name} (${duplicate.prefix})`,
															}))}
															onChange={(value) => value && updateDraft(index, { targetId: value })}
														/>
													)}
												{draft.include && (
													<SegmentedControl
														size="xs"
														value={draft.action}
														onChange={(value) =>
															updateDraft(index, {
																action: value as EntryDraft["action"],
															})
														}
														data={[
															{ value: "add", label: t("providerImportActionAdd") },
															{
																value: "replace-key",
																label: t("providerImportActionReplaceKey", {
																	name: target?.name ?? duplicates[0]?.name ?? "",
																}),
																disabled: !draft.apiKey.trim(),
															},
														]}
													/>
												)}
											</Stack>
										</Alert>
									)}

									{draft.include && draft.action === "add" && (
										<Group grow gap="xs" align="flex-start">
											<TextInput
												size="xs"
												label={t("customApiProviderName")}
												value={draft.name}
												onChange={(event) =>
													updateDraft(index, { name: event.currentTarget.value })
												}
											/>
											<TextInput
												size="xs"
												label={t("customApiProviderPrefix")}
												value={draft.prefix}
												onChange={(event) =>
													updateDraft(index, {
														prefix: event.currentTarget.value.replace(/:/g, ""),
													})
												}
											/>
										</Group>
									)}
									{draft.include && (
										<PasswordInput
											size="xs"
											label={t("customApiKey")}
											description={
												draft.keyFromSource && draft.apiKey
													? t("providerImportKeyIncluded", { masked: maskKey(draft.apiKey) })
													: t("providerImportKeyMissing")
											}
											autoComplete="off"
											value={draft.apiKey}
											onChange={(event) =>
												updateDraft(index, {
													apiKey: event.currentTarget.value,
													keyFromSource: false,
												})
											}
										/>
									)}
									{draft.include && <KeyCheckBadge check={checks[index]} apiKey={draft.apiKey} />}
								</Stack>
							</Paper>
						);
					})}

					{loaded.droppedApiKey && (
						<Alert color="yellow" p="xs">
							<Text size="xs">{t("providerImportDroppedKey")}</Text>
						</Alert>
					)}
					{loaded.ignoredFields.length > 0 && (
						<Alert color="gray" p="xs">
							<Text size="xs">
								{t("providerImportIgnored", { fields: loaded.ignoredFields.join(", ") })}
							</Text>
						</Alert>
					)}
					{checkTruncated && (
						<Alert color="gray" p="xs">
							<Text size="xs">{t("providerImportCheckTruncated")}</Text>
						</Alert>
					)}
					<Alert color="orange" icon={<IconAlertTriangle size={16} />}>
						{t("providerImportTrustWarning")}
					</Alert>

					<Group justify="space-between">
						<Checkbox
							label={t("providerImportAsDisabled")}
							checked={importDisabled}
							onChange={(event) => setImportDisabled(event.currentTarget.checked)}
						/>
						<Group gap="xs">
							<Button
								variant="light"
								onClick={() => void runChecks(payloadFromDrafts(loaded))}
								disabled={busy || Object.values(checks).some((c) => c.status === "checking")}
							>
								{t("providerImportCheckKeys")}
							</Button>
							<Button variant="default" onClick={() => onClose()} disabled={busy}>
								{t("addProviderCancel")}
							</Button>
							<Button loading={busy} disabled={!canCommit} onClick={() => void commit()}>
								{t("providerImportConfirm")}
							</Button>
						</Group>
					</Group>
				</Stack>
			)}
		</Stack>
	);
}

/** Shows the key check only while it still describes the key in the input. */
function KeyCheckBadge({ check, apiKey }: { check: KeyCheck | undefined; apiKey: string }) {
	const { t } = useTranslation("settings");
	if (!check || check.apiKey !== apiKey.trim()) return null;
	if (check.status === "checking") {
		return (
			<Text size="xs" c="dimmed">
				{t("providerImportKeyChecking")}
			</Text>
		);
	}
	if (check.status === "ok") {
		return (
			<Text size="xs" c="green">
				{t("providerImportKeyOk", { count: check.count })}
			</Text>
		);
	}
	return (
		<Text size="xs" c="red" style={{ wordBreak: "break-word" }}>
			{t("providerImportKeyFailed", { error: check.error })}
		</Text>
	);
}

function AttemptTable({ attempts }: { attempts: ImportFetchAttempt[] }) {
	const { t } = useTranslation("settings");
	return (
		<Table fz="xs" verticalSpacing={2}>
			<Table.Tbody>
				{attempts.map((attempt) => (
					<Table.Tr key={attempt.url}>
						<Table.Td style={{ wordBreak: "break-all" }}>{attempt.url}</Table.Td>
						<Table.Td>
							{t(`providerImportAttempt_${attempt.outcome}`)}
							{attempt.detail ? ` (${attempt.detail})` : ""}
						</Table.Td>
					</Table.Tr>
				))}
			</Table.Tbody>
		</Table>
	);
}

const SELFTEST_COLORS: Record<ProtocolSelfTestResult["outcome"], string> = {
	ok: "green",
	"no-payload": "yellow",
	"no-response": "red",
	unsupported: "gray",
};

/** Register `web+narrafork` with this browser and test that links actually reach this page. */
function LinkHandlerPanel() {
	const { t } = useTranslation("settings");
	const [result, setResult] = useState<ProtocolSelfTestResult | null>(() => readLastSelfTest());
	const [testing, setTesting] = useState(false);

	const register = () => {
		try {
			registerProtocolHandler();
			notifications.show({ color: "green", message: t("providerImportRegisterRequested") });
		} catch (err) {
			notifications.show({
				color: "red",
				title: t("providerImportRegisterFailed"),
				message: window.isSecureContext
					? err instanceof Error
						? err.message
						: String(err)
					: t("providerImportRegisterInsecure"),
			});
		}
	};

	const test = async () => {
		setTesting(true);
		try {
			setResult(await runProtocolSelfTest());
		} finally {
			setTesting(false);
		}
	};

	return (
		<Paper withBorder p="md" radius="md">
			<Stack gap="xs">
				<Group justify="space-between" align="flex-start">
					<Stack gap={0}>
						<Text size="sm" fw={500}>
							{t("providerImportLinkHandler")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("providerImportLinkHandlerDesc")}
						</Text>
					</Stack>
					<Group gap="xs">
						<Button
							variant="subtle"
							size="xs"
							leftSection={<IconLink size={14} />}
							onClick={register}
							disabled={testing}
						>
							{t("providerImportRegister")}
						</Button>
						<Button
							variant="light"
							size="xs"
							leftSection={<IconPlugConnected size={14} />}
							loading={testing}
							onClick={() => void test()}
						>
							{t("providerImportTestLink")}
						</Button>
					</Group>
				</Group>
				<Group gap="xs">
					<Badge variant="light" color={result ? SELFTEST_COLORS[result.outcome] : "gray"}>
						{testing
							? t("providerImportTesting")
							: result
								? t(`providerImportStatus_${result.outcome}`)
								: t("providerImportStatusUntested")}
					</Badge>
					{result && !testing && result.outcome !== "unsupported" && (
						<Text size="xs" c="dimmed">
							{t("providerImportStatusTestedAt", { time: formatLocaleDateTime(result.at) })}
						</Text>
					)}
				</Group>
				{result && !testing && result.outcome !== "ok" && (
					<Text size="xs" c="dimmed">
						{t(`providerImportStatusHelp_${result.outcome}`)}
					</Text>
				)}
			</Stack>
		</Paper>
	);
}
