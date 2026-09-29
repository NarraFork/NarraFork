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

	// Persist every valid edit immediately: the main settings "Save" button does
	// not cover SANs (they live in a server-side sidecar), so without this the
	// list was lost on reload unless the admin also re-issued the certificate.
	const handleSansChange = async (values: string[]) => {
		setSanInput(values);
		if (!validateSans(values)) return;
		try {
			await api.saveTlsSans(values.map((s) => s.trim()).filter(Boolean));
			await invalidateStatus();
		} catch (err) {
			setSanError(err instanceof Error ? err.message : t("tlsGenerateError"));
		}
	};

	const data = status.data;
	// Saved names the current certificate does not cover yet → re-issue needed.
	const certSanSet = new Set((data?.certSans ?? []).map((s) => s.toLowerCase()));
	const pendingSans = data?.certExists
		? sanInput.filter((s) => !certSanSet.has(s.trim().toLowerCase()))
		: [];
	// Custom names the current cert was issued with = its SANs minus the auto set.
	// Any difference (added OR removed) from the editor means a re-issue is due.
	const autoSanSet = new Set((data?.autoSans ?? []).map((s) => s.toLowerCase()));
	const certCustom = [...certSanSet].filter((s) => !autoSanSet.has(s));
	const editorSans = new Set(sanInput.map((s) => s.trim().toLowerCase()).filter(Boolean));
	const sansChanged =
		!!data?.certExists &&
		(editorSans.size !== certCustom.length || certCustom.some((s) => !editorSans.has(s)));

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
				onChange={handleSansChange}
				error={sanError}
				clearable
			/>
			{pendingSans.length > 0 && (
				<Text size="xs" c="yellow">
					{t("tlsSansPendingReissue", { sans: pendingSans.join(", ") })}
				</Text>
			)}
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
					data-sans-changed={sansChanged || undefined}
					style={
						sansChanged && !generating
							? { animation: "tlsReissuePulse 1.5s ease infinite" }
							: undefined
					}
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

			{/* Same pulse as the settings Save button, looped until the cert is re-issued. */}
			<style>{`
				@keyframes tlsReissuePulse {
					0% { box-shadow: 0 0 0 0 var(--mantine-color-green-5); }
					40% { box-shadow: 0 0 0 10px transparent; }
					100% { box-shadow: 0 0 0 0 transparent; }
				}
			`}</style>

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
