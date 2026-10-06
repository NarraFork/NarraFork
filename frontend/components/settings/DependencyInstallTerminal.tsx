import { useTerminalCapability } from "@frontend/hooks/usePlatform";
import { useTerminalWS } from "@frontend/hooks/useTerminalWS";
import { api } from "@frontend/lib/api";
import { Box, Loader, Text } from "@mantine/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { type InstallPhase, nextInstallAction } from "./dependency-install-progress";

interface DependencyInstallTerminalProps {
	command: string;
	onDone: () => void;
}

/**
 * Lightweight interactive terminal for dependency installation.
 * Creates a PTY, connects via WebSocket, auto-sends the install command,
 * and detects completion when the shell prompt returns.
 */
export function DependencyInstallTerminal({ command, onDone }: DependencyInstallTerminalProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const [terminalId, setTerminalId] = useState<string | undefined>();
	const [startError, setStartError] = useState<string | null>(null);
	const phaseRef = useRef<InstallPhase>("awaiting-prompt");
	const writingRef = useRef(false);
	// Output that arrived before xterm existed. Kept so the first prompt survives
	// the gap between subscribing and mounting the terminal.
	const pendingOutputRef = useRef("");
	const pendingScrollbackRef = useRef<{
		data: string;
		dims: { cols: number; rows: number };
	} | null>(null);
	const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const terminalCapability = useTerminalCapability();
	const terminalSupported = terminalCapability.supported;
	const terminalUnsupportedReason =
		terminalCapability.reason ?? "Terminal runtime is not available in this backend/runtime.";
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	const scheduleDone = () => {
		if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
		doneTimerRef.current = setTimeout(() => {
			doneTimerRef.current = null;
			onDoneRef.current();
		}, 800);
	};

	// Create terminal on mount
	useEffect(() => {
		if (!terminalSupported) return;
		let cancelled = false;
		setStartError(null);
		api
			.createTerminal({ name: "dep-install" })
			.then((t) => {
				if (cancelled) {
					api.deleteTerminal(t.id).catch(() => {});
					return;
				}
				setTerminalId(t.id);
			})
			.catch((err) => {
				if (cancelled) return;
				setStartError((err as Error)?.message ?? String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [terminalSupported]);

	/**
	 * Prompt-driven state machine, run once the bytes that may CONTAIN the prompt
	 * have actually landed in the buffer.
	 *
	 * Must be reachable from BOTH the live-output and the scrollback paths: the
	 * shell emits its first prompt as soon as it starts, which is before this
	 * component has finished an HTTP round trip and subscribed. That prompt is
	 * therefore replayed as a `scrollback` snapshot, never as `output`. Running
	 * this only on `output` meant the first prompt was never seen, so the install
	 * command was never sent and the window stayed blank forever.
	 *
	 * Every caller must schedule this through `term.write`'s completion callback,
	 * never straight after the call: xterm queues writes and parses them in a later
	 * task, so a synchronous check reads the buffer as it was BEFORE this chunk and
	 * can miss the prompt it was meant to find.
	 */
	const advanceOnPrompt = (term: Terminal, write: (data: string) => void) => {
		const line = term.buffer.active.getLine(term.buffer.active.cursorY);
		switch (nextInstallAction(phaseRef.current, line ? line.translateToString(true) : null)) {
			case "send-command":
				phaseRef.current = "running";
				write(`${command}\n`);
				break;
			case "finish":
				phaseRef.current = "done";
				// Small delay so user can see the final output
				scheduleDone();
				break;
			case "wait":
				break;
		}
	};
	// Held in a ref so the xterm-creation effect can call it without listing it as
	// a dependency: it is redefined every render, and depending on it would tear
	// down and rebuild the terminal (losing the buffer) on each one.
	const advanceOnPromptRef = useRef(advanceOnPrompt);
	advanceOnPromptRef.current = advanceOnPrompt;

	// WebSocket subscription
	const { write } = useTerminalWS(terminalId, {
		onOutput: (data) => {
			const term = termRef.current;
			// xterm is created in a later effect than the one that subscribes, so
			// early bytes can arrive with no terminal to write to. Hold them instead
			// of dropping them — dropping loses the prompt this component waits for.
			if (!term) {
				pendingOutputRef.current += data;
				return;
			}
			writingRef.current = true;
			term.write(data, () => {
				if (termRef.current === term) advanceOnPrompt(term, write);
			});
			writingRef.current = false;
		},
		onScrollback: (data, dims) => {
			const term = termRef.current;
			if (!term) {
				// A snapshot supersedes anything buffered so far, rather than appending.
				pendingScrollbackRef.current = { data, dims };
				pendingOutputRef.current = "";
				return;
			}
			writingRef.current = true;
			try {
				// Match the server-side buffer dimensions so wrapping is reproduced,
				// then let the ResizeObserver fit back to the container.
				term.resize(dims.cols, dims.rows);
				term.reset();
				term.write(data, () => {
					if (termRef.current === term) advanceOnPrompt(term, write);
				});
			} finally {
				writingRef.current = false;
			}
		},
		onError: (message) => {
			const term = termRef.current;
			if (term) term.write(`\r\n${message}\r\n`);
			else pendingOutputRef.current += `\r\n${message}\r\n`;
		},
		onExit: () => {
			// The shell exiting is terminal regardless of which phase we were in:
			// there will be no further prompt to wait for.
			if (phaseRef.current !== "done") {
				phaseRef.current = "done";
				scheduleDone();
			}
		},
	});

	// Create xterm instance
	useEffect(() => {
		if (!containerRef.current) return;
		const term = new Terminal({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
			theme: {
				background: "#1a1b26",
				foreground: "#c0caf5",
				cursor: "#c0caf5",
				selectionBackground: "#33467c",
			},
		});
		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(containerRef.current);
		fitAddon.fit();

		termRef.current = term;
		fitAddonRef.current = fitAddon;

		// Replay whatever arrived before this terminal existed, then run the prompt
		// check on it: the first prompt is usually in there, and it is the trigger
		// that sends the install command.
		const pendingScrollback = pendingScrollbackRef.current;
		const pendingOutput = pendingOutputRef.current;
		pendingScrollbackRef.current = null;
		pendingOutputRef.current = "";
		const replay = `${pendingScrollback?.data ?? ""}${pendingOutput}`;
		if (replay) {
			writingRef.current = true;
			try {
				if (pendingScrollback) {
					term.resize(pendingScrollback.dims.cols, pendingScrollback.dims.rows);
				}
				// term.write is asynchronous: the buffer only holds these bytes by the
				// time the callback runs. Checking the prompt synchronously after this
				// call would read a still-empty line and miss it.
				term.write(replay, () => {
					if (termRef.current === term) advanceOnPromptRef.current(term, write);
				});
			} finally {
				writingRef.current = false;
			}
			if (pendingScrollback) fitAddon.fit();
		}

		// Forward user input to terminal
		const dataDisposable = term.onData((data) => {
			if (writingRef.current) return;
			write(data);
		});

		// Auto-fit on resize
		const observer = new ResizeObserver(() => {
			fitAddon.fit();
		});
		observer.observe(containerRef.current);

		return () => {
			observer.disconnect();
			dataDisposable.dispose();
			term.dispose();
			termRef.current = null;
			fitAddonRef.current = null;
		};
	}, [write]);

	// Cleanup: cancel delayed completion callback on unmount
	useEffect(() => {
		return () => {
			if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
		};
	}, []);

	// Cleanup: delete terminal on unmount
	useEffect(() => {
		return () => {
			if (terminalId) {
				api.deleteTerminal(terminalId).catch(() => {});
			}
		};
	}, [terminalId]);

	if (!terminalSupported) {
		return (
			<Box py="xl" style={{ textAlign: "center" }}>
				<Text size="xs" c="dimmed">
					{terminalUnsupportedReason}
				</Text>
			</Box>
		);
	}

	if (startError) {
		return (
			<Box py="xl" style={{ textAlign: "center" }}>
				<Text size="xs" c="red">
					{startError}
				</Text>
			</Box>
		);
	}

	if (!terminalId) {
		return (
			<Box py="xl" style={{ textAlign: "center" }}>
				<Loader size="sm" />
				<Text size="xs" c="dimmed" mt="xs">
					Starting terminal…
				</Text>
			</Box>
		);
	}

	return (
		<Box
			ref={containerRef}
			style={{
				height: 300,
				borderRadius: 6,
				overflow: "hidden",
				padding: 4,
			}}
		/>
	);
}
