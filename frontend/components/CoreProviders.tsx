import { mantineTheme } from "@frontend/lib/mantine-theme";
import { queryClient } from "@frontend/lib/query-client";
import { MantineProvider, v8CssVariablesResolver } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
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
	return (
		<MantineProvider
			theme={mantineTheme}
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
