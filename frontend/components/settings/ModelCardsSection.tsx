import {
	ActionIcon,
	Badge,
	Button,
	Code,
	Divider,
	Group,
	Modal,
	NumberInput,
	Paper,
	ScrollArea,
	Select,
	Stack,
	Table,
	TagsInput,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import type { ModelCard } from "@shared/model-card";
import { IconPlus, IconRestore, IconTrash } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useDeleteModelCard,
	useModelCards,
	useResetModelCard,
	useUpsertModelCard,
} from "../../hooks/useModelCards";
import { formatLocaleNumber } from "../../lib/intl-format";
import { useConfirmDialog } from "../common/ConfirmDialogProvider";

/** Tiers a card may declare. `none` is deliberately absent — see ModelCard docs. */
const EFFORT_TIER_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

type EffortTier = (typeof EFFORT_TIER_OPTIONS)[number];

interface CardForm {
	modelKey: string;
	displayName: string;
	family: string;
	notes: string;
	aliases: string[];
	matchPrefixes: string[];
	contextWindow: number;
	maxCompletionTokens: number;
	effortLevels: string[];
	inputUsd: number;
	outputUsd: number;
	cacheReadUsd: number;
	cacheWriteUsd: number;
}

function emptyForm(): CardForm {
	return {
		modelKey: "",
		displayName: "",
		family: "",
		notes: "",
		aliases: [],
		matchPrefixes: [],
		contextWindow: 0,
		maxCompletionTokens: 0,
		effortLevels: [],
		inputUsd: 0,
		outputUsd: 0,
		cacheReadUsd: 0,
		cacheWriteUsd: 0,
	};
}

function toForm(card: ModelCard): CardForm {
	return {
		modelKey: card.modelKey,
		displayName: card.displayName ?? "",
		family: card.family ?? "",
		notes: card.notes ?? "",
		aliases: [...(card.aliases ?? [])],
		matchPrefixes: [...(card.matchPrefixes ?? [])],
		contextWindow: card.contextWindow ?? 0,
		maxCompletionTokens: card.maxCompletionTokens ?? 0,
		effortLevels: [...(card.effortLevels ?? [])],
		inputUsd: card.officialPricing?.input ?? 0,
		outputUsd: card.officialPricing?.output ?? 0,
		cacheReadUsd: card.officialPricing?.cacheRead ?? 0,
		cacheWriteUsd: card.officialPricing?.cacheWrite ?? 0,
	};
}

/**
 * Build the payload sent to the server.
 *
 * Zero/empty fields are sent as-is rather than omitted: the server diffs against
 * the builtin card, so an explicit 0 is how "clear this field" is expressed. It
 * decides what is worth storing, not this form.
 */
function fromForm(form: CardForm): ModelCard {
	return {
		modelKey: form.modelKey.trim().toLowerCase(),
		displayName: form.displayName.trim(),
		family: form.family.trim().toLowerCase(),
		notes: form.notes.trim(),
		aliases: form.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean),
		matchPrefixes: form.matchPrefixes.map((p) => p.trim().toLowerCase()).filter(Boolean),
		contextWindow: Math.max(0, Math.trunc(form.contextWindow || 0)),
		maxCompletionTokens: Math.max(0, Math.trunc(form.maxCompletionTokens || 0)),
		effortLevels: EFFORT_TIER_OPTIONS.filter((tier) =>
			form.effortLevels.includes(tier),
		) as EffortTier[],
		officialPricing: {
			input: Math.max(0, form.inputUsd || 0),
			output: Math.max(0, form.outputUsd || 0),
			cacheRead: Math.max(0, form.cacheReadUsd || 0),
			cacheWrite: Math.max(0, form.cacheWriteUsd || 0),
		},
	};
}

function formatTokens(value: number | undefined, notSetLabel: string): string {
	// Must go through intl-format: a bare toLocaleString() follows the SYSTEM locale,
	// so a zh-CN UI could render token counts in the OS's grouping instead of its own.
	return value && value > 0 ? formatLocaleNumber(value) : notSetLabel;
}

export function ModelCardsSection() {
	const { t } = useTranslation("settings");
	const { data, isLoading } = useModelCards();
	const upsert = useUpsertModelCard();
	const remove = useDeleteModelCard();
	const reset = useResetModelCard();
	const confirm = useConfirmDialog();

	const [search, setSearch] = useState("");
	const [familyFilter, setFamilyFilter] = useState<string | null>(null);
	const [opened, { open, close }] = useDisclosure(false);
	const [form, setForm] = useState<CardForm>(emptyForm());
	const [isNew, setIsNew] = useState(true);

	const cards = data?.cards ?? [];
	const provenance = data?.provenance ?? {};

	const families = useMemo(() => {
		const set = new Set(cards.map((c) => c.family).filter((f): f is string => Boolean(f)));
		return [...set].sort();
	}, [cards]);

	const rows = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return cards.filter((card) => {
			if (familyFilter && card.family !== familyFilter) return false;
			if (!needle) return true;
			return (
				card.modelKey.includes(needle) ||
				(card.displayName ?? "").toLowerCase().includes(needle) ||
				(card.aliases ?? []).some((a) => a.includes(needle)) ||
				(card.matchPrefixes ?? []).some((p) => p.includes(needle))
			);
		});
	}, [cards, search, familyFilter]);

	const patch = (next: Partial<CardForm>) => setForm((prev) => ({ ...prev, ...next }));

	function openCreate() {
		setForm(emptyForm());
		setIsNew(true);
		open();
	}

	function openEdit(card: ModelCard) {
		setForm(toForm(card));
		setIsNew(false);
		open();
	}

	/**
	 * Both destructive paths are confirmed: the buttons sit next to Edit in a dense
	 * table row, and a stray click otherwise discards hand-entered pricing, context
	 * window and prefix data with no undo.
	 */
	async function confirmRemove(card: ModelCard) {
		const ok = await confirm({
			message: t("modelCardDeleteConfirm", { model: card.modelKey }),
			confirmLabel: t("modelCardDelete"),
			confirmColor: "red",
		});
		if (ok) remove.mutate(card.modelKey);
	}

	async function confirmReset(card: ModelCard) {
		const ok = await confirm({
			message: t("modelCardResetConfirm", { model: card.modelKey }),
			confirmLabel: t("modelCardReset"),
		});
		if (ok) reset.mutate(card.modelKey);
	}

	function save() {
		upsert.mutate(fromForm(form), {
			onSuccess: () => {
				close();
				notifications.show({ message: t("modelCardSaved"), color: "green" });
			},
			onError: (err: Error) =>
				notifications.show({ title: t("modelCardSaveFailed"), message: err.message, color: "red" }),
		});
	}

	return (
		<Stack>
			<Group justify="space-between" align="flex-start">
				<div>
					<Text fw={600}>{t("modelCardsTitle")}</Text>
					<Text size="sm" c="dimmed">
						{t("modelCardsDesc")}
					</Text>
				</div>
				<Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
					{t("modelCardAdd")}
				</Button>
			</Group>

			<Paper withBorder p="sm">
				<Stack gap="sm">
					<Group>
						<TextInput
							placeholder={t("modelCardSearchPlaceholder")}
							value={search}
							onChange={(e) => setSearch(e.currentTarget.value)}
							w={280}
						/>
						<Select
							placeholder={t("modelCardAllFamilies")}
							clearable
							data={families}
							value={familyFilter}
							onChange={setFamilyFilter}
							w={180}
						/>
						<Text size="xs" c="dimmed">
							{t("modelCardCount", { shown: rows.length, total: cards.length })}
						</Text>
					</Group>

					<ScrollArea.Autosize mah={520}>
						<Table striped highlightOnHover withTableBorder={false}>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t("modelCardKey")}</Table.Th>
									<Table.Th>{t("modelCardFamily")}</Table.Th>
									<Table.Th>{t("modelCardContextWindow")}</Table.Th>
									<Table.Th>{t("modelCardEffortLevels")}</Table.Th>
									<Table.Th>{t("modelCardOfficialPrice")}</Table.Th>
									<Table.Th>{t("modelCardActions")}</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{isLoading && (
									<Table.Tr>
										<Table.Td colSpan={6}>
											<Text size="sm" c="dimmed">
												{t("modelCardLoading")}
											</Text>
										</Table.Td>
									</Table.Tr>
								)}
								{!isLoading && rows.length === 0 && (
									<Table.Tr>
										<Table.Td colSpan={6}>
											<Text size="sm" c="dimmed">
												{t("modelCardEmpty")}
											</Text>
										</Table.Td>
									</Table.Tr>
								)}
								{rows.map((card) => {
									const edited = provenance[card.modelKey] ?? [];
									return (
										<Table.Tr key={card.modelKey}>
											<Table.Td>
												<Group gap="xs" wrap="nowrap">
													<Code>{card.modelKey}</Code>
													{card.builtin && (
														<Badge size="xs" variant="light" color="gray">
															{t("modelCardBuiltin")}
														</Badge>
													)}
													{edited.length > 0 && (
														<Tooltip label={edited.join(", ")}>
															<Badge size="xs" variant="light" color="indigo">
																{t("modelCardEdited")}
															</Badge>
														</Tooltip>
													)}
												</Group>
											</Table.Td>
											<Table.Td>
												<Text size="sm">{card.family || "-"}</Text>
											</Table.Td>
											<Table.Td>
												<Text size="sm">
													{formatTokens(card.contextWindow, t("modelCardNotSet"))}
												</Text>
											</Table.Td>
											<Table.Td>
												{card.effortLevels?.length ? (
													<Group gap={4} wrap="nowrap">
														{card.effortLevels.map((level) => (
															<Badge key={level} size="xs" variant="light">
																{level}
															</Badge>
														))}
													</Group>
												) : (
													<Text size="xs" c="dimmed">
														{t("modelCardNotSet")}
													</Text>
												)}
											</Table.Td>
											<Table.Td>
												<Text size="sm">
													{(card.officialPricing?.input ?? 0) > 0 ||
													(card.officialPricing?.output ?? 0) > 0
														? `$${(card.officialPricing?.input ?? 0).toFixed(2)} / $${(
																card.officialPricing?.output ?? 0
															).toFixed(2)}`
														: t("modelCardNotSet")}
												</Text>
											</Table.Td>
											<Table.Td>
												<Group gap="xs" wrap="nowrap">
													<Button size="compact-xs" variant="subtle" onClick={() => openEdit(card)}>
														{t("modelCardEdit")}
													</Button>
													{edited.length > 0 && (
														<Tooltip label={t("modelCardResetTooltip")}>
															<ActionIcon variant="subtle" onClick={() => void confirmReset(card)}>
																<IconRestore size={16} />
															</ActionIcon>
														</Tooltip>
													)}
													<Tooltip label={t("modelCardDelete")}>
														<ActionIcon
															variant="subtle"
															color="red"
															onClick={() => void confirmRemove(card)}
														>
															<IconTrash size={16} />
														</ActionIcon>
													</Tooltip>
												</Group>
											</Table.Td>
										</Table.Tr>
									);
								})}
							</Table.Tbody>
						</Table>
					</ScrollArea.Autosize>
				</Stack>
			</Paper>

			<Modal
				opened={opened}
				onClose={close}
				title={isNew ? t("modelCardAdd") : `${t("modelCardEdit")} ${form.modelKey}`}
				size="xl"
			>
				<Stack gap="sm">
					<Group grow>
						<TextInput
							label={t("modelCardKey")}
							description={t("modelCardKeyDesc")}
							value={form.modelKey}
							disabled={!isNew}
							onChange={(e) => patch({ modelKey: e.currentTarget.value })}
						/>
						<TextInput
							label={t("modelCardFamily")}
							placeholder={t("modelCardFamilyPlaceholder")}
							value={form.family}
							onChange={(e) => patch({ family: e.currentTarget.value })}
						/>
					</Group>
					<TextInput
						label={t("modelCardDisplayName")}
						value={form.displayName}
						onChange={(e) => patch({ displayName: e.currentTarget.value })}
					/>
					<Textarea
						label={t("modelCardNotes")}
						autosize
						minRows={1}
						value={form.notes}
						onChange={(e) => patch({ notes: e.currentTarget.value })}
					/>

					<Divider label={t("modelCardMatchRules")} labelPosition="left" />
					<Text size="xs" c="dimmed">
						{t("modelCardMatchRulesDesc")}
					</Text>
					<Group grow align="flex-start">
						<TagsInput
							label={t("modelCardAliases")}
							description={t("modelCardAliasesDesc")}
							value={form.aliases}
							onChange={(v) => patch({ aliases: v })}
						/>
						<TagsInput
							label={t("modelCardMatchPrefixes")}
							description={t("modelCardMatchPrefixesDesc")}
							value={form.matchPrefixes}
							onChange={(v) => patch({ matchPrefixes: v })}
						/>
					</Group>

					<Divider label={t("modelCardCapabilities")} labelPosition="left" />
					<Group grow>
						<NumberInput
							label={t("modelCardContextWindow")}
							description={t("modelCardZeroMeansInherit")}
							value={form.contextWindow}
							min={0}
							step={1000}
							decimalScale={0}
							thousandSeparator=","
							onChange={(v) => patch({ contextWindow: Number(v) || 0 })}
						/>
						<NumberInput
							label={t("modelCardMaxCompletionTokens")}
							description={t("modelCardZeroMeansInherit")}
							value={form.maxCompletionTokens}
							min={0}
							step={1000}
							decimalScale={0}
							thousandSeparator=","
							onChange={(v) => patch({ maxCompletionTokens: Number(v) || 0 })}
						/>
					</Group>
					<TagsInput
						label={t("modelCardEffortLevels")}
						description={t("modelCardEffortLevelsDesc")}
						data={[...EFFORT_TIER_OPTIONS]}
						value={form.effortLevels}
						onChange={(v) => patch({ effortLevels: v })}
					/>

					<Divider label={t("modelCardOfficialPriceSection")} labelPosition="left" />
					<Group grow>
						<NumberInput
							label={t("modelCardPriceInput")}
							value={form.inputUsd}
							min={0}
							decimalScale={4}
							onChange={(v) => patch({ inputUsd: Number(v) || 0 })}
						/>
						<NumberInput
							label={t("modelCardPriceOutput")}
							value={form.outputUsd}
							min={0}
							decimalScale={4}
							onChange={(v) => patch({ outputUsd: Number(v) || 0 })}
						/>
					</Group>
					<Group grow>
						<NumberInput
							label={t("modelCardPriceCacheRead")}
							value={form.cacheReadUsd}
							min={0}
							decimalScale={4}
							onChange={(v) => patch({ cacheReadUsd: Number(v) || 0 })}
						/>
						<NumberInput
							label={t("modelCardPriceCacheWrite")}
							description={t("modelCardPriceCacheWriteDesc")}
							value={form.cacheWriteUsd}
							min={0}
							decimalScale={4}
							onChange={(v) => patch({ cacheWriteUsd: Number(v) || 0 })}
						/>
					</Group>

					<Group justify="flex-end">
						<Button variant="default" onClick={close}>
							{t("cancel")}
						</Button>
						<Button loading={upsert.isPending} disabled={!form.modelKey.trim()} onClick={save}>
							{t("save")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
