import { Center, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "../../lib/api";

export const Route = createFileRoute("/chapters/$chapterId")({
	component: ChapterRedirect,
});

function ChapterRedirect() {
	const { chapterId } = Route.useParams();
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
		const primary = narrators.find((n: any) => n.type === "primary");
		if (primary) {
			navigate({
				to: "/narrators/$narratorId",
				params: { narratorId: primary.id },
				replace: true,
			});
		}
		// 如果没有 primary narrator，可能需要创建一个
		// 暂时先导航回项目页面
	}, [narrators, navigate]);

	return (
		<Center h="100vh">
			<Loader />
		</Center>
	);
}
