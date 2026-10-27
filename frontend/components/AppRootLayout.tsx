import {
	Box,
	Button,
	Center,
	Container,
	Group,
	Loader,
	Text,
	Title,
	useComputedColorScheme,
} from "@mantine/core";
import {
	type ErrorComponentProps,
	Link,
	Outlet,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { getToken } from "../lib/api";
import { isPublicNarratorSharePath } from "../lib/app-path-classify";
import { APP_SHELL_NAMESPACES, getNamespacesForPath } from "../lib/i18n";
import { isStandaloneWindowPath } from "../lib/standalone-window";
import { I18nNamespaceGate } from "./common/I18nNamespaceGate";

const AuthenticatedLayout = lazy(() =>
	import("./AuthenticatedAppLayout").then((module) => ({ default: module.AuthenticatedLayout })),
);

export function RootErrorBoundary({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const { t } = useTranslation("common");
	const isDev = import.meta.env.DEV;
	const computedScheme = useComputedColorScheme("dark");
	const isDark = computedScheme === "dark";

	return (
		<Center h="100vh">
			<Container size="sm" ta="center">
				<Title order={2} mb="md">
					{t("somethingWentWrong")}
				</Title>
				<Text c="dimmed" mb="xl">
					{error.message || t("unexpectedError")}
				</Text>
				{isDev && error.stack && (
					<Box
						mb="xl"
						p="sm"
						ta="left"
						style={{
							background: isDark ? "var(--mantine-color-dark-7)" : "var(--mantine-color-gray-0)",
							border: `1px solid ${
								isDark ? "var(--mantine-color-dark-4)" : "var(--mantine-color-gray-3)"
							}`,
							borderRadius: "var(--mantine-radius-sm)",
							overflow: "auto",
							maxHeight: 400,
						}}
					>
						<Text
							size="xs"
							ff="monospace"
							style={{
								color: isDark ? "var(--mantine-color-gray-2)" : "var(--mantine-color-dark-8)",
								whiteSpace: "pre-wrap",
							}}
						>
							{error.stack}
						</Text>
					</Box>
				)}
				<Group justify="center">
					<Button
						variant="default"
						onClick={() => {
							reset();
							router.invalidate();
						}}
					>
						{t("retry")}
					</Button>
					<Button component={Link} to="/">
						{t("backToHome")}
					</Button>
				</Group>
			</Container>
		</Center>
	);
}

export function RootLayout() {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const publicSurface =
		pathname === "/login" || pathname === "/oauth/authorize" || isPublicNarratorSharePath(pathname);
	const publicPage =
		pathname === "/licenses" ||
		pathname === "/changelog" ||
		(import.meta.env.DEV && pathname === "/dev-vlist-harness");
	// Window chrome owns its local gate so slow panel resources never delay the frame.
	if (isStandaloneWindowPath(pathname)) return <Outlet />;
	if (publicSurface || (publicPage && !getToken())) {
		return (
			<I18nNamespaceGate namespaces={getNamespacesForPath(pathname)}>
				<Outlet />
			</I18nNamespaceGate>
		);
	}
	return (
		<Suspense
			fallback={
				<Center h="100dvh">
					<Loader />
				</Center>
			}
		>
			<I18nNamespaceGate namespaces={APP_SHELL_NAMESPACES}>
				<AuthenticatedLayout />
			</I18nNamespaceGate>
		</Suspense>
	);
}
