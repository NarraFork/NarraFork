import { TaskPageFrame } from "@frontend/components/scheduled-tasks/TaskPageFrame";
import {
	parseScheduledTaskDetailSearch,
	parseScheduledTaskSearch,
} from "@frontend/lib/scheduled-task-search";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/scheduled-tasks/$taskId")({
	validateSearch: parseScheduledTaskDetailSearch,
	component: ScheduledTaskLayout,
});

function ScheduledTaskLayout() {
	const { taskId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<TaskPageFrame
			id={taskId}
			onBack={() =>
				void navigate({ to: "/scheduled-tasks", search: parseScheduledTaskSearch(search) })
			}
		>
			<Outlet />
		</TaskPageFrame>
	);
}
