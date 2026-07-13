import {
	Badge,
	Box,
	Button,
	Card,
	Divider,
	Grid,
	Group,
	Loader,
	Paper,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	ThemeIcon,
	Title,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconArrowRight,
	IconBook2,
	IconBulb,
	IconChecklist,
	IconChevronDown,
	IconChevronRight,
	IconFolder,
	IconInfoCircle,
	IconSearch,
	IconSparkles,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type LearningCategory, type LearningDocSummary } from "../lib/api";
import { normalizeLanguage } from "../lib/i18n";

interface LearnSearchParams {
	doc?: string;
	q?: string;
}

export const Route = createFileRoute("/learn")({
	validateSearch: (search: Record<string, unknown>): LearnSearchParams => ({
		doc: typeof search.doc === "string" ? search.doc : undefined,
		q: typeof search.q === "string" ? search.q : undefined,
	}),
	component: LearnPage,
});

const LEARNING_QUERY_GC_TIME_MS = 60_000;

function LearnPage() {
	const { t, i18n } = useTranslation("learning");
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const lang = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
	const query = search.q ?? "";
	const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(() => new Set());

	const { data: index, isLoading: indexLoading } = useQuery({
		queryKey: ["learning", "index", lang],
		queryFn: () => api.getLearningIndex(lang),
		gcTime: LEARNING_QUERY_GC_TIME_MS,
	});

	const filteredDocs = useMemo(() => {
		const docs = index?.docs ?? [];
		const q = query.trim().toLowerCase();
		return docs.filter((doc) => {
			if (!q) return true;
			return [doc.title, doc.summary, doc.id, doc.category, ...doc.tags]
				.join("\n")
				.toLowerCase()
				.includes(q);
		});
	}, [index?.docs, query]);

	const docsByCategory = useMemo(() => {
		if (!index) return [];
		const byCategory = new Map<string, LearningDocSummary[]>();
		for (const doc of filteredDocs) {
			const docs = byCategory.get(doc.category) ?? [];
			docs.push(doc);
			byCategory.set(doc.category, docs);
		}

		const knownCategories = new Set(index.categories.map((category) => category.id));
		const grouped = index.categories.map((category) => ({
			category,
			docs: byCategory.get(category.id) ?? [],
		}));

		for (const [categoryId, docs] of byCategory) {
			if (knownCategories.has(categoryId)) continue;
			grouped.push({
				category: { id: categoryId, label: categoryId, description: "" },
				docs,
			});
		}

		return grouped.filter((group) => group.docs.length > 0);
	}, [filteredDocs, index]);

	const selectedId = search.doc ?? filteredDocs[0]?.id;
	const selectedSummary = filteredDocs.find((doc) => doc.id === selectedId) ?? filteredDocs[0];
	const effectiveDocId = selectedSummary?.id;

	useEffect(() => {
		if (!index || !search.doc || index.docs.some((doc) => doc.id === search.doc)) return;
		void navigate({ search: (prev) => ({ ...prev, doc: undefined }) });
	}, [index, navigate, search.doc]);

	const { data: doc, isLoading: docLoading } = useQuery({
		queryKey: ["learning", "doc", effectiveDocId, lang],
		queryFn: () => api.getLearningDoc(effectiveDocId ?? "", lang),
		enabled: !!effectiveDocId,
		gcTime: LEARNING_QUERY_GC_TIME_MS,
	});

	const selectDoc = (id: string) => {
		void navigate({ search: (prev) => ({ ...prev, doc: id }) });
	};

	const setQuery = (value: string) => {
		void navigate({ search: (prev) => ({ ...prev, q: value || undefined, doc: undefined }) });
	};

	const toggleCategory = (categoryId: string) => {
		setCollapsedCategoryIds((previous) => {
			const next = new Set(previous);
			if (next.has(categoryId)) {
				next.delete(categoryId);
			} else {
				next.add(categoryId);
			}
			return next;
		});
	};

	if (indexLoading) return <Loader />;

	return (
		<Stack gap="md" className="nf-blur-in-enter">
			<Paper withBorder p="xl" radius="lg" className="learn-hero">
				<Group gap="md" align="flex-start" wrap="nowrap">
					<ThemeIcon variant="gradient" gradient={{ from: "indigo", to: "violet" }} size="xl">
						<IconBook2 size={24} />
					</ThemeIcon>
					<Box maw={760}>
						<Title order={1} lh={1.1}>
							{t("title")}
						</Title>
						<Text c="dimmed" mt="sm" size="lg" maw={680}>
							{t("subtitle")}
						</Text>
					</Box>
				</Group>
			</Paper>

			<Grid gap="md">
				<Grid.Col span={{ base: 12, md: 4 }}>
					<Card withBorder p={0} radius="lg" className="learn-panel learn-doc-list">
						<Box p="md" pb="sm">
							<TextInput
								leftSection={<IconSearch size={16} />}
								placeholder={t("searchPlaceholder")}
								value={query}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
						</Box>
						<ScrollArea h={640}>
							<Stack gap={2} px="xs" pb="xs">
								{filteredDocs.length === 0 ? (
									<Text c="dimmed" p="md">
										{t("noResults")}
									</Text>
								) : (
									docsByCategory.map(({ category, docs }) => {
										const hasActiveDoc = docs.some((item) => item.id === effectiveDocId);
										const opened = hasActiveDoc || !collapsedCategoryIds.has(category.id);

										return (
											<TreeCategory
												key={category.id}
												category={category}
												docs={docs}
												opened={opened}
												activeDocId={effectiveDocId}
												onToggle={() => toggleCategory(category.id)}
												onSelectDoc={selectDoc}
											/>
										);
									})
								)}
							</Stack>
						</ScrollArea>
					</Card>
				</Grid.Col>

				<Grid.Col span={{ base: 12, md: 8 }}>
					<Card withBorder p="xl" radius="lg" className="learn-panel learn-content">
						{docLoading ? (
							<Loader />
						) : doc ? (
							<Stack gap="lg">
								<Box>
									<Group gap="xs" mb="sm">
										{doc.tags.map((tag) => (
											<Badge key={tag} variant="light" color="gray">
												{tag}
											</Badge>
										))}
									</Group>
									<Title order={2}>{doc.title}</Title>
									<Text c="dimmed" mt="xs">
										{doc.summary}
									</Text>
								</Box>

								{doc.actions.length > 0 && (
									<Paper withBorder p="md" radius="md" className="learn-callout">
										<Text fw={700} mb="sm">
											{t("jumpToFeature")}
										</Text>
										<Group gap="sm">
											{doc.actions.map((action) => (
												<Button
													key={`${action.href}:${action.label}`}
													component="a"
													href={action.href}
													variant="light"
													rightSection={<IconArrowRight size={14} />}
												>
													{action.label}
												</Button>
											))}
										</Group>
									</Paper>
								)}

								<Divider />

								{doc.sections.map((section) => (
									<Box key={section.title}>
										<Title order={3} mb="xs">
											{section.title}
										</Title>
										<Text>{section.body}</Text>
									</Box>
								))}

								<LearningList
									icon={<IconChecklist size={18} />}
									title={t("workflow")}
									items={doc.workflow}
									ordered
								/>
								<LearningList
									icon={<IconBulb size={18} />}
									title={t("bestPractices")}
									items={doc.bestPractices}
								/>
								<LearningList
									icon={<IconAlertTriangle size={18} />}
									title={t("pitfalls")}
									items={doc.pitfalls}
									color="orange"
								/>
							</Stack>
						) : (
							<Text c="dimmed">{t("selectDoc")}</Text>
						)}
					</Card>
				</Grid.Col>
			</Grid>

			<style>{`
				.learn-hero {
					position: relative;
					overflow: hidden;
					background:
						radial-gradient(circle at top left, color-mix(in srgb, var(--mantine-color-indigo-6) 18%, transparent), transparent 34rem),
						radial-gradient(circle at 85% 10%, color-mix(in srgb, var(--mantine-color-violet-6) 14%, transparent), transparent 26rem),
						light-dark(var(--mantine-color-white), var(--mantine-color-dark-7));
					border-color: light-dark(var(--mantine-color-indigo-1), var(--mantine-color-dark-4));
				}

				.learn-panel {
					background: light-dark(var(--mantine-color-white), var(--mantine-color-dark-7));
					border-color: light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4));
					box-shadow: 0 10px 30px light-dark(rgba(15, 23, 42, 0.06), rgba(0, 0, 0, 0.22));
				}

				.learn-content {
					background:
						linear-gradient(180deg, color-mix(in srgb, var(--mantine-color-indigo-6) 5%, transparent), transparent 12rem),
						light-dark(var(--mantine-color-white), var(--mantine-color-dark-7));
				}

				.learn-callout {
					background: light-dark(var(--mantine-color-indigo-0), color-mix(in srgb, var(--mantine-color-indigo-9) 24%, var(--mantine-color-dark-7)));
					border-color: light-dark(var(--mantine-color-indigo-2), var(--mantine-color-indigo-9));
				}

				.learn-tree-children {
					margin-left: 18px;
					padding-left: 8px;
					border-left: 1px dashed light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4));
				}

				.learn-category,
				.learn-doc-item {
					border-radius: var(--mantine-radius-sm);
					transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
				}

				.learn-category:hover,
				.learn-doc-item:hover {
					background: light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6));
				}

				.learn-category[data-active="true"],
				.learn-doc-item[data-active="true"] {
					background: linear-gradient(90deg, var(--mantine-color-indigo-light), transparent);
					border-color: var(--mantine-color-indigo-5);
				}
			`}</style>
		</Stack>
	);
}

function TreeCategory({
	category,
	docs,
	opened,
	activeDocId,
	onToggle,
	onSelectDoc,
}: {
	category: LearningCategory;
	docs: LearningDocSummary[];
	opened: boolean;
	activeDocId?: string;
	onToggle: () => void;
	onSelectDoc: (id: string) => void;
}) {
	return (
		<Box className="learn-tree-group">
			<Box
				component="button"
				type="button"
				className="learn-category"
				data-active={docs.some((doc) => doc.id === activeDocId)}
				onClick={onToggle}
				style={{
					width: "100%",
					border: 0,
					background: "transparent",
					color: "inherit",
					cursor: "pointer",
					textAlign: "left",
					padding: "8px 10px",
				}}
			>
				<Group gap="xs" wrap="nowrap">
					<ThemeIcon variant="subtle" color="indigo" size="sm">
						{opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
					</ThemeIcon>
					<IconFolder size={16} color="var(--mantine-color-indigo-4)" />
					<Box style={{ flex: 1, minWidth: 0 }}>
						<Group gap={6} wrap="nowrap">
							<Text fw={700} size="sm" lineClamp={1}>
								{category.label}
							</Text>
							<Badge size="xs" variant="light" color="gray">
								{docs.length}
							</Badge>
						</Group>
						{category.description && (
							<Text c="dimmed" size="xs" lineClamp={1}>
								{category.description}
							</Text>
						)}
					</Box>
				</Group>
			</Box>
			{opened && (
				<Stack gap={1} className="learn-tree-children">
					{docs.map((item) => (
						<DocListItem
							key={item.id}
							doc={item}
							active={item.id === activeDocId}
							onClick={() => onSelectDoc(item.id)}
						/>
					))}
				</Stack>
			)}
		</Box>
	);
}

function DocListItem({
	doc,
	active,
	onClick,
}: {
	doc: LearningDocSummary;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<Box
			component="button"
			type="button"
			className="learn-doc-item"
			data-active={active}
			onClick={onClick}
			style={{
				width: "100%",
				border: 0,
				borderLeft: "3px solid transparent",
				borderBottom: "1px solid var(--mantine-color-default-border)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				textAlign: "left",
				padding: "8px 10px",
			}}
		>
			<Group wrap="nowrap" align="flex-start" gap="xs">
				<ThemeIcon variant="light" color={active ? "indigo" : "gray"} size="sm">
					<IconInfoCircle size={14} />
				</ThemeIcon>
				<Box style={{ flex: 1, minWidth: 0 }}>
					<Text fw={700} size="sm">
						{doc.title}
					</Text>
					<Text size="xs" c="dimmed" lineClamp={2}>
						{doc.summary}
					</Text>
					<Group gap={4} mt="xs">
						{doc.tags.slice(0, 3).map((tag) => (
							<Badge key={tag} size="xs" variant="outline" color="gray">
								{tag}
							</Badge>
						))}
					</Group>
				</Box>
			</Group>
		</Box>
	);
}

function LearningList({
	icon,
	title,
	items,
	ordered = false,
	color = "indigo",
}: {
	icon: ReactNode;
	title: string;
	items: string[];
	ordered?: boolean;
	color?: string;
}) {
	if (items.length === 0) return null;
	return (
		<Paper withBorder p="md" radius="md" className="learn-callout">
			<Group gap="xs" mb="sm">
				<ThemeIcon variant="light" color={color}>
					{icon}
				</ThemeIcon>
				<Text fw={700}>{title}</Text>
			</Group>
			<Stack gap="xs">
				{items.map((item, index) => (
					<Group key={item} align="flex-start" wrap="nowrap" gap="sm">
						<ThemeIcon variant="subtle" color={color} size="sm">
							{ordered ? index + 1 : <IconSparkles size={12} />}
						</ThemeIcon>
						<Text size="sm">{item}</Text>
					</Group>
				))}
			</Stack>
		</Paper>
	);
}
