import { Alert, Button, Group, List, Modal, Stack, TagsInput, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconAlertTriangle,
	IconCertificate,
	IconDownload,
	IconHelpCircle,
	IconRefresh,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { formatLocaleDate } from "../../lib/intl-format";

// Client-side pre-check only; the server (`parseSanEntries`) is the authority.
// Entries are tested lowercased to match the server's DNS canonicalization —
// otherwise "NAS.local" would be rejected here although the server accepts it.
const SAN_ENTRY_RE =
	/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$|^[0-9a-f:.]+$/;

function formatExpiry(iso: string | null): string | null {
	if (!iso) return null;
	// `formatLocaleDate` rather than the Date method with no locale argument: the bare
	// method follows the SYSTEM locale, so this date rendered in English for a user running
	// the app in Chinese. An unparseable value returns "", and the raw string is shown
	// instead — a certificate's stated expiry is worth surfacing verbatim rather than blank.
	return formatLocaleDate(iso) || iso;
}

export interface TlsSectionProps {
	/** Push newly issued cert paths into the parent settings form state. */
	onCertIssued: (certPath: string, keyPath: string) => void;
}

/**
 * TLS certificate management: local root CA + CA-signed server certificates
 * with user-managed SANs. Trusting the CA on a device is a one-time import;
 * re-issuing the server cert (new SANs, changed LAN IP) needs no client work.
 */
export function TlsSection({ onCertIssued }: TlsSectionProps) {
	const { t } = useTranslation("settings");
	const queryClient = useQueryClient();
	const [generating, setGenerating] = useState(false);
	const [regeneratingCa, setRegeneratingCa] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [actionResult, setActionResult] = useState<string | null>(null);
	const [sanInput, setSanInput] = useState<string[]>([]);
	const [sanError, setSanError] = useState<string | null>(null);
	const [confirmCaOpened, { open: openConfirmCa, close: closeConfirmCa }] = useDisclosure(false);
	const [guideOpened, { open: openGuide, close: closeGuide }] = useDisclosure(false);

	const status = useQuery({
		queryKey: ["settings", "tls-status"],
		queryFn: api.getTlsStatus,
	});

	// Initialize the editor from stored custom SANs ONCE per mount. The query
	// refetches on window focus (staleTime is 5s), and re-syncing on every data
	// arrival would silently discard SAN entries the user typed but has not
	// issued yet — the same stale-snapshot clobber the server-side SAN sidecar
	// exists to prevent.
	const didInitSansRef = useRef(false);
	useEffect(() => {
		if (status.data && !didInitSansRef.current) {
			didInitSansRef.current = true;
			setSanInput(status.data.customSans);
		}
	}, [status.data]);

	const invalidateStatus = () =>
		queryClient.invalidateQueries({ queryKey: ["settings", "tls-status"] });

	const validateSans = (values: string[]): boolean => {
		const bad = values.filter((v) => !SAN_ENTRY_RE.test(v.trim().toLowerCase()));
		setSanError(bad.length > 0 ? t("tlsSanInvalid", { entries: bad.join(", ") }) : null);
		return bad.length === 0;
	};

	const handleGenerate = async () => {
		if (!validateSans(sanInput)) return;
		setGenerating(true);
		setActionResult(null);
		try {
			const result = await api.generateTlsWithCa(sanInput.map((s) => s.trim()).filter(Boolean));
			onCertIssued(result.certPath, result.keyPath);
			setActionResult(t("tlsGenerateSuccess"));
			await invalidateStatus();
			if (result.serverRestarting && result.newUrl) {
				setTimeout(() => {
					window.location.href = result.newUrl;
				}, 1500);
			}
		} catch (err) {
			setActionResult(err instanceof Error ? err.message : t("tlsGenerateError"));
		} finally {
			setGenerating(false);
		}
	};

	const handleRegenerateCa = async () => {
		closeConfirmCa();
		setRegeneratingCa(true);
		setActionResult(null);
		try {
			const result = await api.regenerateTlsCa();
			// When TLS is off the route does not restart the server, so the freshly
			// issued cert only takes effect on the next manual restart — say so.
			setActionResult(
				result.serverRestarting
					? t("tlsCaRegenerated")
					: `${t("tlsCaRegenerated")} ${t("serverRestartRequired")}`,
			);
			await invalidateStatus();
		} catch (err) {
			setActionResult(err instanceof Error ? err.message : t("tlsGenerateError"));
		} finally {
			setRegeneratingCa(false);
		}
	};

	const handleDownloadCa = async () => {
		setDownloading(true);
		try {
			const { blob, fileName } = await api.downloadTlsCa();
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = fileName ?? "narrafork-ca.pem";
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			setActionResult(err instanceof Error ? err.message : t("tlsCaDownloadError"));
		} finally {
			setDownloading(false);
		}
	};

	const data = status.data;

	return (
		<Stack gap="sm">
			{/* Status */}
			{data && (
				<Stack gap={4}>
					<Text size="sm" c={data.caExists ? undefined : "dimmed"}>
						{data.caExists
							? t("tlsCaStatusExists", { date: formatExpiry(data.caExpiresAt) })
							: t("tlsCaStatusMissing")}
					</Text>
					{data.certExists && (
						<Text size="sm" c="dimmed">
							{t("tlsCertStatusExists", { date: formatExpiry(data.certExpiresAt) })}
						</Text>
					)}
				</Stack>
			)}
			{data?.legacySelfSigned && (
				<Alert color="yellow" icon={<IconAlertTriangle size={16} />} variant="light" py={6}>
					{t("tlsLegacySelfSignedHint")}
				</Alert>
			)}

			{/* Custom SAN editor */}
			<TagsInput
				label={t("tlsCustomSans")}
				description={t("tlsCustomSansDesc")}
				placeholder={t("tlsCustomSansPlaceholder")}
				value={sanInput}
				onChange={(v) => {
					setSanInput(v);
					setSanError(null);
				}}
				error={sanError}
				clearable
			/>
			{data && data.autoSans.length > 0 && (
				<Text size="xs" c="dimmed">
					{t("tlsAutoSansNote", { sans: data.autoSans.join(", ") })}
				</Text>
			)}

			{/* Actions */}
			<Group gap="sm" align="flex-start">
				<Button
					leftSection={<IconCertificate size={16} />}
					variant="light"
					color="green"
					size="xs"
					loading={generating}
					onClick={handleGenerate}
				>
					{generating
						? t("tlsGenerating")
						: data?.certExists
							? t("tlsReissue")
							: t("tlsGenerateCert")}
				</Button>
				{data?.caExists && (
					<>
						<Button
							leftSection={<IconDownload size={16} />}
							variant="default"
							size="xs"
							loading={downloading}
							onClick={handleDownloadCa}
						>
							{t("tlsDownloadCa")}
						</Button>
						<Button
							leftSection={<IconRefresh size={16} />}
							variant="light"
							color="red"
							size="xs"
							loading={regeneratingCa}
							onClick={openConfirmCa}
						>
							{t("tlsRegenerateCa")}
						</Button>
					</>
				)}
				<Button
					leftSection={<IconHelpCircle size={16} />}
					variant="subtle"
					size="xs"
					onClick={openGuide}
				>
					{t("tlsTrustGuide")}
				</Button>
			</Group>
			{actionResult && (
				<Text size="sm" c="dimmed">
					{actionResult}
				</Text>
			)}
			<Alert color="yellow" icon={<IconAlertTriangle size={16} />} variant="light" py={6}>
				{t("tlsGenerateWarning")}
			</Alert>

			{/* Regenerate-CA confirmation */}
			<Modal
				opened={confirmCaOpened}
				onClose={closeConfirmCa}
				title={t("tlsRegenerateCa")}
				size="md"
			>
				<Stack>
					<Text size="sm">{t("tlsRegenerateCaConfirm")}</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={closeConfirmCa}>
							{t("cancel")}
						</Button>
						<Button color="red" onClick={handleRegenerateCa}>
							{t("tlsRegenerateCa")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{/* Per-OS trust guide */}
			<Modal opened={guideOpened} onClose={closeGuide} title={t("tlsTrustGuide")} size="lg">
				<Stack gap="md">
					<Text size="sm">{t("tlsTrustGuideIntro")}</Text>
					{(["windows", "macos", "linux", "ios", "android"] as const).map((os) => (
						<div key={os}>
							<Text size="sm" fw={600} mb={4}>
								{t(`tlsTrustGuide_${os}`)}
							</Text>
							<List size="sm" type="ordered">
								{(t(`tlsTrustGuideSteps_${os}`, { returnObjects: true }) as string[]).map(
									(step) => (
										<List.Item key={`${os}-${step.slice(0, 32)}`}>{step}</List.Item>
									),
								)}
							</List>
						</div>
					))}
				</Stack>
			</Modal>
		</Stack>
	);
}
