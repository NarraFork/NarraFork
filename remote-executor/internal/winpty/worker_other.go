//go:build !windows

package winpty

func Supported() bool { return false }
func RunWorker(args []string) (bool, int) {
	if len(args) > 0 && args[0] == WorkerFlag {
		return true, 2
	}
	return false, 0
}
