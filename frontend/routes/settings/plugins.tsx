import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/plugins")({
	component: Outlet,
});
