import { AppShell, Burger, Group, NavLink, TextInput, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	component: RootLayout,
});

function RootLayout() {
	const [opened, { toggle }] = useDisclosure();
	const [searchQuery, setSearchQuery] = useState("");
	const navigate = useNavigate();
	const { t } = useTranslation("nav");

	const handleSearchKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && searchQuery.trim()) {
			navigate({ to: "/search", search: { q: searchQuery.trim() } });
		}
	};

	return (
		<AppShell
			header={{ height: 60 }}
			navbar={{ width: 250, breakpoint: "sm", collapsed: { mobile: !opened } }}
			padding="md"
		>
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between">
					<Group>
						<Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
						<Title order={3}>{t("appName")}</Title>
					</Group>
					<Group>
						<TextInput
							placeholder={t("searchPlaceholder")}
							size="sm"
							style={{ width: 300 }}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.currentTarget.value)}
							onKeyDown={handleSearchKeyDown}
						/>
						<LanguageSwitcher />
					</Group>
				</Group>
			</AppShell.Header>

			<AppShell.Navbar p="md">
				<NavLink component={Link} to="/" label={t("dashboard")} />
				<NavLink component={Link} to="/projects" label={t("projects")} />
				<NavLink component={Link} to="/sessions" label={t("sessions")} />
				<NavLink component={Link} to="/settings" label={t("settings")} />
			</AppShell.Navbar>

			<AppShell.Main>
				<Outlet />
			</AppShell.Main>
		</AppShell>
	);
}
