import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Card,
	Center,
	Code,
	Collapse,
	Group,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowLeft, IconChevronDown, IconChevronRight, IconSearch } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getToken } from "../lib/api";

export const Route = createFileRoute("/licenses")({
	component: LicensesPage,
});

const licenses = __LICENSE_DATA__;
const MAX_LICENSE_TEXT_CHARS = 120_000;

function LicensesPage() {
	const { t } = useTranslation("common");
	const [search, setSearch] = useState("");
	const backTo = getToken() ? "/" : "/login";
	const isMobile = useMediaQuery("(max-width: 48em)");

	const filtered = useMemo(() => {
		if (!search.trim()) return licenses;
		const q = search.toLowerCase();
		return licenses.filter(
			(l) =>
				l.name.toLowerCase().includes(q) ||
				l.license.toLowerCase().includes(q) ||
				l.author.toLowerCase().includes(q),
		);
	}, [search]);

	const prodDeps = filtered.filter((l) => !l.isDev);
	const devDeps = filtered.filter((l) => l.isDev);

	return (
		<Center>
			<Box maw={900} w="100%" p="md">
				<Group mb="lg" gap="sm">
					<ActionIcon variant="subtle" component={Link} to={backTo} aria-label={t("back")}>
						<IconArrowLeft size={18} />
					</ActionIcon>
					<Title order={2}>{t("licensesTitle")}</Title>
				</Group>
				<Text c="dimmed" mb="md">
					{t("licensesDescription")}
				</Text>
				<TextInput
					placeholder={t("licensesSearch")}
					leftSection={<IconSearch size={16} />}
					value={search}
					onChange={(e) => setSearch(e.currentTarget.value)}
					mb="lg"
				/>

				<Title order={4} mb="xs">
					{t("licensesRuntime")} ({prodDeps.length})
				</Title>
				{isMobile ? <LicenseCards entries={prodDeps} /> : <LicenseTable entries={prodDeps} />}

				<Title order={4} mt="xl" mb="xs">
					{t("licensesDev")} ({devDeps.length})
				</Title>
				{isMobile ? <LicenseCards entries={devDeps} /> : <LicenseTable entries={devDeps} />}
			</Box>
		</Center>
	);
}

function DepName({ dep }: { dep: LicenseEntry }) {
	return dep.repository ? (
		<Anchor href={dep.repository} target="_blank" rel="noopener noreferrer" size="sm">
			{dep.name}
		</Anchor>
	) : (
		<Text size="sm">{dep.name}</Text>
	);
}

function LicenseTextBlock({ text }: { text: string }) {
	const displayText =
		text.length > MAX_LICENSE_TEXT_CHARS ? `${text.slice(0, MAX_LICENSE_TEXT_CHARS)}\n…` : text;
	return (
		<Code block style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>
			{displayText}
		</Code>
	);
}

function LicenseCards({ entries }: { entries: LicenseEntry[] }) {
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const { t } = useTranslation("common");

	const toggle = useCallback((name: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}, []);

	return (
		<Stack gap="xs">
			{entries.map((dep) => {
				const isOpen = expanded.has(dep.name);
				return (
					<Card key={dep.name} withBorder padding="sm">
						<Group justify="space-between" wrap="nowrap" mb={4}>
							<DepName dep={dep} />
							<Badge variant="light" size="sm" style={{ flexShrink: 0 }}>
								{dep.license}
							</Badge>
						</Group>
						<Group gap="xs">
							<Text size="xs" c="dimmed">
								{dep.version}
							</Text>
							{dep.author && (
								<Text size="xs" c="dimmed" lineClamp={1}>
									· {dep.author}
								</Text>
							)}
						</Group>
						{dep.licenseText && (
							<>
								<UnstyledButton onClick={() => toggle(dep.name)} mt={4}>
									<Group gap={4}>
										{isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
										<Text size="xs" c="dimmed">
											{t("licensesViewText")}
										</Text>
									</Group>
								</UnstyledButton>
								<Collapse in={isOpen}>
									{isOpen && (
										<Box mt="xs">
											<LicenseTextBlock text={dep.licenseText} />
										</Box>
									)}
								</Collapse>
							</>
						)}
					</Card>
				);
			})}
		</Stack>
	);
}

function LicenseTable({ entries }: { entries: LicenseEntry[] }) {
	const { t } = useTranslation("common");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const toggle = useCallback((name: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}, []);

	return (
		<Table striped highlightOnHover>
			<Table.Thead>
				<Table.Tr>
					<Table.Th>{t("licensesColName")}</Table.Th>
					<Table.Th>{t("licensesColVersion")}</Table.Th>
					<Table.Th>{t("licensesColLicense")}</Table.Th>
					<Table.Th>{t("licensesColAuthor")}</Table.Th>
				</Table.Tr>
			</Table.Thead>
			<Table.Tbody>
				{entries.map((dep) => {
					const isOpen = expanded.has(dep.name);
					return (
						<Fragment key={dep.name}>
							<Table.Tr
								onClick={dep.licenseText ? () => toggle(dep.name) : undefined}
								style={dep.licenseText ? { cursor: "pointer" } : undefined}
							>
								<Table.Td>
									<Group gap={4} wrap="nowrap">
										{dep.licenseText &&
											(isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />)}
										<DepName dep={dep} />
									</Group>
								</Table.Td>
								<Table.Td>
									<Text size="sm" c="dimmed">
										{dep.version}
									</Text>
								</Table.Td>
								<Table.Td>
									<Badge variant="light" size="sm">
										{dep.license}
									</Badge>
								</Table.Td>
								<Table.Td>
									<Text size="sm" c="dimmed" lineClamp={1}>
										{dep.author || "—"}
									</Text>
								</Table.Td>
							</Table.Tr>
							{isOpen && dep.licenseText && (
								<Table.Tr key={`${dep.name}-license`}>
									<Table.Td colSpan={4}>
										<LicenseTextBlock text={dep.licenseText} />
									</Table.Td>
								</Table.Tr>
							)}
						</Fragment>
					);
				})}
			</Table.Tbody>
		</Table>
	);
}
