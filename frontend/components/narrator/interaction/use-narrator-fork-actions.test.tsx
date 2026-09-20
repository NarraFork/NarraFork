import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as narratorHooks from "../../../hooks/useNarrator";
import {
	type UseNarratorForkActionsOptions,
	type UseNarratorForkActionsResult,
	useNarratorForkActions,
} from "./use-narrator-fork-actions";

type ForkInput = { narratorId: string; forkMessageId: string };
type ForkCallbacks = { onSuccess: (narrator: { id: string }) => void };
let mutate: ReturnType<typeof mock<(input: ForkInput, callbacks: ForkCallbacks) => void>>;
let root: Root;
let actions: UseNarratorForkActionsResult;
let rowRenders: number;
let restoreHooks: () => void;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Row = memo(({ fork }: { fork: UseNarratorForkActionsResult["forkHandler"] }) => {
	rowRenders++;
	return (
		<button type="button" onClick={() => fork?.("message")}>
			Fork
		</button>
	);
});

function Probe(options: UseNarratorForkActionsOptions) {
	actions = useNarratorForkActions(options);
	return <Row fork={actions.forkHandler} />;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	rowRenders = 0;
	mutate = mock((_input: ForkInput, _callbacks: ForkCallbacks) => {});
	const fork = spyOn(narratorHooks, "useForkNarrator").mockImplementation(
		() => ({ mutate }) as unknown as ReturnType<typeof narratorHooks.useForkNarrator>,
	);
	const ask = spyOn(narratorHooks, "useStartAskInPassing").mockReturnValue({
		mutate: mock(() => {}),
	} as unknown as ReturnType<typeof narratorHooks.useStartAskInPassing>);
	restoreHooks = () => {
		fork.mockRestore();
		ask.mockRestore();
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	restoreHooks();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(overrides: Partial<UseNarratorForkActionsOptions> = {}) {
	await act(async () => {
		root.render(
			<Probe
				narratorId="narrator-a"
				chapterId={null}
				onForkFromMessage={undefined}
				navigateToNarrator={() => {}}
				{...overrides}
			/>,
		);
	});
}

describe("narrator fork action identity", () => {
	test("inline navigation on unrelated renders does not invalidate memoized rows", async () => {
		await render();
		const first = actions.forkHandler;
		const references = new Set([first]);
		for (let i = 0; i < 5; i++) {
			await render();
			references.add(actions.forkHandler);
		}
		expect(references.size).toBe(1);
		expect(rowRenders).toBe(1);
		first?.("source-message");
		expect(mutate.mock.calls[0]?.[0]).toEqual({
			narratorId: "narrator-a",
			forkMessageId: "source-message",
		});
	});

	test("the stable handler uses the latest mutation and navigation at success time", async () => {
		const oldNavigate = mock((_id: string) => {});
		const newNavigate = mock((_id: string) => {});
		await render({ navigateToNarrator: oldNavigate });
		const first = actions.forkHandler;
		const oldMutate = mutate;
		mutate = mock((_input: ForkInput, _callbacks: ForkCallbacks) => {});
		await render({ navigateToNarrator: oldNavigate });
		expect(actions.forkHandler).toBe(first);
		first?.("source-message");
		expect(oldMutate).not.toHaveBeenCalled();
		expect(mutate).toHaveBeenCalledTimes(1);
		const onSuccess = mutate.mock.calls[0]?.[1].onSuccess;
		await render({ navigateToNarrator: newNavigate });
		onSuccess?.({ id: "forked-narrator" });
		expect(oldNavigate).not.toHaveBeenCalled();
		expect(newNavigate).toHaveBeenCalledWith("forked-narrator");
		expect(actions.forkHandler).toBe(first);
	});

	test("switching narrators replaces the handler and forks the new narrator", async () => {
		await render();
		const first = actions.forkHandler;
		await render({ narratorId: "narrator-b" });
		expect(actions.forkHandler).not.toBe(first);
		actions.forkHandler?.("new-message");
		expect(mutate.mock.calls[0]?.[0]).toEqual({
			narratorId: "narrator-b",
			forkMessageId: "new-message",
		});
	});

	test("chapter hosts retain ownership and a changed host callback takes effect", async () => {
		const host = mock((_id: string) => {});
		const replacement = mock((_id: string) => {});
		await render({ chapterId: "chapter", onForkFromMessage: host });
		await render({ chapterId: "chapter", onForkFromMessage: host });
		expect(actions.forkHandler).toBe(host);
		expect(rowRenders).toBe(1);
		actions.forkHandler?.("host-message");
		expect(host).toHaveBeenCalledWith("host-message");

		await render({ chapterId: "other-chapter", onForkFromMessage: replacement });
		expect(actions.forkHandler).toBe(replacement);
		actions.forkHandler?.("replacement-message");
		expect(replacement).toHaveBeenCalledWith("replacement-message");
		expect(host).toHaveBeenCalledTimes(1);
		expect(mutate).not.toHaveBeenCalled();

		await render({ chapterId: "chapter" });
		expect(actions.forkHandler).toBeUndefined();
		await render();
		actions.forkHandler?.("standalone-message");
		expect(mutate.mock.calls[0]?.[0].forkMessageId).toBe("standalone-message");
	});
});
