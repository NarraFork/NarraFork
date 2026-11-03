/**
 * The status bar's awaiting-confirmation badge (outline P2 PR 5; review round 1 S8 and nits): it
 * shows only while a goal waits, says "your confirmation" only to someone who decides one, and
 * opens the task board when clicked.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("@mantine/core", () => ({
	UnstyledButton: ({
		children,
		onClick,
		...rest
	}: {
		children?: ReactNode;
		onClick?: () => void;
		"data-testid"?: string;
		"data-yours"?: string;
	}) => (
		<button type="button" onClick={onClick} {...rest}>
			{children}
		</button>
	),
	Badge: ({ children, color }: { children?: ReactNode; color?: string }) => (
		<span data-color={color}>{children}</span>
	),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count?: number; names?: string }) =>
			`${key}:${options?.count ?? ""}${options?.names ? `:${options.names}` : ""}`,
	}),
}));

const { AwaitingConfirmationBadge, awaitingConfirmationText } = await import(
	"./AwaitingConfirmationBadge"
);

let root: Root;
let container: HTMLElement;
beforeEach(() => {
	const { document, window } = parseHTML(
		"<!doctype html><html><body><div id=root></div></body></html>",
	);
	Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
	container = document.getElementById("root") as unknown as HTMLElement;
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
});

const t = (key: string, options: { count: number; names?: string }) =>
	`${key}:${options.count}${options.names ? `:${options.names}` : ""}`;

test("the text: nothing waiting, waiting for the viewer, waiting for someone else", () => {
	expect(awaitingConfirmationText(null, t)).toBeNull();
	expect(awaitingConfirmationText({ total: 0, yours: 0 }, t)).toBeNull();
	expect(awaitingConfirmationText({ total: 2, yours: 1 }, t)).toBe("board.statusBar.awaitingYou:1");
	expect(awaitingConfirmationText({ total: 2, yours: 0 }, t)).toBe(
		"board.statusBar.awaitingOthers:2",
	);
	// Someone else decides: named (the locker; a session confirming for them is not "you").
	expect(awaitingConfirmationText({ total: 2, yours: 0, from: ["alice", "bob"] }, t)).toBe(
		"board.statusBar.awaitingFrom:2:alice, bob",
	);
	expect(awaitingConfirmationText({ total: 2, yours: 1, from: ["bob"] }, t)).toBe(
		"board.statusBar.awaitingYou:1",
	);
});

test("the badge renders per viewer and opens the board", async () => {
	const onOpen = mock(() => {});
	await act(async () => root.render(<AwaitingConfirmationBadge counts={{ total: 0, yours: 0 }} />));
	expect(container.querySelector('[data-testid="status-awaiting-confirmation"]')).toBeNull();

	await act(async () =>
		root.render(<AwaitingConfirmationBadge counts={{ total: 1, yours: 1 }} onOpen={onOpen} />),
	);
	const mine = container.querySelector('[data-testid="status-awaiting-confirmation"]');
	expect(mine?.getAttribute("data-yours")).toBe("true");
	expect(mine?.textContent).toBe("board.statusBar.awaitingYou:1");
	(mine as unknown as { click: () => void }).click();
	expect(onOpen).toHaveBeenCalledTimes(1);

	await act(async () => root.render(<AwaitingConfirmationBadge counts={{ total: 1, yours: 0 }} />));
	const theirs = container.querySelector('[data-testid="status-awaiting-confirmation"]');
	expect(theirs?.getAttribute("data-yours")).toBe("false");
	expect(theirs?.textContent).toBe("board.statusBar.awaitingOthers:1");
});
