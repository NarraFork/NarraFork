import {
	Accordion,
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Text,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconDownload, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type GrammarStatus } from "../../lib/api";
import { useConfirmDialog } from "../common/confirm-dialog-context";

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const val = bytes / 1024 ** i;
	return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Grammar install manager for the StructView tool.
 *
 * Grammars are not bundled (they are megabytes each), so this page is the only way
 * one gets installed — StructView deliberately never downloads during a tool call.
 * Until a language's grammar is here, its structural results come from text
 * heuristics.
 */
export function StructuralGrammarsSection() {
	const { t } = useTranslation("settings");
	const confirm = useConfirmDialog();
	const [grammars, setGrammars] = useState<GrammarStatus[] | null>(null);
	const [excluded, setExcluded] = useState<Array<{ id: string; reason: string }>>([]);
	const [cacheBytes, setCacheBytes] = useState(0);
	const [loading, setLoading] = useState(true);
	const [busyLang, setBusyLang] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const result = await api.listGrammars();
			setGrammars(result.grammars);
			setExcluded(result.excluded ?? []);
			setCacheBytes(result.cacheBytes);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const handleDownload = async (grammar: GrammarStatus) => {
		if (busyLang) return;
		setBusyLang(grammar.id);
		try {
			await api.downloadGrammar(grammar.id);
			notifications.show({
				color: "green",
				message: t("grammarsDownloadSucceeded", { label: grammar.label }),
			});
			await load();
		} catch (err) {
			notifications.show({
				color: "red",
				message:
					err instanceof Error && err.message
						? err.message
						: t("grammarsDownloadFailed", { label: grammar.label }),
			});
		} finally {
			setBusyLang(null);
		}
	};

	const handleRemove = async (grammar: GrammarStatus) => {
		if (busyLang) return;
		const ok = await confirm({
			title: t("grammarsRemoveConfirmTitle"),
			message: t("grammarsRemoveConfirmMessage", { label: grammar.label }),
			confirmLabel: t("grammarsRemove"),
			confirmColor: "red",
		});
		if (!ok) return;
		setBusyLang(grammar.id);
		try {
			await api.removeGrammar(grammar.id);
			await load();
		} catch (err) {
			notifications.show({
				color: "red",
				message: err instanceof Error && err.message ? err.message : t("grammarsRemoveFailed"),
			});
		} finally {
			setBusyLang(null);
		}
	};

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("grammarsIntro")}
			</Text>

			{error && (
				<Alert color="red" icon={<IconAlertTriangle size={16} />}>
					{error}
				</Alert>
			)}

			<Paper withBorder p="md">
				<Group justify="space-between" mb="sm">
					<Text size="sm" fw={600}>
						{t("grammarsCacheUsage", { size: formatBytes(cacheBytes) })}
					</Text>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconRefresh size={14} />}
						onClick={() => void load()}
						loading={loading}
					>
						{t("grammarsRefresh")}
					</Button>
				</Group>

				{loading && !grammars ? (
					<Group justify="center" py="md">
						<Loader size="sm" />
					</Group>
				) : (
					<Stack gap="lg">
						{/* Grouped by tier because the difference is not cosmetic: a generic-tier
						    grammar parses correctly but infers structure from cross-language
						    rules, so some declarations will be missing. Listing both together
						    would imply the same fidelity. */}
						{(["verified", "generic"] as const).map((tier) => {
							const rows = (grammars ?? []).filter((g) => g.tier === tier);
							if (rows.length === 0) return null;
							return (
								<Stack key={tier} gap="xs">
									<div>
										<Text size="sm" fw={600}>
											{tier === "verified" ? t("grammarsTierVerified") : t("grammarsTierGeneric")}
										</Text>
										<Text size="xs" c="dimmed">
											{tier === "verified"
												? t("grammarsTierVerifiedHint")
												: t("grammarsTierGenericHint")}
										</Text>
									</div>
									<Table highlightOnHover>
										<Table.Thead>
											<Table.Tr>
												<Table.Th>{t("grammarsLanguage")}</Table.Th>
												<Table.Th>{t("grammarsExtensions")}</Table.Th>
												<Table.Th>{t("grammarsStatus")}</Table.Th>
												<Table.Th>{t("grammarsSize")}</Table.Th>
												<Table.Th />
											</Table.Tr>
										</Table.Thead>
										<Table.Tbody>
											{rows.map((grammar) => (
												<Table.Tr key={grammar.id}>
													<Table.Td>
														<Text size="sm">{grammar.label}</Text>
														<Text size="xs" c="dimmed">
															{grammar.id} · v{grammar.version}
														</Text>
														{grammar.note && (
															<Text size="xs" c="yellow.6" mt={2}>
																{grammar.note}
															</Text>
														)}
													</Table.Td>
													<Table.Td>
														<Text size="xs" c="dimmed">
															{grammar.extensions.join(" ")}
														</Text>
													</Table.Td>
													<Table.Td>
														{grammar.digestMismatch ? (
															<Tooltip label={t("grammarsDigestMismatchHint")}>
																<Badge color="yellow" variant="light">
																	{t("grammarsDigestMismatch")}
																</Badge>
															</Tooltip>
														) : grammar.installed ? (
															<Badge color="green" variant="light">
																{t("grammarsInstalled")}
															</Badge>
														) : (
															<Badge color="gray" variant="light">
																{t("grammarsNotInstalled")}
															</Badge>
														)}
													</Table.Td>
													<Table.Td>
														<Text size="xs" c="dimmed">
															{formatBytes(grammar.sizeBytes ?? grammar.expectedBytes)}
														</Text>
													</Table.Td>
													<Table.Td>
														<Group gap="xs" justify="flex-end">
															{(!grammar.installed || grammar.digestMismatch) && (
																<Button
																	size="xs"
																	variant="light"
																	leftSection={<IconDownload size={14} />}
																	loading={busyLang === grammar.id}
																	disabled={busyLang !== null && busyLang !== grammar.id}
																	onClick={() => void handleDownload(grammar)}
																>
																	{grammar.digestMismatch
																		? t("grammarsRedownload")
																		: t("grammarsDownload")}
																</Button>
															)}
															{grammar.installed && (
																<Button
																	size="xs"
																	variant="subtle"
																	color="red"
																	leftSection={<IconTrash size={14} />}
																	loading={busyLang === grammar.id}
																	disabled={busyLang !== null && busyLang !== grammar.id}
																	onClick={() => void handleRemove(grammar)}
																>
																	{t("grammarsRemove")}
																</Button>
															)}
														</Group>
													</Table.Td>
												</Table.Tr>
											))}
										</Table.Tbody>
									</Table>
								</Stack>
							);
						})}
					</Stack>
				)}
			</Paper>

			{/* Why a language is absent, rather than leaving the reader to assume oversight —
			    some of these break the parser and must not be re-added casually. */}
			{excluded.length > 0 && (
				<Accordion variant="contained">
					<Accordion.Item value="excluded">
						<Accordion.Control>
							<Text size="sm">{t("grammarsExcludedTitle", { count: excluded.length })}</Text>
						</Accordion.Control>
						<Accordion.Panel>
							<Stack gap="xs">
								{excluded.map((item) => (
									<div key={item.id}>
										<Text size="sm" ff="monospace">
											{item.id}
										</Text>
										<Text size="xs" c="dimmed">
											{item.reason}
										</Text>
									</div>
								))}
							</Stack>
						</Accordion.Panel>
					</Accordion.Item>
				</Accordion>
			)}

			<Text size="xs" c="dimmed">
				{t("grammarsSourceNote")}
			</Text>
		</Stack>
	);
}
