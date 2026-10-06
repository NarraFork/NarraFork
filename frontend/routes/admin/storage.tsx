import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/storage")({
	component: () => <Navigate to="/settings/storage" replace />,
});
