import { Center, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { APP_SHELL_SAFE_VIEWPORT_HEIGHT } from "../../lib/safe-area";

export const Route = createFileRoute("/chapters/$chapterId")({
	component: ChapterRedirect,
});

function ChapterRedirect() {
	const { chapterId } = Route.useParams();
	// biome-ignore lint/suspicious/noExplicitAny: loose search params
	const search = useSearch({ strict: false }) as any;
	const from = search?.from as string | undefined;
	const location = useLocation();
	const navigate = useNavigate();

	// 查询 chapter 的 narrators，找到 primary narrator
	const { data: narrators } = useQuery({
		queryKey: ["narrators", { chapterId }],
		queryFn: () => api.listNarrators({ chapterId }),
	});

	useEffect(() => {
		if (!narrators) return;

		// 找到 primary narrator
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const primary = narrators.find((n: any) => n.variant === "primary");
		if (primary) {
			navigate({
				to: "/narrators/$narratorId",
				params: { narratorId: primary.id },
				search: from ? { from } : {},
				hash: location.hash || undefined,
				replace: true,
			});
		}
		// 如果没有 primary narrator，可能需要创建一个
		// 暂时先导航回项目页面
	}, [narrators, navigate, from, location.hash]);

	return (
		<Center h={APP_SHELL_SAFE_VIEWPORT_HEIGHT}>
			<Loader />
		</Center>
	);
}
