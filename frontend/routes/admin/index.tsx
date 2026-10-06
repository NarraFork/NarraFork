import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/")({
	component: () => <Navigate to="/settings/providers" replace />,
});
