import { useAppBackground } from "@frontend/hooks/useAppBackground";
import { usePaletteChoice } from "@frontend/hooks/usePaletteChoice";
import { mantineTheme } from "@frontend/lib/mantine-theme";
import { queryClient } from "@frontend/lib/query-client";
import { createTheme, MantineProvider, v8CssVariablesResolver } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { AppNotifications } from "./AppNotifications";
import { ConfirmDialogProvider } from "./common/ConfirmDialogProvider";
import { ImageViewerProvider } from "./common/ImageViewerProvider";

/** Presentation/query providers only: no plugins, PWA, branding or application shell. */
export function CoreProviders({
	children,
	notifications = true,
}: {
	children: ReactNode;
	notifications?: boolean;
}) {
	/*
	 * The chosen accent is applied through the theme, not through CSS variables.
	 * Mantine precomputes `-light` / `-contrast` / `-outline-hover` from the palette at
	 * provider level, so overriding only the ten shades would leave those derived values on
	 * the old hue (a blue "green" button on hover). Rebuilding the theme is allowed to
	 * re-render; picking a colour is a rare, deliberate action.
	 *
	 * The neutral surfaces are NOT part of this: they ride on CSS variables written by
	 * `usePaletteChoice`, which costs no re-render at all.
	 */
	const { resolved } = usePaletteChoice();
	// Applying the wallpaper is an effect, not a value: subscribing here (rather than only
	// in the settings card) is what keeps it live on every route.
	useAppBackground();
	const theme = useMemo(
		() =>
			createTheme({
				...mantineTheme,
				colors: { ...mantineTheme.colors, indigo: resolved.accent },
			}),
		[resolved.accent],
	);

	return (
		<MantineProvider
			theme={theme}
			defaultColorScheme="auto"
			cssVariablesResolver={v8CssVariablesResolver}
		>
			<DatesProvider settings={{ firstDayOfWeek: 1 }}>
				<ConfirmDialogProvider>
					<ImageViewerProvider>
						{notifications && <AppNotifications />}
						<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
					</ImageViewerProvider>
				</ConfirmDialogProvider>
			</DatesProvider>
		</MantineProvider>
	);
}
