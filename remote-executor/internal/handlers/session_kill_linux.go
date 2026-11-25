//go:build linux

package handlers

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// killPtySession SIGKILLs every process in session sid: the shell, its own
// process group, and job-control groups the shell created for `cmd &` jobs.
// Processes that called setsid themselves have left the terminal and are not
// touched.
func killPtySession(sid int) {
	_ = syscall.Kill(-sid, syscall.SIGKILL)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 1 {
			continue
		}
		if procSession(pid) == sid {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// procSession reads the session id from /proc/<pid>/stat, or -1.
func procSession(pid int) int {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return -1
	}
	// "pid (comm) state ppid pgrp session ..."; comm may contain spaces or ')'.
	stat := string(raw)
	end := strings.LastIndexByte(stat, ')')
	if end < 0 {
		return -1
	}
	fields := strings.Fields(stat[end+1:])
	if len(fields) < 4 {
		return -1
	}
	sid, err := strconv.Atoi(fields[3])
	if err != nil {
		return -1
	}
	return sid
}
