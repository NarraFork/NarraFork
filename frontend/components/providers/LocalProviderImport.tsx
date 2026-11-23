import { Alert, Badge, Button, Checkbox, Group, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
	LocalImportSource,
	LocalProviderCandidateSummary,
	LocalProviderScanResponse,
} from "@shared/local-provider-import";
import type { AddProviderType } from "@shared/sourcing/presets";
import { type Ref, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { AddProviderDraft } from "./provider-add-draft";

export const LOCAL_IMPORT_SOURCE_LABELS: Record<LocalImportSource, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	"deepseek-harness": "DeepSeek Harness",
};

/** Candidates selected by default: those with a key that are not configured yet. */
export function defaultLocalImportSelection(
	candidates: readonly LocalProviderCandidateSummary[],
): Set<string> {
	return new Set(
		candidates
			.filter((candidate) => candidate.hasKey && !candidate.alreadyConfigured)
			.map((candidate) => candidate.id),
	);
}

/** Whether any tool has a config location (from detect, which reads no file). */
export function hasDetectedLocalSources(
	sources: readonly { source: LocalImportSource; found: boolean }[] | undefined,
): boolean {
	return !!sources?.some((source) => source.found);
}

/**
 * "Import from this machine", shown in the add-provider configuration pane:
 * reads other AI tools' provider configs on the server only after the admin
 * clicks to authorize it, lists what was found with masked keys, and saves the
 * chosen ones through the regular add-provider flow.
 */
export function LocalProviderImport({
	importProvider,
	protocolLabel,
	onImported,
	detectedSources,
	headingRef,
}: {
	importProvider: (draft: AddProviderDraft) => Promise<{ refreshFailed: boolean }>;
	protocolLabel: (protocol: AddProviderType) => string;
	onImported: () => void;
	/** Detection result shown before the first scan. */
	detectedSources?: readonly { source: LocalImportSource; found: boolean }[];
	headingRef?: Ref<HTMLHeadingElement>;
}) {
	const { t, i18n } = useTranslation("settings");
	const listFormat = new Intl.ListFormat(i18n.resolvedLanguage ?? i18n.language, {
		type: "conjunction",
	});
	const [scan, setScan] = useState<LocalProviderScanResponse | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [scanning, setScanning] = useState(false);
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busyRef = useRef(false);

	const runScan = async () => {
		if (busyRef.current) return;
		busyRef.current = true;
		setScanning(true);
		setError(null);
		try {
			const result = await api.scanLocalProviders();
			setScan(result);
			setSelected(defaultLocalImportSelection(result.candidates));
		} catch (cause) {
			setError(
				cause instanceof Error && cause.message ? cause.message : t("localImport.scanFailed"),
			);
		} finally {
			busyRef.current = false;
			setScanning(false);
		}
	};

	const runImport = async () => {
		if (busyRef.current || selected.size === 0) return;
		busyRef.current = true;
		setImporting(true);
		setError(null);
		const failures: string[] = [];
		const refreshFailed: string[] = [];
		let imported = 0;
		try {
			const { providers, missing } = await api.resolveLocalProviders([...selected]);
			for (const provider of providers) {
				try {
					const result = await importProvider({
						protocol: provider.protocol,
						name: provider.name,
						baseUrl: provider.baseUrl,
						apiKey: provider.apiKey,
						prefix: "",
					});
					imported++;
					if (result.refreshFailed) refreshFailed.push(provider.name);
				} catch (cause) {
					failures.push(
						t("localImport.importFailed", {
							name: provider.name,
							error: cause instanceof Error ? cause.message : String(cause),
						}),
					);
				}
			}
			if (missing.length > 0) failures.push(t("localImport.importChanged"));
		} catch (cause) {
			failures.push(
				cause instanceof Error && cause.message ? cause.message : t("localImport.scanFailed"),
			);
		} finally {
			busyRef.current = false;
			setImporting(false);
		}

		if (imported > 0) {
			notifications.show({
				title: t("localImport.importDone", { count: imported }),
				message:
					refreshFailed.length > 0
						? t("localImport.importRefreshFailed", { names: listFormat.format(refreshFailed) })
						: t("addProviderModelsRefreshed"),
				color: refreshFailed.length > 0 ? "yellow" : "green",
			});
		}
		if (failures.length > 0) {
			setError(failures.join("\n"));
			// Re-scan so the list reflects what was saved and what changed on disk.
			if (imported > 0) void runScan();
			return;
		}
		if (imported > 0) onImported();
	};

	const toggle = (id: string, checked: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	};

	const foundSources = (scan?.sources ?? detectedSources ?? []).filter((source) => source.found);
	const knowsSources = !!scan || !!detectedSources;
	const busy = scanning || importing;

	return (
		<Stack gap="sm">
			<Title ref={headingRef} tabIndex={-1} order={3}>
				{t("localImport.title")}
			</Title>
			<Text size="sm" c="dimmed">
				{t("localImport.description")}
			</Text>

			{knowsSources && (
				<Text size="xs" c="dimmed">
					{foundSources.length > 0
						? t("localImport.sourcesFound", {
								sources: listFormat.format(
									foundSources.map((source) => LOCAL_IMPORT_SOURCE_LABELS[source.source]),
								),
							})
						: t("localImport.sourcesNone")}
				</Text>
			)}

			{scan?.notes.map((note) => (
				<Text key={`${note.source}:${note.code}`} size="xs" c="dimmed">
					{t("localImport.subscriptionSkipped", {
						source: LOCAL_IMPORT_SOURCE_LABELS[note.source],
					})}
				</Text>
			))}

			{scan && scan.candidates.length === 0 && <Text size="sm">{t("localImport.noneFound")}</Text>}

			{scan && scan.candidates.length > 0 && (
				<Stack gap="xs" role="group" aria-label={t("localImport.title")}>
					{scan.candidates.map((candidate) => (
						<Checkbox
							key={candidate.id}
							data-local-import-candidate={candidate.id}
							disabled={busy || !candidate.hasKey || candidate.alreadyConfigured}
							checked={selected.has(candidate.id)}
							onChange={(event) => toggle(candidate.id, event.currentTarget.checked)}
							label={
								<Group gap={6} wrap="wrap">
									<Text size="sm" fw={600}>
										{candidate.name}
									</Text>
									<Badge size="xs" variant="outline">
										{LOCAL_IMPORT_SOURCE_LABELS[candidate.source]}
									</Badge>
									<Badge size="xs" variant="light">
										{protocolLabel(candidate.protocol)}
									</Badge>
									{candidate.alreadyConfigured && (
										<Badge size="xs" color="gray" variant="light">
											{t("localImport.alreadyConfigured")}
										</Badge>
									)}
								</Group>
							}
							description={
								<>
									{candidate.baseUrl}
									{candidate.apiKeyPreview &&
										` · ${t("localImport.key", { key: candidate.apiKeyPreview })}`}
									{candidate.model && ` · ${t("localImport.model", { model: candidate.model })}`}
								</>
							}
						/>
					))}
				</Stack>
			)}

			{error && (
				<Alert color="red" role="alert" style={{ whiteSpace: "pre-line" }}>
					{error}
				</Alert>
			)}

			<Group gap="xs">
				{scan && scan.candidates.length > 0 && (
					<Button
						onClick={() => void runImport()}
						loading={importing}
						disabled={busy || selected.size === 0}
					>
						{t("localImport.import", { count: selected.size })}
					</Button>
				)}
				<Button
					variant={scan ? "default" : "light"}
					onClick={() => void runScan()}
					loading={scanning}
					disabled={busy}
				>
					{t(scan ? "localImport.rescan" : "localImport.authorize")}
				</Button>
			</Group>
		</Stack>
	);
}
