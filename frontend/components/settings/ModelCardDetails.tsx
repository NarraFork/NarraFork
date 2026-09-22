import { Accordion, Badge, Group, Stack, Table, Text } from "@mantine/core";
import type { JSONValue, ModelCard, PriceRow } from "@shared/model-catalog/card";
import { useTranslation } from "react-i18next";
import { formatLocaleNumber } from "../../lib/intl-format";

/** Absent, explicit null, false and empty arrays are distinct and must stay distinct. */
export function cardValueText(
	value: JSONValue | undefined,
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	if (value === undefined) return t("card.unreported");
	if (value === null) return t("card.unknown");
	if (typeof value === "boolean") return t(`card.values.${value}`);
	if (Array.isArray(value)) return value.length ? value.join(", ") : t("card.emptyList");
	if (typeof value === "number") return formatLocaleNumber(value);
	if (typeof value === "object") return JSON.stringify(value);
	return value;
}

/** Token counts read better compact, but the exact number must stay reachable. */
function TokenValue({ value }: { value: JSONValue | undefined }) {
	const { t } = useTranslation("settings");
	const text = cardValueText(value, t);
	if (typeof value !== "number") return <>{text}</>;
	const compact =
		value >= 1000 ? `${formatLocaleNumber(Math.round(value / 1000))}k` : formatLocaleNumber(value);
	return <span title={text}>{compact}</span>;
}

/** A rate is per source unit; only token rates are shown per 1M. Null is explicit unknown. */
function rateText(
	row: PriceRow,
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	if (row.rate === null) return t("card.unknown");
	if (row.rate === "0") return t("card.free");
	const amount = row.displayRate ?? row.rate;
	const per =
		row.displayQuantity > 1
			? t("card.perTokens", { count: row.displayQuantity / 1_000_000 })
			: t(`card.units.${row.unit}`, { defaultValue: row.unit });
	return `${amount} ${row.currency} / ${per}`;
}

function PriceTable({ card }: { card: ModelCard }) {
	const { t } = useTranslation("settings");
	if (!card.view.prices.length) return <Text c="dimmed">{t("card.noPrices")}</Text>;
	return (
		<Stack gap="md">
			<Text size="xs" c="dimmed">
				{t("card.priceNote")}
			</Text>
			{card.view.prices.map((group) => (
				<Stack key={group.tier} gap={4}>
					<Group gap="xs">
						<Text size="sm" fw={500}>
							{t(`card.tiers.${group.tier}`, { defaultValue: group.tier })}
						</Text>
						{card.view.pricingBasis && group.rows.some((row) => row.thresholdTokens !== null) && (
							<Badge size="xs" variant="light">
								{t(`card.basis.${card.view.pricingBasis}`, {
									defaultValue: card.view.pricingBasis,
								})}
							</Badge>
						)}
					</Group>
					<Table verticalSpacing={4} data-price-tier={group.tier}>
						<Table.Thead>
							<Table.Tr>
								{["component", "modality", "threshold", "cache", "rate"].map((key) => (
									<Table.Th key={key}>{t(`card.price_${key}`)}</Table.Th>
								))}
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{group.rows.map((row) => (
								<Table.Tr key={row.key} data-price-row={row.key}>
									<Table.Td>
										{t(`card.components.${row.component}`, { defaultValue: row.component })}
										{row.derived && (
											<Badge size="xs" ml={4} variant="outline">
												{t("card.derived")}
											</Badge>
										)}
									</Table.Td>
									<Table.Td>
										{t(`card.modalities.${row.modality}`, { defaultValue: row.modality })}
									</Table.Td>
									<Table.Td>
										{row.thresholdTokens === null ? (
											t("card.noThreshold")
										) : (
											<TokenValue value={row.thresholdTokens} />
										)}
									</Table.Td>
									<Table.Td>
										{row.cacheDuration === null
											? "—"
											: t(`card.cache.${row.cacheDuration}`, { defaultValue: row.cacheDuration })}
									</Table.Td>
									<Table.Td>{rateText(row, t)}</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Stack>
			))}
		</Stack>
	);
}

/**
 * Read-only v2 card view shared by the settings page and the in-chat details.
 * It renders the resolved card only; it never derives a value the card omits and
 * never displays a gateway billing rule as a reference price.
 */
export function ModelCardDetails({ card }: { card: ModelCard }) {
	const { t } = useTranslation("settings");
	const groups = ["identity", "limits", "modalities", "capabilities", "reasoning"] as const;
	const attributes = Object.entries(card.view.attributes);
	return (
		<Stack gap="sm" data-model-card={card.modelId ?? card.variantId ?? ""}>
			<Group gap="xs">
				<Badge variant="light">
					{t(`card.categories.${card.view.category}`, { defaultValue: card.view.category })}
				</Badge>
				{card.view.mode && <Badge variant="outline">{card.view.mode}</Badge>}
				<Text size="xs" c="dimmed">
					{t("card.resolvedVia", {
						via: t(`card.via.${card.matchedVia}`, { defaultValue: card.matchedVia }),
						version: card.catalogVersion,
						revision: card.localRevision,
					})}
				</Text>
			</Group>
			<Table verticalSpacing={4}>
				<Table.Tbody>
					{(
						[
							["maxInputTokens", card.view.limits.maxInputTokens],
							["maxOutputTokens", card.view.limits.maxOutputTokens],
							["totalContextTokens", card.view.limits.totalContextTokens],
							["workingContextTokens", card.view.limits.workingContextTokens],
						] as const
					).map(([key, value]) => (
						<Table.Tr key={key} data-card-limit={key}>
							<Table.Td>
								<Text size="sm">{t(`card.limits.${key}`)}</Text>
								<Text size="xs" c="dimmed">
									{t(`card.limitHints.${key}`)}
								</Text>
							</Table.Td>
							<Table.Td>
								<TokenValue value={value} />
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
			<Accordion multiple defaultValue={["prices"]}>
				<Accordion.Item value="prices">
					<Accordion.Control>{t("card.prices")}</Accordion.Control>
					<Accordion.Panel>
						<PriceTable card={card} />
					</Accordion.Panel>
				</Accordion.Item>
				{groups.map((group) => {
					const fields = card.view.fields.filter((field) => field.group === group);
					if (!fields.length) return null;
					return (
						<Accordion.Item key={group} value={group}>
							<Accordion.Control>{t(`card.groups.${group}`)}</Accordion.Control>
							<Accordion.Panel>
								<Table verticalSpacing={4}>
									<Table.Tbody>
										{fields.map((field) => (
											<Table.Tr key={field.key} data-card-field={field.key}>
												<Table.Td>
													<Text size="sm">
														{t(`card.fields.${field.key}`, { defaultValue: field.key })}
													</Text>
													<Text size="xs" c="dimmed">
														{field.key}
														{field.unit ? ` · ${field.unit}` : ""}
													</Text>
												</Table.Td>
												<Table.Td>
													<Group gap={4}>
														<Text size="sm">{cardValueText(field.value, t)}</Text>
														{card.provenance[field.key]?.layer.startsWith("local-") && (
															<Badge size="xs" variant="outline">
																{t("card.localOverride")}
															</Badge>
														)}
													</Group>
												</Table.Td>
											</Table.Tr>
										))}
									</Table.Tbody>
								</Table>
							</Accordion.Panel>
						</Accordion.Item>
					);
				})}
				{!!attributes.length && (
					<Accordion.Item value="attributes">
						<Accordion.Control>
							{t("card.attributes")} ({attributes.length})
						</Accordion.Control>
						<Accordion.Panel>
							<Stack gap={4}>
								<Text size="xs" c="dimmed">
									{t("card.attributeNote")}
								</Text>
								{attributes.map(([key, value]) => (
									<Text key={key} size="xs" style={{ overflowWrap: "anywhere" }}>
										{key}: {cardValueText(value, t)}
									</Text>
								))}
							</Stack>
						</Accordion.Panel>
					</Accordion.Item>
				)}
			</Accordion>
		</Stack>
	);
}
