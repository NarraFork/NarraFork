import { useTerminalCapability } from "@frontend/hooks/usePlatform";
import { useTerminalWS } from "@frontend/hooks/useTerminalWS";
import { api } from "@frontend/lib/api";
import { Box, Loader, Text } from "@mantine/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

interface DependencyInstallTerminalProps {
	command: string;
	onDone: () => void;
}

// Shell prompt patterns: user@host:dir$ / root:/# / bash-5.1$ / etc.
// Uses (?<!\d) to avoid matching progress indicators like "50%" or "100>".
const PROMPT_RE = /(?<!\d)[\w@.\-~:/]+[$#>%]\s*$/;

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
	const commandSentRef = useRef(false);
	const doneRef = useRef(false);
	const writingRef = useRef(false);
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

	// WebSocket subscription
	const { write } = useTerminalWS(terminalId, {
		onOutput: (data) => {
			const term = termRef.current;
			if (!term) return;
			writingRef.current = true;
			term.write(data);
			writingRef.current = false;

			// Detect prompt in the last line of visible buffer
			if (!commandSentRef.current) {
				// Before command: wait for first prompt, then send command
				const line = term.buffer.active.getLine(term.buffer.active.cursorY);
				if (line) {
					const text = line.translateToString(true);
					if (PROMPT_RE.test(text)) {
						commandSentRef.current = true;
						write(`${command}\n`);
					}
				}
			} else if (!doneRef.current) {
				// After command: detect next prompt = install finished
				const line = term.buffer.active.getLine(term.buffer.active.cursorY);
				if (line) {
					const text = line.translateToString(true);
					if (PROMPT_RE.test(text)) {
						doneRef.current = true;
						// Small delay so user can see the final output
						scheduleDone();
					}
				}
			}
		},
		onExit: () => {
			if (!doneRef.current) {
				doneRef.current = true;
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
