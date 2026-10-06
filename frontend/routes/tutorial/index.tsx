import { createFileRoute, redirect } from "@tanstack/react-router";

// Preserve old bookmarks without mounting or starting the retired tutorial.
export const Route = createFileRoute("/tutorial/")({
	beforeLoad: () => {
		throw redirect({ to: "/learn", replace: true });
	},
});
