import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Checkbox,
	Collapse,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import {
	IconPlugConnected,
	IconPlugConnectedX,
	IconRefresh,
	IconTerminal2,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/ConfirmDialogProvider";
import { useCurrentUser } from "../../hooks/useAuth";
import { api } from "../../lib/api";

const TerminalPanel = lazy(() =>
	import("../../components/terminal/TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

export const Route = createFileRoute("/settings/terminals")({
	component: SettingsTerminalsPage,
});

function SettingsTerminalsPage() {
	const { data: user } = useCurrentUser();
	const { t } = useTranslation("common");
	const confirm = useConfirmDialog();
	const qc = useQueryClient();

	const [openTerminalId, setOpenTerminalId] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const { data, isLoading, refetch } = useQuery({
		queryKey: ["admin", "terminals"],
		queryFn: api.listAdminTerminals,
		enabled: user?.role === "admin",
		refetchInterval: 10_000,
	});

	const killTerminal = useMutation({
		mutationFn: api.killAdminTerminal,
		onSuccess: (_, id) => {
			if (openTerminalId === id) setOpenTerminalId(null);
			qc.invalidateQueries({ queryKey: ["admin", "terminals"] });
		},
	});

	const batchKill = useMutation({
		mutationFn: api.batchKillAdminTerminals,
		onSuccess: (_data, killedIds) => {
			setSelected(new Set());
			if (openTerminalId && killedIds.includes(openTerminalId)) setOpenTerminalId(null);
			qc.invalidateQueries({ queryKey: ["admin", "terminals"] });
		},
	});

	const killOrphan = useMutation({
		mutationFn: api.killOrphanSocket,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "terminals"] }),
	});

	const reattachTerminal = useMutation({
		mutationFn: api.reattachTerminal,
		onSuccess: (_, id) => {
			qc.invalidateQueries({ queryKey: ["admin", "terminals"] });
			setOpenTerminalId(id);
		},
	});

	const reattachOrphan = useMutation({
		mutationFn: api.reattachOrphan,
		onSuccess: (result) => {
			qc.invalidateQueries({ queryKey: ["admin", "terminals"] });
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
			const id = (result as any)?.id;
			if (id) setOpenTerminalId(id);
		},
	});

	const toggleSelect = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const terminals = useMemo(() => data?.terminals ?? [], [data?.terminals]);
	const orphanSockets = useMemo(() => data?.orphanSockets ?? [], [data?.orphanSockets]);
	const runningTerminals = useMemo(
		() => terminals.filter((t: { status: string }) => t.status === "running"),
		[terminals],
	);
	const exitedTerminals = useMemo(
		() => terminals.filter((t: { status: string }) => t.status !== "running"),
		[terminals],
	);
	const runningTerminalIds = useMemo(
		() => runningTerminals.map((t: { id: string }) => t.id),
		[runningTerminals],
	);
	const allRunningSelected = useMemo(
		() => runningTerminalIds.length > 0 && runningTerminalIds.every((id) => selected.has(id)),
		[runningTerminalIds, selected],
	);
	const someRunningSelected = useMemo(
		() => runningTerminalIds.some((id) => selected.has(id)),
		[runningTerminalIds, selected],
	);

	const toggleSelectAll = useCallback(() => {
		if (allRunningSelected) {
			setSelected(new Set());
		} else {
			setSelected(new Set(runningTerminalIds));
		}
	}, [allRunningSelected, runningTerminalIds]);

	if (isLoading) return <Loader />;

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={3}>{t("adminTerminalsTitle")}</Title>
				<Tooltip label={t("refresh")}>
					<ActionIcon variant="subtle" onClick={() => refetch()}>
						<IconRefresh size={18} />
					</ActionIcon>
				</Tooltip>
			</Group>
			<Text size="sm" c="dimmed">
				{t("adminTerminalsDesc")}
			</Text>

			{/* Embedded terminal panel */}
			<Collapse in={!!openTerminalId}>
				{openTerminalId && (
					<Paper withBorder p={0} style={{ overflow: "hidden" }}>
						<Group
							px="sm"
							py={4}
							justify="space-between"
							style={{ backgroundColor: "var(--mantine-color-dark-7)" }}
						>
							<Group gap="xs">
								<IconTerminal2 size={14} />
								<Text size="xs" ff="monospace">
									{openTerminalId}
								</Text>
							</Group>
							<ActionIcon size="sm" variant="subtle" onClick={() => setOpenTerminalId(null)}>
								<IconX size={14} />
							</ActionIcon>
						</Group>
						<Box style={{ height: 400 }}>
							<Suspense fallback={null}>
								<TerminalPanel terminalId={openTerminalId} />
							</Suspense>
						</Box>
					</Paper>
				)}
			</Collapse>

			{/* Orphan dtach sockets */}
			{orphanSockets.length > 0 && (
				<Paper withBorder p="md" style={{ borderColor: "var(--mantine-color-orange-7)" }}>
					<Stack>
						<Title order={4} c="orange">
							{t("orphanSockets")} ({orphanSockets.length})
						</Title>
						<Table>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t("terminalId")}</Table.Th>
									<Table.Th>{t("socketPath")}</Table.Th>
									<Table.Th>{t("actions")}</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{orphanSockets.map((s: { terminalId: string; socketPath: string }) => (
									<Table.Tr key={s.terminalId}>
										<Table.Td>
											<Text size="xs" ff="monospace">
												{s.terminalId}
											</Text>
										</Table.Td>
										<Table.Td>
											<Text size="xs" ff="monospace" lineClamp={1}>
												{s.socketPath}
											</Text>
										</Table.Td>
										<Table.Td>
											<Group gap="xs">
												<Tooltip label={t("reattachOrphan")}>
													<ActionIcon
														color="green"
														variant="subtle"
														onClick={() => reattachOrphan.mutate(s.terminalId)}
														loading={reattachOrphan.isPending}
													>
														<IconPlugConnected size={16} />
													</ActionIcon>
												</Tooltip>
												<Tooltip label={t("killOrphan")}>
													<ActionIcon
														color="red"
														variant="subtle"
														onClick={async () => {
															if (await confirm({ message: t("confirmKillOrphan") })) {
																killOrphan.mutate(s.terminalId);
															}
														}}
														loading={killOrphan.isPending}
													>
														<IconTrash size={16} />
													</ActionIcon>
												</Tooltip>
											</Group>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</Stack>
				</Paper>
			)}

			{/* Running terminals */}
			<Paper withBorder p="md">
				<Stack>
					<Group justify="space-between">
						<Title order={4}>
							{t("running")} ({runningTerminals.length})
						</Title>
						{selected.size > 0 && (
							<Button
								color="red"
								size="xs"
								variant="light"
								leftSection={<IconTrash size={14} />}
								loading={batchKill.isPending}
								onClick={async () => {
									if (await confirm({ message: t("confirmBatchKill", { count: selected.size }) })) {
										batchKill.mutate([...selected]);
									}
								}}
							>
								{t("batchKill")} ({selected.size})
							</Button>
						)}
					</Group>
					{runningTerminals.length === 0 ? (
						<Text c="dimmed" size="sm">
							{t("noTerminals")}
						</Text>
					) : (
						<TerminalTable
							terminals={runningTerminals}
							t={t}
							openTerminalId={openTerminalId}
							selected={selected}
							onToggleSelect={toggleSelect}
							allSelected={allRunningSelected}
							someSelected={someRunningSelected}
							onToggleSelectAll={toggleSelectAll}
							onConnect={(id, attached) => {
								if (!attached) {
									reattachTerminal.mutate(id);
								} else {
									setOpenTerminalId(openTerminalId === id ? null : id);
								}
							}}
							reattachPending={reattachTerminal.isPending}
							onKill={async (id) => {
								if (await confirm({ message: t("confirmKillTerminal") })) {
									killTerminal.mutate(id);
								}
							}}
							killPending={killTerminal.isPending}
						/>
					)}
				</Stack>
			</Paper>

			{/* Exited terminals */}
			{exitedTerminals.length > 0 && (
				<Paper withBorder p="md">
					<Stack>
						<Title order={4}>
							{t("exited")} ({exitedTerminals.length})
						</Title>
						<TerminalTable terminals={exitedTerminals} t={t} />
					</Stack>
				</Paper>
			)}
		</Stack>
	);
}

function TerminalTable({
	terminals,
	t,
	openTerminalId,
	selected,
	onToggleSelect,
	allSelected,
	someSelected,
	onToggleSelectAll,
	onConnect,
	reattachPending,
	onKill,
	killPending,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	terminals: any[];
	t: (key: string, opts?: Record<string, unknown>) => string;
	openTerminalId?: string | null;
	selected?: Set<string>;
	onToggleSelect?: (id: string) => void;
	allSelected?: boolean;
	someSelected?: boolean;
	onToggleSelectAll?: () => void;
	onConnect?: (id: string, attached: boolean) => void;
	reattachPending?: boolean;
	onKill?: (id: string) => void | Promise<void>;
	killPending?: boolean;
}) {
	const selectable = !!onToggleSelect;
	return (
		<Table>
			<Table.Thead>
				<Table.Tr>
					{selectable && (
						<Table.Th w={40}>
							<Checkbox
								size="xs"
								aria-label={t("selectAll")}
								checked={allSelected}
								indeterminate={someSelected && !allSelected}
								onChange={onToggleSelectAll}
							/>
						</Table.Th>
					)}
					<Table.Th>{t("terminalName")}</Table.Th>
					<Table.Th>{t("terminalStatus")}</Table.Th>
					<Table.Th>{t("terminalProcesses")}</Table.Th>
					<Table.Th>{t("terminalCwd")}</Table.Th>
					<Table.Th>{t("terminalCreated")}</Table.Th>
					{(onConnect || onKill) && <Table.Th>{t("actions")}</Table.Th>}
				</Table.Tr>
			</Table.Thead>
			<Table.Tbody>
				{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
				{terminals.map((term: any) => (
					<Table.Tr
						key={term.id}
						style={
							openTerminalId === term.id
								? { backgroundColor: "var(--mantine-color-dark-6)" }
								: undefined
						}
					>
						{selectable && (
							<Table.Td>
								<Checkbox
									size="xs"
									aria-label={term.name}
									checked={selected?.has(term.id) ?? false}
									onChange={() => onToggleSelect?.(term.id)}
								/>
							</Table.Td>
						)}
						<Table.Td>
							<Text size="sm">{term.name}</Text>
							<Text size="xs" c="dimmed" ff="monospace">
								{term.id}
							</Text>
						</Table.Td>
						<Table.Td>
							<Group gap={4}>
								<Badge color={term.status === "running" ? "green" : "gray"} size="sm">
									{t(term.status)}
								</Badge>
								{term.status === "running" && (
									<Badge color={term.attached ? "teal" : "yellow"} size="sm" variant="light">
										{term.attached ? t("attached") : t("detached")}
									</Badge>
								)}
							</Group>
						</Table.Td>
						<Table.Td>
							<ProcessList processes={term.processes} />
						</Table.Td>
						<Table.Td>
							<Text size="xs" ff="monospace" lineClamp={1} maw={200}>
								{term.cwd ?? "—"}
							</Text>
						</Table.Td>
						<Table.Td>
							<Text size="xs">{new Date(term.createdAt).toLocaleString()}</Text>
						</Table.Td>
						{(onConnect || onKill) && (
							<Table.Td>
								<Group gap="xs">
									{onConnect && (
										<Tooltip
											label={
												term.attached
													? openTerminalId === term.id
														? t("closePanel")
														: t("attach")
													: t("reattach")
											}
										>
											<ActionIcon
												color={term.attached ? "teal" : "yellow"}
												variant={openTerminalId === term.id ? "filled" : "subtle"}
												onClick={() => onConnect(term.id, !!term.attached)}
												loading={reattachPending}
											>
												{term.attached ? (
													<IconTerminal2 size={16} />
												) : (
													<IconPlugConnectedX size={16} />
												)}
											</ActionIcon>
										</Tooltip>
									)}
									{onKill && (
										<Tooltip label={t("killTerminal")}>
											<ActionIcon
												color="red"
												variant="subtle"
												onClick={() => onKill(term.id)}
												loading={killPending}
											>
												<IconTrash size={16} />
											</ActionIcon>
										</Tooltip>
									)}
								</Group>
							</Table.Td>
						)}
					</Table.Tr>
				))}
			</Table.Tbody>
		</Table>
	);
}

function ProcessList({
	processes,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	processes?: any[];
}) {
	if (!processes || processes.length === 0) {
		return (
			<Text size="xs" c="dimmed">
				—
			</Text>
		);
	}
	return (
		<Stack gap={2}>
			{processes.map(
				(p: {
					pid: number;
					command: string;
					state: string;
					rss: number;
					cpu: number;
					elapsed: string;
				}) => (
					<Group key={p.pid} gap={6} wrap="nowrap">
						<Badge
							size="xs"
							variant="dot"
							color={p.state.startsWith("R") ? "green" : p.state.startsWith("S") ? "blue" : "gray"}
						>
							{p.command}
						</Badge>
						<Text size="xs" c="dimmed" ff="monospace">
							{formatRss(p.rss)}
						</Text>
						<Text size="xs" c="dimmed">
							{p.elapsed}
						</Text>
					</Group>
				),
			)}
		</Stack>
	);
}

function formatRss(kb: number): string {
	if (kb < 1024) return `${kb}K`;
	if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)}M`;
	return `${(kb / 1024 / 1024).toFixed(1)}G`;
}
