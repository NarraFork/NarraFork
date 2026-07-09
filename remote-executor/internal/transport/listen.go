package transport

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/rpc"
)

// Server implements direct mode: the executor listens for the NarraFork server
// to connect, then sends hello and serves RPCs over the accepted connection.
// It reuses Client's serve loop by constructing a per-connection Client.
type Server struct {
	cfg        *config.Config
	dispatcher *rpc.Dispatcher
	platform   rpc.Platform
	caps       rpc.Capabilities
}

func NewServer(cfg *config.Config, dispatcher *rpc.Dispatcher, platform rpc.Platform, caps rpc.Capabilities) *Server {
	return &Server{cfg: cfg, dispatcher: dispatcher, platform: platform, caps: caps}
}

// Run starts the HTTP/WS listener until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/device", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			log.Printf("accept failed: %v", err)
			return
		}
		conn.SetReadLimit(64 * 1024 * 1024)
		log.Printf("server connected from %s", r.RemoteAddr)
		s.handleConn(ctx, conn)
	})

	httpServer := &http.Server{
		Addr:              s.cfg.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	log.Printf("listening for direct connections on %s", s.cfg.ListenAddr)
	err := httpServer.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) handleConn(ctx context.Context, conn *websocket.Conn) {
	defer conn.CloseNow()

	// Reuse the Client machinery over this accepted connection.
	client := NewClient(s.cfg, s.dispatcher, s.platform, s.caps)
	client.conn = conn

	// Send hello. In direct mode the server supplies the real device identity,
	// so deviceRef/token here are informational only.
	hello := rpc.HelloFrame{
		Type:            "hello",
		ProtocolVersion: rpc.ProtocolVersion,
		DeviceRef:       s.cfg.DeviceRef,
		Token:           s.cfg.Token,
		AgentVersion:    agentVersion,
		Platform:        s.platform,
		DefaultCwd:      s.cfg.DefaultCwd,
		Capabilities:    s.caps,
	}
	if err := client.writeJSON(ctx, hello); err != nil {
		log.Printf("send hello failed: %v", err)
		return
	}

	if err := client.serve(ctx, conn); err != nil && ctx.Err() == nil {
		log.Printf("connection closed: %v", err)
	}
}

var _ = fmt.Sprintf
