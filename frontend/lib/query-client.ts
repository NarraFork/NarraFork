import { notifications } from "@mantine/notifications";
import { QueryClient } from "@tanstack/react-query";
import type { ApiError } from "./api";
import i18n from "./i18n";

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 5_000,
			retry: 1,
		},
		mutations: {
			onError: (error) => {
				const status = (error as ApiError)?.status;
				if (status === 401) return;

				notifications.show({
					title: i18n.t("common:operationFailed"),
					message: error.message || i18n.t("common:unexpectedError"),
					color: "red",
				});
			},
		},
	},
});
