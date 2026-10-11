package handlers

import (
	"os"
	"runtime"
)

// loginShell returns the shell + args to run a command string, mirroring the
// server's LocalBackend shell selection at a basic level. On Windows it uses
// PowerShell; elsewhere it uses $SHELL (or /bin/sh) with -c.
func loginShell(command string) (string, []string) {
	if runtime.GOOS == "windows" {
		shell := "powershell.exe"
		return shell, []string{"-NoProfile", "-NonInteractive", "-Command", command}
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return shell, []string{"-c", command}
}

// interactiveShell intentionally does not reuse non-interactive PowerShell flags
// or Unix login options on Windows. Explicit caller cmd[] remains supported.
func interactiveShell() []string {
	if runtime.GOOS == "windows" {
		return []string{"powershell.exe", "-NoLogo", "-NoProfile"}
	}
	shell, _ := loginShell("")
	return []string{shell, "-l"}
}

// commandEnv builds the environment for an exec. In fresh mode it keeps a
// minimal set; otherwise it inherits the executor process env. Extra overrides
// from params.env are applied last.
func commandEnv(freshEnv bool, params map[string]any) []string {
	var env []string
	if freshEnv && runtime.GOOS == "windows" {
		// Keep only the Windows bootstrap variables, not Unix-only login state.
		for _, key := range []string{"SystemRoot", "SystemDrive", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE"} {
			if value, ok := os.LookupEnv(key); ok {
				env = append(env, key+"="+value)
			}
		}
	} else if freshEnv {
		env = []string{
			"HOME=" + os.Getenv("HOME"),
			"PATH=" + os.Getenv("PATH"),
			"TERM=" + orDefault(os.Getenv("TERM"), "xterm-256color"),
			"LANG=" + orDefault(os.Getenv("LANG"), "en_US.UTF-8"),
		}
	} else {
		env = os.Environ()
	}
	if overrides, ok := params["env"].(map[string]any); ok {
		for k, v := range overrides {
			if s, ok := v.(string); ok {
				env = append(env, k+"="+s)
			}
		}
	}
	return env
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
