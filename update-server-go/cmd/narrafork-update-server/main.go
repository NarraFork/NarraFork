package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"narrafork-update-server/internal/updateserver"
)

func main() {
	if err := run(); err != nil {
		slog.Error("update server stopped with error", "error", err)
		os.Exit(1)
	}
}

func run() error {
	configPath := flag.String("config", "config.json", "path to config.json")
	portOverride := flag.Int("port", 0, "HTTP listen port override")
	hostOverride := flag.String("host", "", "HTTP listen host override")
	debug := flag.Bool("debug", false, "enable debug logging")
	flag.Parse()

	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))

	absConfig, err := filepath.Abs(*configPath)
	if err != nil {
		return err
	}
	store, adminToken, err := updateserver.InitConfig(absConfig)
	if err != nil {
		return err
	}
	if adminToken != "" {
		fmt.Println()
		fmt.Println("╔══════════════════════════════════════════════════════════════╗")
		fmt.Println("║  First run — admin token generated (save it now!):         ║")
		fmt.Printf("║  %-58s║\n", adminToken)
		fmt.Println("╚══════════════════════════════════════════════════════════════╝")
		fmt.Println()
	}

	cfg := store.Config()
	port := cfg.Port
	if *portOverride != 0 {
		port = *portOverride
	}
	host := cfg.Host
	if *hostOverride != "" {
		host = *hostOverride
	}
	storage, err := updateserver.NewLocalStorage(store.DataDir())
	if err != nil {
		return err
	}
	app := updateserver.NewApp(store, storage)
	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", host, port),
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		slog.Info("NarraFork Go update server listening", "addr", server.Addr, "config", store.ConfigPath(), "dataDir", storage.BaseDir())
		serverErr <- server.ListenAndServe()
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(ctx)
	}
}
