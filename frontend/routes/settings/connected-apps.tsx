import {
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Checkbox,
	Group,
	Loader,
	SimpleGrid,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../../components/common/confirm-dialog-context";
import { isAbortError } from "../../lib/api/client";
import {
	OAUTH_GRANTS_MAX_LIMIT,
	type OAuthGrant,
	oauthGrantsApi,
	RevokeAllOAuthGrantsError,
} from "../../lib/api/oauth-grants";
import { formatLocaleDateTime } from "../../lib/intl-format";

export const Route = createFileRoute("/settings/connected-apps")({
	component: SettingsConnectedAppsPage,
});

const PAGE_SIZE = Math.min(25, OAUTH_GRANTS_MAX_LIMIT);
const MAX_PAGE_COUNT = 100;
const QUERY_KEY = ["oauth-grants"];

function SettingsConnectedAppsPage() {
	const { t } = useTranslation("settings");
	const queryClient = useQueryClient();
	const confirm = useConfirmDialog();
	const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const revokeAllAbortRef = useRef<AbortController | null>(null);
	const currentCursor = cursorHistory[cursorHistory.length - 1] ?? null;

	useEffect(() => {
		return () => {
			revokeAllAbortRef.current?.abort();
			revokeAllAbortRef.current = null;
		};
	}, []);

	const grantsQuery = useQuery({
		queryKey: [...QUERY_KEY, PAGE_SIZE, currentCursor],
		queryFn: ({ signal }) =>
			oauthGrantsApi.listOAuthGrants({ limit: PAGE_SIZE, cursor: currentCursor }, signal),
		placeholderData: keepPreviousData,
	});

	const grants = grantsQuery.data?.items ?? [];
	const activeGrants = grants.filter((grant) => grant.status === "active");
	const activeIds = activeGrants.map((grant) => grant.id);
	const selectedActiveIds = selectedIds.filter((id) => activeIds.includes(id));
	const allActiveSelected =
		activeIds.length > 0 && activeIds.every((id) => selectedIds.includes(id));

	const invalidateGrants = async () => {
		setSelectedIds([]);
		await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
	};

	const showMutationError = (error: unknown, fallback: string) => {
		notifications.show({
			color: "red",
			message: error instanceof Error ? error.message : fallback,
		});
	};

	const revokeOne = useMutation({
		mutationFn: (id: string) => oauthGrantsApi.revokeOAuthGrant(id),
		onSuccess: async () => {
			await invalidateGrants();
			notifications.show({ color: "green", message: t("connectedAppsRevokeSuccess") });
		},
		onError: (error) => showMutationError(error, t("connectedAppsRevokeFailed")),
	});

	const revokeSelected = useMutation({
		mutationFn: (grantIds: string[]) => oauthGrantsApi.revokeOAuthGrants(grantIds),
		onSuccess: async () => {
			await invalidateGrants();
			notifications.show({ color: "green", message: t("connectedAppsRevokeSelectedSuccess") });
		},
		onError: (error) => showMutationError(error, t("connectedAppsRevokeFailed")),
	});

	const revokeAll = useMutation({
		mutationFn: (controller: AbortController) =>
			oauthGrantsApi.revokeAllOAuthGrants(controller.signal),
		onSuccess: async () => {
			await invalidateGrants();
			notifications.show({ color: "green", message: t("connectedAppsRevokeAllSuccess") });
		},
		onError: async (error) => {
			await invalidateGrants();
			const cause = error instanceof RevokeAllOAuthGrantsError ? error.cause : error;
			if (!isAbortError(cause)) {
				showMutationError(error, t("connectedAppsRevokeFailed"));
			}
		},
		onSettled: (_data, _error, controller) => {
			if (revokeAllAbortRef.current === controller) revokeAllAbortRef.current = null;
		},
	});

	const toggleSelected = (id: string) => {
		setSelectedIds((current) =>
			current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
		);
	};

	const toggleAllActive = () => {
		setSelectedIds((current) => {
			if (allActiveSelected) return current.filter((id) => !activeIds.includes(id));
			return [...new Set([...current, ...activeIds])];
		});
	};

	const handleRevoke = async (grant: OAuthGrant) => {
		if (
			await confirm({
				title: t("connectedAppsRevoke"),
				message: t("connectedAppsRevokeConfirm", { name: grant.client.name }),
				confirmLabel: t("connectedAppsRevoke"),
				confirmColor: "red",
			})
		) {
			revokeOne.mutate(grant.id);
		}
	};

	const handleRevokeSelected = async () => {
		if (selectedActiveIds.length === 0) return;
		if (
			await confirm({
				title: t("connectedAppsRevokeSelected"),
				message: t("connectedAppsRevokeSelectedConfirm", { count: selectedActiveIds.length }),
				confirmLabel: t("connectedAppsRevokeSelected"),
				confirmColor: "red",
			})
		) {
			revokeSelected.mutate(selectedActiveIds);
		}
	};

	const handleRevokeAll = async () => {
		if (
			await confirm({
				title: t("connectedAppsRevokeAll"),
				message: t("connectedAppsRevokeAllConfirm"),
				confirmLabel: t("connectedAppsRevokeAll"),
				confirmColor: "red",
			})
		) {
			revokeAllAbortRef.current?.abort();
			const controller = new AbortController();
			revokeAllAbortRef.current = controller;
			revokeAll.mutate(controller);
		}
	};

	const goPrevious = () => {
		if (cursorHistory.length <= 1) return;
		setSelectedIds([]);
		setCursorHistory((history) => history.slice(0, -1));
	};

	const goNext = () => {
		const nextCursor = grantsQuery.data?.nextCursor;
		if (!nextCursor || cursorHistory.length >= MAX_PAGE_COUNT || grantsQuery.isFetching) return;
		setSelectedIds([]);
		setCursorHistory((history) => [...history, nextCursor]);
	};

	return (
		<Stack gap="lg" maw={960}>
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<Box>
					<Title order={3}>{t("connectedAppsSection")}</Title>
					<Text size="sm" c="dimmed" mt={4} maw={700}>
						{t("connectedAppsDescription")}
					</Text>
				</Box>
				<Button
					color="red"
					variant="light"
					onClick={() => void handleRevokeAll()}
					loading={revokeAll.isPending}
				>
					{t("connectedAppsRevokeAll")}
				</Button>
			</Group>

			{grantsQuery.isError ? (
				<Alert color="red" title={t("connectedAppsLoadFailed")}>
					<Stack gap="xs">
						{grantsQuery.error instanceof Error ? (
							<Text size="sm">{grantsQuery.error.message}</Text>
						) : null}
						<Button variant="light" size="compact-sm" onClick={() => void grantsQuery.refetch()}>
							{t("connectedAppsRetry")}
						</Button>
					</Stack>
				</Alert>
			) : grantsQuery.isLoading ? (
				<Group justify="center" py="xl">
					<Loader />
				</Group>
			) : (
				<>
					{activeGrants.length > 0 ? (
						<Group justify="space-between" align="center" wrap="wrap">
							<Checkbox
								label={t("connectedAppsSelectAll")}
								checked={allActiveSelected}
								indeterminate={selectedActiveIds.length > 0 && !allActiveSelected}
								onChange={toggleAllActive}
							/>
							<Group gap="xs">
								{selectedActiveIds.length > 0 ? (
									<>
										<Text size="sm" c="dimmed">
											{t("connectedAppsSelectedCount", { count: selectedActiveIds.length })}
										</Text>
										<Button
											size="compact-sm"
											color="red"
											variant="light"
											onClick={() => void handleRevokeSelected()}
											loading={revokeSelected.isPending}
										>
											{t("connectedAppsRevokeSelected")}
										</Button>
										<Button size="compact-sm" variant="subtle" onClick={() => setSelectedIds([])}>
											{t("connectedAppsClearSelection")}
										</Button>
									</>
								) : null}
							</Group>
						</Group>
					) : null}

					{grants.length === 0 ? (
						<Alert color="gray">{t("connectedAppsEmpty")}</Alert>
					) : (
						<Stack gap="sm">
							{grants.map((grant) => (
								<GrantCard
									key={grant.id}
									grant={grant}
									selected={selectedIds.includes(grant.id)}
									busy={revokeOne.isPending && revokeOne.variables === grant.id}
									onToggle={() => toggleSelected(grant.id)}
									onRevoke={() => void handleRevoke(grant)}
									t={t}
								/>
							))}
						</Stack>
					)}

					<Group justify="space-between" align="center" mt="xs">
						<Button
							variant="default"
							disabled={cursorHistory.length <= 1 || grantsQuery.isFetching}
							onClick={goPrevious}
						>
							{t("connectedAppsPrevious")}
						</Button>
						<Text size="sm" c="dimmed">
							{t("connectedAppsPage", { page: cursorHistory.length })}
						</Text>
						<Button
							variant="default"
							disabled={!grantsQuery.data?.nextCursor || cursorHistory.length >= MAX_PAGE_COUNT}
							loading={grantsQuery.isFetching}
							onClick={goNext}
						>
							{t("connectedAppsNext")}
						</Button>
					</Group>
				</>
			)}
		</Stack>
	);
}

type SettingsTranslation = (key: string, values?: Record<string, unknown>) => string;

function GrantCard({
	grant,
	selected,
	busy,
	onToggle,
	onRevoke,
	t,
}: {
	grant: OAuthGrant;
	selected: boolean;
	busy: boolean;
	onToggle: () => void;
	onRevoke: () => void;
	t: SettingsTranslation;
}) {
	const isActive = grant.status === "active";
	const clientName = grant.client.name || grant.client.clientId;
	return (
		<Card withBorder padding="md">
			<Stack gap="sm">
				<Group justify="space-between" align="flex-start" wrap="wrap">
					<Group align="flex-start" wrap="nowrap" gap="sm" style={{ minWidth: 0 }}>
						{isActive ? (
							<Checkbox
								checked={selected}
								onChange={onToggle}
								aria-label={t("connectedAppsSelect", { name: clientName })}
								mt={3}
							/>
						) : null}
						<Box style={{ minWidth: 0 }}>
							<Group gap="xs" wrap="wrap">
								<Text fw={600} style={{ overflowWrap: "anywhere" }}>
									{clientName}
								</Text>
								<Badge color={isActive ? "green" : "gray"} variant="light">
									{statusLabel(grant.status, t)}
								</Badge>
							</Group>
							<Text size="xs" c="dimmed" mt={3} style={{ overflowWrap: "anywhere" }}>
								{t("connectedAppsClientId")}: {grant.client.clientId}
							</Text>
						</Box>
					</Group>
					{isActive ? (
						<Button size="compact-sm" color="red" variant="light" loading={busy} onClick={onRevoke}>
							{t("connectedAppsRevoke")}
						</Button>
					) : null}
				</Group>

				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
					<SummaryField
						label={t("connectedAppsScopes")}
						value={summarizeValues(grant.scopes, t("connectedAppsNoScopes"))}
					/>
					<SummaryField
						label={t("connectedAppsProjects")}
						value={summarizeValues(grant.projectIds, t("connectedAppsNoProjects"))}
					/>
					<SummaryField
						label={t("connectedAppsConsentedAt")}
						value={formatDate(grant.consentedAt, t("connectedAppsUnknownDate"))}
					/>
					<SummaryField
						label={t("connectedAppsLastUsedAt")}
						value={formatDate(grant.lastUsedAt, t("connectedAppsNeverUsed"))}
					/>
				</SimpleGrid>

				{grant.revokedAt || grant.reason ? (
					<Alert color="gray" variant="light">
						{grant.revokedAt
							? `${t("connectedAppsRevokedAt")}: ${formatDate(grant.revokedAt, t("connectedAppsUnknownDate"))}`
							: null}
						{grant.reason ? (
							<Text size="sm" mt={grant.revokedAt ? 4 : 0}>
								{t("connectedAppsReason")}: {grant.reason}
							</Text>
						) : null}
					</Alert>
				) : null}
			</Stack>
		</Card>
	);
}

function SummaryField({ label, value }: { label: string; value: string }) {
	return (
		<Box>
			<Text size="xs" c="dimmed">
				{label}
			</Text>
			<Text size="sm" style={{ overflowWrap: "anywhere" }}>
				{value}
			</Text>
		</Box>
	);
}

function summarizeValues(values: string[], empty: string): string {
	if (values.length === 0) return empty;
	const visible = values.slice(0, 3).join(", ");
	return values.length > 3 ? `${visible} +${values.length - 3}` : visible;
}

function formatDate(value: string | null, fallback: string): string {
	if (!value) return fallback;
	return formatLocaleDateTime(value) || fallback;
}

function statusLabel(status: string, t: SettingsTranslation): string {
	if (status === "active") return t("connectedAppsStatusActive");
	if (status === "revoked") return t("connectedAppsStatusRevoked");
	return status;
}
