import {
	ActionIcon,
	AppShell,
	Burger,
	Center,
	Group,
	Loader,
	NavLink,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconLogout, IconSearch, IconX } from "@tabler/icons-react";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	Link,
	Navigate,
	Outlet,
	useNavigate,
	useRouterState,
} from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser, useLogout } from "../hooks/useAuth";
import { clearToken, getToken } from "../lib/api";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
});

function RootLayout() {
	const location = useRouterState({ select: (s) => s.location });
	const isLoginPage = location.pathname === "/login";

	if (isLoginPage) return <Outlet />;

	return <AuthenticatedLayout />;
}

function AuthenticatedLayout() {
	const [opened, { toggle }] = useDisclosure();
	const [searchQuery, setSearchQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const navigate = useNavigate();
	const { t } = useTranslation("nav");
	const { data: user, isLoading, isError, fetchStatus } = useCurrentUser();
	const { logout } = useLogout();

	const hasToken = !!getToken();

	// No token → redirect to login (useCurrentUser is disabled, won't fire)
	if (!hasToken) {
		return <Navigate to="/login" />;
	}

	// Token exists but query failed (expired/invalid) → clear token and redirect
	if (isError) {
		clearToken();
		return <Navigate to="/login" />;
	}

	// Token exists, query in flight → show loader
	if (isLoading || (!user && fetchStatus === "fetching")) {
		return (
			<Center h="100vh">
				<Loader />
			</Center>
		);
	}

	const handleSearch = () => {
		if (searchQuery.trim()) {
			navigate({ to: "/search", search: { q: searchQuery.trim() } });
			setSearchOpen(false);
		}
	};

	const handleSearchKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleSearch();
		if (e.key === "Escape") setSearchOpen(false);
	};

	return (
		<AppShell
			header={{ height: 60 }}
			navbar={{ width: 250, breakpoint: "sm", collapsed: { mobile: !opened } }}
			padding="md"
		>
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between" wrap="nowrap">
					<Group wrap="nowrap">
						<Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
						<Title order={3} visibleFrom="sm">
							{t("appName")}
						</Title>
						{searchOpen ? (
							<ActionIcon
								variant="subtle"
								color="gray"
								onClick={() => setSearchOpen(false)}
								hiddenFrom="sm"
							>
								<IconX size={18} />
							</ActionIcon>
						) : (
							<Title order={3} hiddenFrom="sm">
								{t("appName")}
							</Title>
						)}
					</Group>
					<Group wrap="nowrap">
						{/* Desktop: always show search input */}
						<TextInput
							placeholder={t("searchPlaceholder")}
							size="sm"
							style={{ width: 300 }}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.currentTarget.value)}
							onKeyDown={handleSearchKeyDown}
							rightSection={
								<ActionIcon size="sm" variant="subtle" onClick={handleSearch}>
									<IconSearch size={16} />
								</ActionIcon>
							}
							visibleFrom="sm"
						/>
						{/* Mobile: toggle search input via icon */}
						{searchOpen ? (
							<TextInput
								placeholder={t("searchPlaceholder")}
								size="sm"
								style={{ flex: 1, minWidth: 0 }}
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.currentTarget.value)}
								onKeyDown={handleSearchKeyDown}
								rightSection={
									<ActionIcon size="sm" variant="subtle" onClick={handleSearch}>
										<IconSearch size={16} />
									</ActionIcon>
								}
								autoFocus
								hiddenFrom="sm"
							/>
						) : (
							<ActionIcon
								variant="subtle"
								color="gray"
								onClick={() => setSearchOpen(true)}
								title={t("searchPlaceholder")}
								hiddenFrom="sm"
							>
								<IconSearch size={18} />
							</ActionIcon>
						)}
						<ActionIcon variant="subtle" color="gray" onClick={logout} title={t("logout")}>
							<IconLogout size={18} />
						</ActionIcon>
					</Group>
				</Group>
			</AppShell.Header>

			<AppShell.Navbar p="md">
				<NavLink component={Link} to="/" label={t("dashboard")} />
				<NavLink component={Link} to="/projects" label={t("projects")} />
				<NavLink component={Link} to="/sessions" label={t("sessions")} />
				{user?.role === "admin" && <NavLink component={Link} to="/admin" label={t("admin")} />}
				<NavLink component={Link} to="/settings" label={t("settings")} />
			</AppShell.Navbar>

			<AppShell.Main>
				<Outlet />
			</AppShell.Main>
		</AppShell>
	);
}
