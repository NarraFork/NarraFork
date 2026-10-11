//go:build windows

package winpty

import (
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var kernel32 = windows.NewLazySystemDLL("kernel32.dll")

// Supported requires both the correct 1809 build and dynamically present APIs.
func Supported() bool {
	version := windows.RtlGetVersion()
	if version.MajorVersion < 10 || version.BuildNumber < 17763 {
		return false
	}
	for _, name := range []string{"CreatePseudoConsole", "ResizePseudoConsole", "ClosePseudoConsole", "InitializeProcThreadAttributeList", "UpdateProcThreadAttribute"} {
		if kernel32.NewProc(name).Find() != nil {
			return false
		}
	}
	return true
}

func environmentBlock(env []string) ([]uint16, error) {
	// Windows environment names are case-insensitive; the last override wins.
	byKey := make(map[string]string)
	for _, entry := range env {
		i := strings.IndexByte(entry, '=')
		if i == 0 {
			i = strings.IndexByte(entry[1:], '=') + 1
		} // native =C: entries
		if i <= 0 || strings.ContainsRune(entry, 0) {
			return nil, fmt.Errorf("invalid Windows environment entry")
		}
		byKey[strings.ToUpper(entry[:i])] = entry
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var result []uint16
	for _, key := range keys {
		entry, err := windows.UTF16FromString(byKey[key])
		if err != nil {
			return nil, err
		}
		result = append(result, entry...)
	}
	result = append(result, 0)
	if len(result) == 1 {
		result = append(result, 0)
	}
	return result, nil
}

func createProcess(command []string, cwd string, env []string, si *windows.StartupInfo, inherit bool) (windows.ProcessInformation, error) {
	var pi windows.ProcessInformation
	if len(command) == 0 {
		return pi, fmt.Errorf("missing Windows shell command")
	}
	exe, err := exec.LookPath(command[0])
	if err != nil {
		return pi, err
	}
	app, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return pi, err
	}
	args := make([]string, len(command))
	args[0] = windows.EscapeArg(exe)
	for i := 1; i < len(command); i++ {
		args[i] = windows.EscapeArg(command[i])
	}
	cmd, err := windows.UTF16PtrFromString(strings.Join(args, " "))
	if err != nil {
		return pi, err
	}
	dir, err := windows.UTF16PtrFromString(cwd)
	if err != nil {
		return pi, err
	}
	block, err := environmentBlock(env)
	if err != nil {
		return pi, err
	}
	flags := uint32(windows.CREATE_UNICODE_ENVIRONMENT | windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_SUSPENDED)
	if inherit {
		flags |= windows.CREATE_NO_WINDOW
	} // Hidden executor worker, not the ConPTY shell.
	err = windows.CreateProcess(app, cmd, nil, nil, inherit,
		flags,
		&block[0], dir, si, &pi)
	return pi, err
}

func newJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
	if err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	// No BREAKAWAY flags and no inheritable security attributes.
	return job, nil
}

func isProcessInJob(process, job windows.Handle) (bool, error) {
	var result int32 // Win32 BOOL is 32 bits, not Go bool.
	ok, _, err := kernel32.NewProc("IsProcessInJob").Call(uintptr(process), uintptr(job), uintptr(unsafe.Pointer(&result)))
	if ok == 0 {
		return false, err
	}
	return result != 0, nil
}

func activeProcesses(job windows.Handle) (uint32, error) {
	// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION has a stable 48-byte layout on both
	// supported architectures. ActiveProcesses is the uint32 at byte 40.
	var info struct {
		User, Kernel, PeriodUser, PeriodKernel int64
		Faults, Total, Active, Terminated      uint32
	}
	err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil)
	return info.Active, err
}
