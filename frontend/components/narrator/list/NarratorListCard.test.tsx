import { describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NarratorListItem } from "./NarratorListCard";

// 卡片只认 i18n 文案和路由 Link：把两者换成最薄的一层，测试断言的就是纯结构。
const reactI18next = await import("react-i18next");
mock.module("react-i18next", () => ({
	...reactI18next,
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) =>
			options?.count === undefined ? key : `${key}:${options.count}`,
	}),
}));
mock.module("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string;
		params?: { narratorId?: string };
		children?: ReactNode;
	}) => (
		<a {...rest} href={params?.narratorId ? to.replace("$narratorId", params.narratorId) : to}>
			{children}
		</a>
	),
}));

const { NarratorListCard } = await import("./NarratorListCard");

function session(overrides: Partial<NarratorListItem> = {}): NarratorListItem {
	return {
		id: "main",
		title: "Main session",
		status: "idle",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function child(id: string, title: string): NarratorListItem {
	return {
		id,
		title,
		status: "idle",
		isAskInPassing: true,
		parentNarratorId: "main",
		createdAt: "2026-01-02T00:00:00Z",
	};
}

function render(ui: ReactNode) {
	return renderToStaticMarkup(
		<MantineProvider>
			<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
		</MantineProvider>,
	);
}

function activeCard(narrator: NarratorListItem, expanded?: boolean) {
	return render(
		<NarratorListCard
			variant="active"
			narrator={narrator}
			localQuery=""
			defaultModelValue="model"
			onOpen={() => {}}
			onArchive={() => {}}
			onToggleAskInPassing={() => {}}
			onOpenAskInPassing={() => {}}
			askInPassingExpanded={expanded}
		/>,
	);
}

describe("会话卡片上的顺便提问子会话", () => {
	test("没有子会话时不出现折叠按钮", () => {
		const html = activeCard(session());
		expect(html).not.toContain("askInPassingSessions");
	});

	test("有子会话时按钮带上数量，默认不展开", () => {
		const html = activeCard(
			session({ askInPassingSessions: [child("kid-1", "Kid one"), child("kid-2", "Kid two")] }),
		);
		expect(html).toContain("askInPassingSessions:2");
		// 桌面与移动两套布局各一个，收起态的 aria-expanded 都是 false。
		expect(html.split('aria-expanded="false"').length - 1).toBe(2);
		expect(html).not.toContain("Kid one");
	});

	test("展开后在主会话下面渲染子会话", () => {
		const html = activeCard(session({ askInPassingSessions: [child("kid-1", "Kid one")] }), true);
		expect(html.split('aria-expanded="true"').length - 1).toBe(2);
		expect(html).toMatch(/<button[^>]*type="button"[^>]*>(?:(?!<\/button>).)*Kid one/);
	});

	test("归档页的卡片同样能展开子会话", () => {
		const html = render(
			<NarratorListCard
				variant="archived"
				narrator={session({
					status: "archived",
					askInPassingSessions: [child("kid-1", "Kid one")],
				})}
				localQuery=""
				defaultModelValue="model"
				onUnarchive={() => {}}
				onDelete={() => {}}
				onToggleAskInPassing={() => {}}
				onOpenAskInPassing={() => {}}
				askInPassingExpanded
			/>,
		);
		expect(html).toContain("askInPassingSessions:1");
		expect(html).toContain("Kid one");
	});
});
