package transport

import (
	"context"
	"crypto/tls"
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
// If cfg.TLSCert and cfg.TLSKey are set the listener uses TLS (wss://),
// otherwise plain WebSocket (ws://). The security policy is re-validated here
// so programmatically constructed Config values cannot bypass Load.
func (s *Server) Run(ctx context.Context) error {
	if err := s.cfg.Validate(); err != nil {
		return fmt.Errorf("invalid direct listener configuration: %w", err)
	}
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
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	if s.cfg.TLSCert != "" && s.cfg.TLSKey != "" {
		// Load the certificate pair once at startup so errors are caught early.
		cert, err := tls.LoadX509KeyPair(s.cfg.TLSCert, s.cfg.TLSKey)
		if err != nil {
			return fmt.Errorf("load TLS key pair: %w", err)
		}
		httpServer.TLSConfig = &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
		log.Printf("listening for direct TLS connections on %s (cert=%s)", s.cfg.ListenAddr, s.cfg.TLSCert)
		err = httpServer.ListenAndServeTLS("", "") // cert/key already loaded into TLSConfig
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}

	log.Printf("listening for unencrypted loopback direct connections on %s", s.cfg.ListenAddr)
	err := httpServer.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) handleConn(ctx context.Context, conn *websocket.Conn) {
	// Reuse the same per-connection state and teardown path as reverse mode.
	client := NewClient(s.cfg, s.dispatcher, s.platform, s.caps)
	state := client.newConnectionState(ctx, conn)
	defer state.close()

	ack, err := client.authenticateDirect(state)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("direct authentication failed: %v", err)
		}
		_ = conn.Close(websocket.StatusPolicyViolation, "authentication failed")
		return
	}
	state.authenticated.Store(true)
	log.Printf("direct handshake accepted (session %s)", ack.SessionID)

	if err := state.serveAuthenticated(); err != nil && ctx.Err() == nil {
		log.Printf("connection closed: %v", err)
	}
}
