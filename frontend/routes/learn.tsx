import {
	Anchor,
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
	IconInfoCircle,
	IconRobot,
	IconSearch,
	IconSparkles,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api, type LearningDocSummary } from "../lib/api";

interface LearnSearchParams {
	doc?: string;
	q?: string;
	category?: string;
}

export const Route = createFileRoute("/learn")({
	validateSearch: (search: Record<string, unknown>): LearnSearchParams => ({
		doc: typeof search.doc === "string" ? search.doc : undefined,
		q: typeof search.q === "string" ? search.q : undefined,
		category: typeof search.category === "string" ? search.category : undefined,
	}),
	component: LearnPage,
});

function normalizeLanguage(lng: string | undefined): string {
	return lng?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function LearnPage() {
	const { t, i18n } = useTranslation("learning");
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const lang = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);
	const query = search.q ?? "";
	const activeCategory = search.category ?? "all";

	const { data: index, isLoading: indexLoading } = useQuery({
		queryKey: ["learning", "index", lang],
		queryFn: () => api.getLearningIndex(lang),
	});

	const filteredDocs = useMemo(() => {
		const docs = index?.docs ?? [];
		const q = query.trim().toLowerCase();
		return docs.filter((doc) => {
			const categoryMatches = activeCategory === "all" || doc.category === activeCategory;
			if (!categoryMatches) return false;
			if (!q) return true;
			return [doc.title, doc.summary, doc.id, doc.category, ...doc.tags]
				.join("\n")
				.toLowerCase()
				.includes(q);
		});
	}, [activeCategory, index?.docs, query]);

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
	});

	const selectDoc = (id: string) => {
		void navigate({ search: (prev) => ({ ...prev, doc: id }) });
	};

	const setQuery = (value: string) => {
		void navigate({ search: (prev) => ({ ...prev, q: value || undefined, doc: undefined }) });
	};

	const setCategory = (category: string) => {
		void navigate({
			search: (prev) => ({
				...prev,
				category: category === "all" ? undefined : category,
				doc: undefined,
			}),
		});
	};

	if (indexLoading) return <Loader />;

	return (
		<Stack gap="lg">
			<Paper withBorder p="xl" radius="lg">
				<Group justify="space-between" align="flex-start" gap="lg">
					<Box maw={760}>
						<Group gap="xs" mb="xs">
							<ThemeIcon variant="light" size="lg">
								<IconBook2 size={20} />
							</ThemeIcon>
							<Badge variant="light" color="indigo">
								{t("sharedBadge")}
							</Badge>
						</Group>
						<Title order={1}>{t("title")}</Title>
						<Text c="dimmed" mt="sm" size="lg">
							{t("subtitle")}
						</Text>
					</Box>
					<Button component="a" href="/narrators" rightSection={<IconArrowRight size={16} />}>
						{t("askAgent")}
					</Button>
				</Group>
			</Paper>

			<Grid gutter="lg">
				<Grid.Col span={{ base: 12, md: 3 }}>
					<Card withBorder p="md" radius="lg">
						<Stack gap="sm">
							<TextInput
								leftSection={<IconSearch size={16} />}
								placeholder={t("searchPlaceholder")}
								value={query}
								onChange={(event) => setQuery(event.currentTarget.value)}
							/>
							<Stack gap={4}>
								<CategoryButton
									active={activeCategory === "all"}
									label={t("allCategories")}
									description={t("allCategoriesDescription")}
									onClick={() => setCategory("all")}
								/>
								{index?.categories.map((category) => (
									<CategoryButton
										key={category.id}
										active={activeCategory === category.id}
										label={category.label}
										description={category.description}
										onClick={() => setCategory(category.id)}
									/>
								))}
							</Stack>
						</Stack>
					</Card>
				</Grid.Col>

				<Grid.Col span={{ base: 12, md: 3 }}>
					<Card withBorder p={0} radius="lg">
						<ScrollArea h={640}>
							<Stack gap={0}>
								{filteredDocs.length === 0 ? (
									<Text c="dimmed" p="md">
										{t("noResults")}
									</Text>
								) : (
									filteredDocs.map((item) => (
										<DocListItem
											key={item.id}
											doc={item}
											active={item.id === effectiveDocId}
											onClick={() => selectDoc(item.id)}
										/>
									))
								)}
							</Stack>
						</ScrollArea>
					</Card>
				</Grid.Col>

				<Grid.Col span={{ base: 12, md: 6 }}>
					<Card withBorder p="xl" radius="lg">
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
									<Paper withBorder p="md" radius="md">
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
								<LearningList
									icon={<IconRobot size={18} />}
									title={t("agentHints")}
									items={doc.agentHints}
									color="violet"
								/>
								<Text size="sm" c="dimmed">
									{t("agentToolHint")} <Anchor>LearningGuide</Anchor>
								</Text>
							</Stack>
						) : (
							<Text c="dimmed">{t("selectDoc")}</Text>
						)}
					</Card>
				</Grid.Col>
			</Grid>
		</Stack>
	);
}

function CategoryButton({
	active,
	label,
	description,
	onClick,
}: {
	active: boolean;
	label: string;
	description: string;
	onClick: () => void;
}) {
	return (
		<Paper
			component="button"
			type="button"
			withBorder={active}
			p="sm"
			radius="md"
			onClick={onClick}
			style={{
				textAlign: "left",
				cursor: "pointer",
				background: active ? "var(--mantine-color-indigo-light)" : "transparent",
			}}
		>
			<Text fw={700} size="sm">
				{label}
			</Text>
			<Text c="dimmed" size="xs" lineClamp={2}>
				{description}
			</Text>
		</Paper>
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
			onClick={onClick}
			style={{
				border: 0,
				borderBottom: "1px solid var(--mantine-color-default-border)",
				background: active ? "var(--mantine-color-indigo-light)" : "transparent",
				cursor: "pointer",
				textAlign: "left",
				padding: "var(--mantine-spacing-md)",
			}}
		>
			<Group wrap="nowrap" align="flex-start" gap="sm">
				<ThemeIcon variant="light" color={active ? "indigo" : "gray"} size="md">
					<IconInfoCircle size={16} />
				</ThemeIcon>
				<Box style={{ flex: 1, minWidth: 0 }}>
					<Text fw={700}>{doc.title}</Text>
					<Text size="sm" c="dimmed" lineClamp={3}>
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
		<Paper withBorder p="md" radius="md">
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
