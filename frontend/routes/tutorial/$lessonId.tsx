import { createFileRoute, redirect } from "@tanstack/react-router";

// Lesson links now lead to the independent learning guide, without provisioning a session.
export const Route = createFileRoute("/tutorial/$lessonId")({
	beforeLoad: () => {
		throw redirect({ to: "/learn", replace: true });
	},
});
