import {
	Button,
	type ComboboxData,
	Group,
	Modal,
	type OptionsFilter,
	Select,
	Stack,
	Text,
} from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelOptions } from "../../../hooks/useModelCatalog";

/** The selected reference is independent of the bounded directory page. */
export function SetGlobalModelModal({
	opened,
	mode,
	currentValue,
	saving,
	onClose,
	onConfirm,
	title,
	confirmLabel,
	children,
}: {
	opened: boolean;
	mode: "default" | "summary" | null;
	/** Legacy caller compatibility; never read/download the full directory for this modal. */
	groupedModels: ComboboxData;
	modelOptionsFilter?: OptionsFilter<string>;
	currentValue: string | null | undefined;
	saving: boolean;
	onClose: () => void;
	onConfirm: (model: string) => void;
	title?: ReactNode;
	confirmLabel?: ReactNode;
	children?: ReactNode;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const [selected, setSelected] = useState<string | null>(null);
	const [dropdownOpened, setDropdownOpened] = useState(false);
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const [cursor, setCursor] = useState<string>();
	const [composing, setComposing] = useState(false);
	useEffect(() => {
		if (!opened) {
			setDropdownOpened(false);
			return;
		}
		setSelected(currentValue ?? null);
		setSearch("");
		setQ("");
		setCursor(undefined);
	}, [opened, currentValue]);
	useEffect(() => {
		if (composing || !opened) return;
		const timer = setTimeout(() => {
			setQ(search);
			setCursor(undefined);
		}, 180);
		return () => clearTimeout(timer);
	}, [search, composing, opened]);
	const query = useModelOptions(
		{ q, cursor },
		opened && dropdownOpened && !composing && search === q,
	);
	const items = search === q ? (query.data?.items ?? []) : [];
	const data = items.map(({ value, label, provider }) => ({
		value,
		label: provider ? `${provider}: ${label}` : label,
	}));
	if (selected && !data.some((row) => row.value === selected))
		data.unshift({ value: selected, label: selected });
	if (mode === "summary" && !data.some((row) => row.value === "__default__"))
		data.unshift({ value: "__default__", label: t("followDefault", { model: "" }) });
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={title ?? (mode === "summary" ? t("editSummaryModel") : t("editDefaultModel"))}
			centered
			size="md"
		>
			<Stack gap="md">
				{children}
				<Select
					data={data}
					searchable
					filter={({ options }) => options}
					placeholder={t("modelFilterPlaceholder")}
					value={selected}
					onChange={setSelected}
					searchValue={search}
					onSearchChange={setSearch}
					dropdownOpened={dropdownOpened}
					onDropdownOpen={() => setDropdownOpened(true)}
					onDropdownClose={() => setDropdownOpened(false)}
					onCompositionStart={() => setComposing(true)}
					onCompositionEnd={() => setComposing(false)}
					comboboxProps={{ withinPortal: true }}
					nothingFoundMessage={query.isFetching ? tc("loading") : t("noModelMatches")}
				/>
				{query.error && (
					<Text size="xs" c="red" role="alert">
						{query.error.message}
					</Text>
				)}
				<Group justify="space-between">
					{cursor && (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => {
								setCursor(undefined);
								setDropdownOpened(true);
							}}
						>
							{tc("back")}
						</Button>
					)}
					{query.data?.hasMore && (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => {
								setCursor(query.data?.nextCursor ?? undefined);
								setDropdownOpened(true);
							}}
						>
							{t("contextComposition.loadMore")}
						</Button>
					)}
					{query.error && (
						<Button
							variant="subtle"
							size="xs"
							onClick={() => {
								if (cursor) setCursor(undefined);
								else void query.refetch();
							}}
						>
							{tc("retry")}
						</Button>
					)}
				</Group>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose} disabled={saving}>
						{t("cancel")}
					</Button>
					<Button
						onClick={() => selected && onConfirm(selected)}
						disabled={!selected || saving}
						loading={saving}
					>
						{confirmLabel ?? t("confirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
