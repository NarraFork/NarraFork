// Command history-fixture is an isolated test-only JSON-lines bridge to the real
// executor history/metadata RPC handlers. It does not connect to a server.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/history"
	"github.com/narrafork/remote-executor/internal/rpc"
)

type request struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}
type response struct {
	ID     string `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func main() {
	root := flag.String("root", "", "explicit test root directory")
	state := flag.String("state-dir", "", "explicit isolated test state directory")
	flag.Parse()
	if *root == "" || *state == "" {
		fmt.Fprintln(os.Stderr, "explicit --root and --state-dir test fixtures required")
		os.Exit(2)
	}
	guard := handlers.NewPathGuard([]string{*root})
	if err := guard.ExcludePrivateDirectories(*state); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	manager, err := history.New(*state, func(path string, create bool) (string, error) {
		if create {
			return guard.CheckCreate(path)
		}
		return guard.CheckExisting(path)
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer manager.Close()
	h := handlers.New(guard, 10<<20)
	h.SetHistory(manager)
	if err := h.ConfigureAttachmentStateDirectory(*state + "-attachments"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	dispatcher := rpc.NewDispatcher(h)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), 10<<20)
	writer := bufio.NewWriter(os.Stdout)
	for scanner.Scan() {
		var call request
		output := response{}
		if err := json.Unmarshal(scanner.Bytes(), &call); err != nil {
			output.Error = "invalid JSON request"
		} else {
			output.ID = call.ID
			ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
			result, err := dispatcher.Dispatch(ctx, call.Method, call.Params, nil)
			cancel()
			if err != nil {
				output.Error = err.Error()
			} else {
				output.Result = result
			}
		}
		data, err := json.Marshal(output)
		if err != nil {
			fmt.Fprintln(os.Stderr, "result serialization failed")
			os.Exit(1)
		}
		if len(data) > 2<<20 {
			data, _ = json.Marshal(response{ID: call.ID, Error: "test bridge output budget"})
		}
		if _, err := writer.Write(append(data, '\n')); err != nil {
			os.Exit(1)
		}
		if err := writer.Flush(); err != nil {
			os.Exit(1)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
