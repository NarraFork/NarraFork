/**
 * OAuth 2.0 consent page for third-party applications.
 *
 * External apps redirect the browser to `/oauth/authorize?...` with the
 * standard Authorization Code + PKCE query parameters. This page is reachable
 * without an authenticated layout (public route): if the user is not signed in,
 * they are bounced to /login and return here afterward. Once signed in, the
 * page loads the consent payload from GET /api/oauth/authorize and, on approve,
 * POSTs back to obtain the redirect URL carrying the authorization code.
 */
import {
	Alert,
	Button,
	Center,
	Checkbox,
	Code,
	Divider,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ApiError, getToken } from "../../lib/api";
import { request } from "../../lib/api/client";

interface AuthorizeSearch {
	client_id?: string;
	redirect_uri?: string;
	response_type?: string;
	scope?: string;
	state?: string;
	code_challenge?: string;
	code_challenge_method?: string;
}

interface ProjectOption {
	id: string;
	name: string;
}

interface ConsentInfo {
	client: {
		clientId: string;
		name: string;
		policy?: unknown;
	};
	/** Legacy payload: the complete requested scope list. */
	scopes?: string[];
	existingScopes?: string[];
	newScopes?: string[];
	projects?: ProjectOption[];
	selectedProjectIds?: string[];
	consentRequired?: boolean;
	state: string | null;
	user: { username: string };
}

interface AuthorizeResponse {
	redirect?: unknown;
}

export const Route = createFileRoute("/oauth/authorize")({
	validateSearch: (search: Record<string, unknown>): AuthorizeSearch => ({
		client_id: typeof search.client_id === "string" ? search.client_id : undefined,
		redirect_uri: typeof search.redirect_uri === "string" ? search.redirect_uri : undefined,
		response_type: typeof search.response_type === "string" ? search.response_type : undefined,
		scope: typeof search.scope === "string" ? search.scope : undefined,
		state: typeof search.state === "string" ? search.state : undefined,
		code_challenge: typeof search.code_challenge === "string" ? search.code_challenge : undefined,
		code_challenge_method:
			typeof search.code_challenge_method === "string" ? search.code_challenge_method : undefined,
	}),
	component: OAuthAuthorizePage,
});

function formatPolicyValue(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		const values = value.map(formatPolicyValue).filter((item): item is string => !!item);
		return values.length > 0 ? values.join(", ") : null;
	}
	return null;
}

function getPolicySummary(policy: unknown): string[] {
	if (typeof policy === "string") return policy.trim() ? [policy.trim()] : [];
	if (Array.isArray(policy)) {
		return policy.map(formatPolicyValue).filter((item): item is string => !!item);
	}
	if (!policy || typeof policy !== "object") return [];

	const entries = Object.entries(policy);
	const preferredKeys = new Set([
		"summary",
		"description",
		"purpose",
		"dataUse",
		"dataRetention",
		"security",
	]);
	const orderedEntries = [
		...entries.filter(([key]) => preferredKeys.has(key)),
		...entries.filter(([key]) => !preferredKeys.has(key)),
	];
	const seen = new Set<string>();
	const summary: string[] = [];
	for (const [key, value] of orderedEntries) {
		const formatted = formatPolicyValue(value);
		if (!formatted || seen.has(formatted)) continue;
		seen.add(formatted);
		summary.push(key === "summary" || key === "description" ? formatted : `${key}: ${formatted}`);
	}
	return summary;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))];
}

function getScopeSections(info: ConsentInfo): {
	existing: string[];
	added: string[];
	all: string[];
} {
	const existing = uniqueStrings(info.existingScopes ?? []);
	const all = uniqueStrings([...(info.scopes ?? []), ...existing, ...(info.newScopes ?? [])]);
	const added = uniqueStrings(info.newScopes ?? all.filter((scope) => !existing.includes(scope)));
	return { existing, added, all };
}

function OAuthAuthorizePage() {
	const { t } = useTranslation("common");
	const navigate = useNavigate();
	const search = Route.useSearch();
	const hasToken = !!getToken();

	const [info, setInfo] = useState<ConsentInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);

	const queryString = useMemo(() => {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(search)) {
			if (typeof value === "string" && value) params.set(key, value);
		}
		// response_type is required by the server but third parties sometimes omit
		// the default; supply it so the consent request validates.
		if (!params.has("response_type")) params.set("response_type", "code");
		return params.toString();
	}, [search]);

	const loginRedirect = useMemo(() => {
		const returnTo = `/oauth/authorize?${queryString}`;
		return `/login?redirect=${encodeURIComponent(returnTo)}`;
	}, [queryString]);

	const oauthRequest = useMemo(
		() => ({
			client_id: search.client_id,
			redirect_uri: search.redirect_uri,
			response_type: search.response_type ?? "code",
			scope: search.scope,
			state: search.state,
			code_challenge: search.code_challenge,
			code_challenge_method: search.code_challenge_method ?? "S256",
		}),
		[search],
	);

	const loadConsent = useCallback(async () => {
		if (!hasToken) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const data = await request<ConsentInfo>(`/oauth/authorize?${queryString}`);
			setInfo(data);
		} catch (err) {
			const apiErr = err as ApiError;
			if (apiErr.status === 401) {
				// Session expired or login_required — send the user back to login.
				navigate({ to: loginRedirect as "/login" });
				return;
			}
			setError(apiErr.message || t("oauthAuthorizeLoadFailed"));
		} finally {
			setLoading(false);
		}
	}, [hasToken, queryString, navigate, loginRedirect, t]);

	useEffect(() => {
		void loadConsent();
	}, [loadConsent]);

	useEffect(() => {
		if (!info) {
			setSelectedProjectIds([]);
			return;
		}
		const projects = info.projects ?? [];
		const availableIds = new Set(projects.map((project) => project.id));
		const initialIds = info.selectedProjectIds ?? projects.map((project) => project.id);
		setSelectedProjectIds(
			projects.length > 0 ? initialIds.filter((id) => availableIds.has(id)) : initialIds,
		);
	}, [info]);

	const scopeSections = useMemo(() => (info ? getScopeSections(info) : null), [info]);
	const policySummary = useMemo(() => getPolicySummary(info?.client.policy), [info?.client.policy]);

	const redirectFromResponse = (result: AuthorizeResponse): boolean => {
		if (typeof result.redirect !== "string" || !result.redirect) {
			setError(t("oauthAuthorizeInvalidResponse"));
			setSubmitting(false);
			return false;
		}
		window.location.assign(result.redirect);
		return true;
	};

	const handleApprove = async () => {
		setSubmitting(true);
		setError(null);
		try {
			const result = await request<AuthorizeResponse>("/oauth/authorize", {
				method: "POST",
				body: JSON.stringify({
					...oauthRequest,
					approve: true,
					project_ids: selectedProjectIds,
				}),
			});
			redirectFromResponse(result);
		} catch (err) {
			const apiErr = err as ApiError;
			setError(apiErr.message || t("oauthAuthorizeFailed"));
			setSubmitting(false);
		}
	};

	const handleDeny = async () => {
		setSubmitting(true);
		setError(null);
		try {
			const result = await request<AuthorizeResponse>("/oauth/authorize", {
				method: "POST",
				body: JSON.stringify({
					...oauthRequest,
					approve: false,
				}),
			});
			redirectFromResponse(result);
		} catch (err) {
			const apiErr = err as ApiError;
			const isLegacyDenyResponse =
				apiErr.status === 400 &&
				(apiErr.data?.error === "invalid_request" || /denied|deny|approve/i.test(apiErr.message));
			setError(
				isLegacyDenyResponse
					? t("oauthAuthorizeDenyUnsupported")
					: apiErr.message || t("oauthAuthorizeDenyFailed"),
			);
			setSubmitting(false);
		}
	};

	const toggleProject = (projectId: string) => {
		setSelectedProjectIds((current) =>
			current.includes(projectId)
				? current.filter((id) => id !== projectId)
				: [...current, projectId],
		);
	};

	// Not signed in: bounce to login, then come back with the same query.
	if (!hasToken) {
		return <Navigate to={loginRedirect as "/login"} />;
	}

	if (loading) {
		return (
			<Center h="100vh">
				<Loader />
			</Center>
		);
	}

	return (
		<Center h="100vh" p="md">
			<Paper withBorder p="xl" radius="md" maw={560} w="100%">
				<Stack>
					<Title order={3}>{t("oauthAuthorizeTitle")}</Title>
					{error && <Alert color="red">{error}</Alert>}
					{info && (
						<>
							<Text size="sm">
								{info.consentRequired === false
									? t("oauthAuthorizeConsentNotRequired", {
											app: info.client.name,
											user: info.user.username,
										})
									: t("oauthAuthorizePrompt", {
											app: info.client.name,
											user: info.user.username,
										})}
							</Text>

							{scopeSections && scopeSections.all.length > 0 && (
								<>
									<Divider />
									<Stack gap="xs">
										<Text size="sm" fw={500}>
											{t("oauthAuthorizeExistingScopes")}
										</Text>
										{scopeSections.existing.length === 0 ? (
											<Text size="sm" c="dimmed">
												{t("oauthAuthorizeNoExistingScopes")}
											</Text>
										) : (
											scopeSections.existing.map((scope) => (
												<Code key={`existing-${scope}`} block>
													{scope}
												</Code>
											))
										)}
									</Stack>

									<Stack gap="xs">
										<Text size="sm" fw={500}>
											{t("oauthAuthorizeNewScopes")}
										</Text>
										{scopeSections.added.length === 0 ? (
											<Text size="sm" c="dimmed">
												{t("oauthAuthorizeNoNewScopes")}
											</Text>
										) : (
											scopeSections.added.map((scope) => (
												<Code key={`new-${scope}`} block>
													{scope}
												</Code>
											))
										)}
									</Stack>
								</>
							)}

							{scopeSections && scopeSections.all.length === 0 && (
								<Text size="sm" c="dimmed">
									{t("oauthAuthorizeNoScopes")}
								</Text>
							)}

							{(info.projects?.length ?? 0) > 0 && (
								<>
									<Divider />
									<Stack gap="xs">
										<Text size="sm" fw={500}>
											{t("oauthAuthorizeProjects")}
										</Text>
										{info.projects?.map((project) => (
											<Checkbox
												key={project.id}
												label={project.name}
												description={project.id}
												checked={selectedProjectIds.includes(project.id)}
												onChange={() => toggleProject(project.id)}
												disabled={submitting}
											/>
										))}
									</Stack>
								</>
							)}

							{info.projects?.length === 0 && (
								<Text size="sm" c="dimmed">
									{t("oauthAuthorizeNoProjects")}
								</Text>
							)}

							<Divider />
							<Stack gap="xs">
								<Text size="sm" fw={500}>
									{t("oauthAuthorizePolicy")}
								</Text>
								{policySummary.length === 0 ? (
									<Text size="sm" c="dimmed">
										{t("oauthAuthorizeNoPolicy")}
									</Text>
								) : (
									policySummary.map((item) => (
										<Text size="sm" key={item}>
											{item}
										</Text>
									))
								)}
							</Stack>

							<Group justify="flex-end" mt="md">
								<Button variant="default" onClick={handleDeny} disabled={submitting}>
									{t("oauthAuthorizeDeny")}
								</Button>
								<Button onClick={handleApprove} loading={submitting}>
									{t("oauthAuthorizeApprove")}
								</Button>
							</Group>
						</>
					)}
					{!info && !error && (
						<Text size="sm" c="dimmed">
							{t("oauthAuthorizeMissing")}
						</Text>
					)}
				</Stack>
			</Paper>
		</Center>
	);
}
