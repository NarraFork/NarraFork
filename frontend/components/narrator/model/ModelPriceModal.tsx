import { Alert, Badge, Button, Divider, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../../hooks/useAuth";
import { useActualResolvedModel, useModelCatalog } from "../../../hooks/useModelCatalog";
import type { ModelOption } from "../../../lib/constants";
import { formatLocaleNumber } from "../../../lib/intl-format";
import { resolveCatalogEntry } from "../../../lib/model-catalog-view";
import { Z } from "../../../lib/z-index";
import {
	type CatalogEditorTarget,
	CatalogMetadataFields,
	ModelCatalogEditor,
} from "../../settings/ModelCatalogEditor";

/** Format a per-1M-token RMB price, trimming trailing zeros (max 6 decimals). */
function fmtPrice(value: number | string | undefined, unit: string): string {
	if (value == null) return "—";
	const n = Number(value);
	if (!Number.isFinite(n)) return "—";
	// Fixed 6-decimal precision preserves tiny per-token prices; trimming the
	// trailing zeros avoids noise like "30.000000" for round prices.
	const fixed = n.toFixed(6).replace(/\.?0+$/, "");
	return `${fixed} ${unit}`;
}

function fmtTokenUnit(unit: number | undefined): string {
	const n = Number(unit ?? 1_000_000);
	if (n === 1_000_000) return "1M";
	return formatLocaleNumber(n);
}

function PriceRow({ label, value }: { label: string; value: string }) {
	return (
		<Group justify="space-between" gap="xs" wrap="nowrap">
			<Text size="sm" c="dimmed">
				{label}
			</Text>
			<Text size="sm" fw={500}>
				{value}
			</Text>
		</Group>
	);
}

/**
 * Read-only price details for a NUG model. The billing truth is the RMB
 * per-1M-token price; official USD price / exchange rate / discount are
 * auxiliary display values.
 */
export function ModelPriceModal({
	model,
	opened,
	onClose,
}: {
	model: ModelOption | null;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const { data: user } = useCurrentUser();
	const catalog = useModelCatalog(opened);
	const actual = useActualResolvedModel(opened ? model?.value : undefined);
	const [editor, setEditor] = useState<CatalogEditorTarget | null>(null);
	const readOnly = user?.role !== "admin";
	const pricing = model?.pricing;
	const referencePrice = (value: string | null | undefined) =>
		value === undefined
			? ts("catalog.unreported")
			: value === null
				? ts("catalog.unknown")
				: value === "0"
					? ts("catalog.free")
					: value;
	// Only the fallback is translated — a unitName the gateway reported is the
	// billing currency and must be shown verbatim.
	const unit = pricing?.unitName ?? t("modelPrice.unitFallback");
	const tokenUnit = pricing?.tokenUnit;
	const isCredit = pricing?.billingMode === "credit";
	const usdRate = Number(model?.usdRate ?? 0);
	const mult = Number(model?.channelMultiplier ?? 1) || 1;

	// Actual discount = effective RMB input price / (official USD input × rate).
	// Circle multiplier = actual discount × rate (assuming 1 balance = 1 USD).
	let discount = "";
	let circleMultiplier = "";
	if (!isCredit) {
		const usd = Number(actual.data?.metadata.referencePricing?.input);
		const rmb = Number(pricing?.input ?? 0);
		if (usd > 0 && usdRate > 0) {
			const d = (rmb * mult) / (usd * usdRate);
			if (d > 0) {
				discount = `${d.toFixed(2)}x`;
				circleMultiplier = `${(d * usdRate).toFixed(2)}x`;
			}
		}
	}

	return (
		<Modal
			opened={opened}
			onClose={() => {
				setEditor(null);
				onClose();
			}}
			title={model?.label ?? t("modelPrice.title")}
			centered
			size="md"
			zIndex={Z.modal}
		>
			<Stack gap="sm" mb="md">
				{actual.isFetching && <Loader size="sm" />}
				{actual.error && <Alert color="red">{actual.error.message}</Alert>}
				{actual.data && (
					<>
						<Text size="xs" c="dimmed">
							{ts("catalog.resolvedVia", {
								via: actual.data.matchedVia,
								version: actual.data.catalogVersion,
								revision: actual.data.localRevision,
							})}
						</Text>
						{actual.data.matchedVia === "none" && <Text size="sm">{ts("catalog.noMatch")}</Text>}
						<Text size="sm">
							{ts("catalog.reference")}:{" "}
							{referencePrice(actual.data.metadata.referencePricing?.input)} /{" "}
							{referencePrice(actual.data.metadata.referencePricing?.output)}
						</Text>
						<CatalogMetadataFields resolved={actual.data} edits={{}} onChange={() => {}} readOnly />
						<Group>
							<Button
								size="xs"
								variant="light"
								disabled={!catalog.data}
								onClick={() => {
									const resolved = actual.data;
									if (!resolved) return;
									setEditor({
										kind: "binding",
										id: resolved.bindingId ?? "",
										isNew: !resolved.bindingId,
										resolved,
										query: resolved.resolvedQuery,
									});
								}}
							>
								{ts("catalog.editBinding")}
							</Button>
							{actual.data.variantId && (
								<Button
									size="xs"
									variant="subtle"
									disabled={!catalog.data}
									onClick={() => {
										const resolved = actual.data;
										const snapshot = catalog.data;
										const variant = [
											...(snapshot?.local.variants ?? []),
											...(snapshot?.catalog.variants ?? []),
										].find((entry) => entry.id === resolved?.variantId);
										if (snapshot && variant)
											setEditor({
												kind: "variant",
												id: variant.id,
												modelId: variant.modelId,
												resolved: resolveCatalogEntry(snapshot, variant),
											});
									}}
								>
									{ts("catalog.editVariant")}
								</Button>
							)}
						</Group>
					</>
				)}
				<Divider label={ts("catalog.actualPricing")} />
			</Stack>
			{!model || !pricing ? (
				<Text size="sm" c="dimmed">
					{t("modelPrice.unavailable")}
				</Text>
			) : (
				<Stack gap="sm">
					<Group gap="xs">
						{model.channel && (
							<Badge variant="light" color="gray">
								{model.channel}
							</Badge>
						)}
						<Badge variant="light" color={isCredit ? "violet" : "blue"}>
							{isCredit ? t("modelPrice.billingCredit") : t("modelPrice.billingToken")}
						</Badge>
						{model.contextWindow != null && model.contextWindow > 0 && (
							<Text size="xs" c="dimmed">
								{t("modelPrice.context", {
									tokens: formatLocaleNumber(Math.trunc(model.contextWindow)),
								})}
							</Text>
						)}
					</Group>

					{isCredit ? (
						<PriceRow
							label={t("modelPrice.creditUnitPrice")}
							value={fmtPrice(pricing.credit, unit)}
						/>
					) : (
						<Stack gap={4}>
							<Text size="xs" c="dimmed">
								{t("modelPrice.unitPriceHeading", {
									unit,
									tokenUnit: fmtTokenUnit(tokenUnit),
								})}
							</Text>
							<PriceRow label={t("modelPrice.input")} value={fmtPrice(pricing.input, unit)} />
							<PriceRow label={t("modelPrice.output")} value={fmtPrice(pricing.output, unit)} />
							{pricing.cacheCreationInput != null && (
								<PriceRow
									label={t("modelPrice.cacheWrite")}
									value={fmtPrice(pricing.cacheCreationInput, unit)}
								/>
							)}
							{pricing.cacheReadInput != null && (
								<PriceRow
									label={t("modelPrice.cacheRead")}
									value={fmtPrice(pricing.cacheReadInput, unit)}
								/>
							)}
							{usdRate > 0 && (
								<PriceRow
									label={t("modelPrice.referenceRate")}
									value={`1 USD = ${usdRate} ${unit}`}
								/>
							)}
							{discount && <PriceRow label={t("modelPrice.effectiveDiscount")} value={discount} />}
							{circleMultiplier && (
								<PriceRow label={t("modelPrice.circleMultiplier")} value={circleMultiplier} />
							)}
						</Stack>
					)}

					<Text size="xs" c="dimmed">
						{t("modelPrice.footnote", { unit })}
					</Text>
				</Stack>
			)}
			{editor && catalog.data && (
				<ModelCatalogEditor
					key={`${editor.kind}:${editor.id}`}
					target={editor}
					snapshot={catalog.data}
					readOnly={readOnly}
					onClose={() => setEditor(null)}
				/>
			)}
		</Modal>
	);
}
