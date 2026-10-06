import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/oauth-apps")({
	component: () => <Navigate to="/settings/oauth-apps" replace />,
});
