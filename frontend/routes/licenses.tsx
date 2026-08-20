import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Card,
	Center,
	Code,
	Collapse,
	Group,
	Loader,
	Skeleton,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	IconAlertTriangle,
	IconArrowLeft,
	IconChevronDown,
	IconChevronRight,
	IconSearch,
} from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLicenses, useLicenseText } from "../hooks/use-licenses";
import type { LicenseEntryKind, LicenseSummary } from "../lib/api";
import { getToken } from "../lib/api";

export const Route = createFileRoute("/licenses")({
	component: LicensesPage,
});

/**
 * Groups in obligation order: components compiled into the released artifact
 * carry the heaviest duties (and are the easiest to overlook), so they lead.
 */
const GROUP_ORDER: LicenseEntryKind[] = ["bundled", "runtime", "development"];

/** Rows rendered per group before requiring "show all", to keep ~1300 rows off the first paint. */
const INITIAL_ROWS_PER_GROUP = 60;

/**
 * React key and expansion key for one row.
 *
 * Name alone is not unique: a package installed at two versions (a nested `node_modules`
 * copy shadowing the hoisted one) is two entries, and keying by name would make React
 * reconcile them as one row while expanding either would expand both.
 */
function entryKey(dep: LicenseSummary): string {
	return dep.version ? `${dep.name}@${dep.version}` : dep.name;
}

function LicensesPage() {
	const { t } = useTranslation("common");
	const [search, setSearch] = useState("");
	const backTo = getToken() ? "/" : "/login";
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY);
	const { data, isLoading, isError } = useLicenses();

	const query = search.trim().toLowerCase();
	const filtered = useMemo(() => {
		const entries = data?.entries ?? [];
		if (!query) return entries;
		return entries.filter(
			(entry) =>
				entry.name.toLowerCase().includes(query) ||
				entry.license.toLowerCase().includes(query) ||
				entry.author.toLowerCase().includes(query),
		);
	}, [data?.entries, query]);

	const groups = useMemo(() => {
		const byKind = new Map<LicenseEntryKind, LicenseSummary[]>();
		for (const kind of GROUP_ORDER) byKind.set(kind, []);
		for (const entry of filtered) byKind.get(entry.kind)?.push(entry);
		return byKind;
	}, [filtered]);

	// Only errors are surfaced. Warnings are mostly "this optional platform package
	// is not installed on the build machine", which is noise to a reader.
	const errors = (data?.problems ?? []).filter((problem) => problem.severity === "error");

	return (
		<Center>
			<Box maw={980} w="100%" p="md">
				<Group mb="lg" gap="sm">
					<ActionIcon variant="subtle" component={Link} to={backTo} aria-label={t("back")}>
						<IconArrowLeft size={18} />
					</ActionIcon>
					<Title order={2}>{t("licensesTitle")}</Title>
				</Group>
				<Text c="dimmed" mb="md">
					{t("licensesDescription")}
				</Text>

				{errors.length > 0 && (
					<Alert
						color="red"
						icon={<IconAlertTriangle size={16} />}
						title={t("licensesProblemsTitle")}
						mb="md"
					>
						<Stack gap={4}>
							{errors.slice(0, 10).map((problem) => (
								<Text size="sm" key={`${problem.name ?? ""}-${problem.message}`}>
									{problem.name ? `${problem.name}: ` : ""}
									{problem.message}
								</Text>
							))}
						</Stack>
					</Alert>
				)}

				<TextInput
					placeholder={t("licensesSearch")}
					leftSection={<IconSearch size={16} />}
					value={search}
					onChange={(event) => setSearch(event.currentTarget.value)}
					mb="lg"
					disabled={isLoading}
				/>

				{isLoading && (
					<Group justify="center" py="xl">
						<Loader size="sm" />
						<Text c="dimmed" size="sm">
							{t("licensesLoading")}
						</Text>
					</Group>
				)}

				{isError && (
					<Alert color="red" icon={<IconAlertTriangle size={16} />}>
						{t("licensesLoadError")}
					</Alert>
				)}

				{data &&
					GROUP_ORDER.map((kind) => (
						<LicenseGroup
							key={kind}
							kind={kind}
							entries={groups.get(kind) ?? []}
							isMobile={isMobile ?? false}
							// A search should reveal its matches rather than leaving the reader to
							// expand three collapsed groups to find them.
							forceOpen={query.length > 0}
						/>
					))}

				{data && filtered.length === 0 && query.length > 0 && (
					<Text c="dimmed" ta="center" py="xl">
						{t("licensesNoMatches")}
					</Text>
				)}
			</Box>
		</Center>
	);
}

function LicenseGroup({
	kind,
	entries,
	isMobile,
	forceOpen,
}: {
	kind: LicenseEntryKind;
	entries: LicenseSummary[];
	isMobile: boolean;
	forceOpen: boolean;
}) {
	const { t } = useTranslation("common");
	// `bundled` and `runtime` start open because they are what a reader checking
	// compliance came for; the 317 dev-only rows start collapsed.
	const [open, setOpen] = useState(kind !== "development");
	const [showAll, setShowAll] = useState(false);

	if (entries.length === 0) return null;

	const isOpen = forceOpen || open;
	const visible = showAll ? entries : entries.slice(0, INITIAL_ROWS_PER_GROUP);
	const hidden = entries.length - visible.length;

	const titleKey =
		kind === "bundled"
			? "licensesGroupBundled"
			: kind === "runtime"
				? "licensesGroupRuntime"
				: "licensesGroupDevelopment";
	const descriptionKey =
		kind === "bundled"
			? "licensesGroupBundledDescription"
			: kind === "runtime"
				? "licensesGroupRuntimeDescription"
				: "licensesGroupDevelopmentDescription";

	return (
		<Box mb="xl">
			<UnstyledButton onClick={() => setOpen((previous) => !previous)} mb={4}>
				<Group gap={6}>
					{isOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
					<Title order={4}>
						{t(titleKey)} ({entries.length})
					</Title>
				</Group>
			</UnstyledButton>
			<Text c="dimmed" size="xs" mb="xs">
				{t(descriptionKey)}
			</Text>
			<Collapse expanded={isOpen}>
				{isOpen && (
					<>
						{isMobile ? <LicenseCards entries={visible} /> : <LicenseTable entries={visible} />}
						{hidden > 0 && (
							<Group justify="center" mt="sm">
								<UnstyledButton onClick={() => setShowAll(true)}>
									<Text size="sm" c="blue">
										{t("licensesShowAll", { count: hidden })}
									</Text>
								</UnstyledButton>
							</Group>
						)}
					</>
				)}
			</Collapse>
		</Box>
	);
}

function DepName({ dep }: { dep: LicenseSummary }) {
	return dep.repository ? (
		<Anchor href={dep.repository} target="_blank" rel="noopener noreferrer" size="sm">
			{dep.name}
		</Anchor>
	) : (
		<Text size="sm">{dep.name}</Text>
	);
}

/** License badge, annotated when the identifier is a selected branch of a disjunction. */
function LicenseBadge({ dep }: { dep: LicenseSummary }) {
	const { t } = useTranslation("common");
	if (!dep.declaredLicense) {
		return (
			<Badge variant="light" size="sm">
				{dep.license}
			</Badge>
		);
	}
	return (
		<Tooltip
			multiline
			w={280}
			label={`${t("licensesSelectedFrom", { declared: dep.declaredLicense })}${
				dep.selectionReason ? ` — ${dep.selectionReason}` : ""
			}`}
		>
			<Badge variant="light" size="sm" color="grape">
				{dep.license} *
			</Badge>
		</Tooltip>
	);
}

/**
 * How a bundled component reaches the user.
 *
 * Only bundled entries carry this, and only they need it: an npm package's presence is
 * explained by `dependencies`, but nothing on this page otherwise says why `musl libc` or
 * the Go standard library is listed — or lets a reader check whether the claim still holds.
 */
function DistributedViaNote({ dep }: { dep: LicenseSummary }) {
	const { t } = useTranslation("common");
	if (!dep.distributedVia) return null;
	return (
		<Text size="xs" c="dimmed">
			<Text span size="xs" fw={500}>
				{t("licensesDistributedVia")}
			</Text>{" "}
			{dep.distributedVia}
		</Text>
	);
}

/**
 * The expanded license text for one entry, fetched on demand.
 *
 * When the text is an SPDX template rather than upstream's own file, that is
 * stated above it: presenting boilerplate as the package's own wording would
 * misrepresent what upstream actually granted.
 */
function LicenseTextPanel({ dep }: { dep: LicenseSummary }) {
	const { t } = useTranslation("common");
	const { data, isLoading, isError } = useLicenseText(dep.textId, true);
	const notice = useLicenseText(dep.noticeTextId, Boolean(dep.noticeTextId));

	if (isLoading) {
		return (
			<Stack gap={4}>
				<Skeleton height={12} />
				<Skeleton height={12} />
				<Skeleton height={12} width="70%" />
			</Stack>
		);
	}

	if (isError || !data) {
		return (
			<Stack gap="xs">
				<DistributedViaNote dep={dep} />
				<Text size="sm" c="dimmed">
					{t("licensesTextUnavailable")}
				</Text>
			</Stack>
		);
	}

	return (
		<Stack gap="xs">
			<DistributedViaNote dep={dep} />
			{dep.textSource === "spdx-template" && (
				<Alert color="yellow" variant="light" icon={<IconAlertTriangle size={14} />} p="xs">
					<Text size="xs">
						{t("licensesTemplateNotice", { license: dep.license })}
						{dep.repository && (
							<>
								{" "}
								<Anchor href={dep.repository} target="_blank" rel="noopener noreferrer" size="xs">
									{t("licensesTemplateUpstreamLink")}
								</Anchor>
							</>
						)}
					</Text>
				</Alert>
			)}
			<Code block style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
				{data.text}
			</Code>
			{dep.noticeTextId && (
				<>
					<Text size="xs" fw={500}>
						{t("licensesNoticeHeading")}
					</Text>
					{notice.data ? (
						<Code block style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
							{notice.data.text}
						</Code>
					) : (
						<Skeleton height={40} />
					)}
				</>
			)}
		</Stack>
	);
}

function LicenseCards({ entries }: { entries: LicenseSummary[] }) {
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const { t } = useTranslation("common");

	const toggle = useCallback((key: string) => {
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	return (
		<Stack gap="xs">
			{entries.map((dep) => {
				const key = entryKey(dep);
				const isOpen = expanded.has(key);
				return (
					<Card key={key} withBorder padding="sm">
						<Group justify="space-between" wrap="nowrap" mb={4}>
							<DepName dep={dep} />
							<Box style={{ flexShrink: 0 }}>
								<LicenseBadge dep={dep} />
							</Box>
						</Group>
						<Group gap="xs">
							{dep.version && (
								<Text size="xs" c="dimmed">
									{dep.version}
								</Text>
							)}
							{dep.author && (
								<Text size="xs" c="dimmed" lineClamp={1}>
									· {dep.author}
								</Text>
							)}
						</Group>
						{dep.textId && (
							<>
								<UnstyledButton onClick={() => toggle(key)} mt={4}>
									<Group gap={4}>
										{isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
										<Text size="xs" c="dimmed">
											{t("licensesViewText")}
										</Text>
									</Group>
								</UnstyledButton>
								<Collapse expanded={isOpen}>
									{/* Mounted only while open, so the text request happens on expand. */}
									{isOpen && (
										<Box mt="xs">
											<LicenseTextPanel dep={dep} />
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

function LicenseTable({ entries }: { entries: LicenseSummary[] }) {
	const { t } = useTranslation("common");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const toggle = useCallback((key: string) => {
		setExpanded((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
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
					const key = entryKey(dep);
					const isOpen = expanded.has(key);
					return (
						<Fragment key={key}>
							<Table.Tr
								onClick={dep.textId ? () => toggle(key) : undefined}
								style={dep.textId ? { cursor: "pointer" } : undefined}
							>
								<Table.Td>
									<Group gap={4} wrap="nowrap">
										{dep.textId &&
											(isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />)}
										<DepName dep={dep} />
									</Group>
								</Table.Td>
								<Table.Td>
									<Text size="sm" c="dimmed">
										{dep.version || "—"}
									</Text>
								</Table.Td>
								<Table.Td>
									<LicenseBadge dep={dep} />
								</Table.Td>
								<Table.Td>
									<Text size="sm" c="dimmed" lineClamp={1}>
										{dep.author || "—"}
									</Text>
								</Table.Td>
							</Table.Tr>
							{isOpen && dep.textId && (
								<Table.Tr key={`${key}-license`}>
									<Table.Td colSpan={4}>
										<LicenseTextPanel dep={dep} />
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
