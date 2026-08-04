// Package server is a thin HTTP/WS shell over the workspace service. Next (the
// control plane) calls the HTTP routes; the browser connects directly to WS
// /pty. Every request carries a Runtime token the agent verifies — the agent
// trusts nothing else.
package server

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"runtime-agent/internal/auth"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/ptyx"
	"runtime-agent/internal/workspace"
)

type Server struct {
	secret   string
	ws       *workspace.Service
	upgrader websocket.Upgrader
}

func New(secret string, ws *workspace.Service) *Server {
	return &Server{secret: secret, ws: ws, upgrader: websocket.Upgrader{
		// The Daytona preview proxy already gates access; the Runtime token in
		// the URL is the real authorization check.
		CheckOrigin: func(*http.Request) bool { return true },
	}}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /workspaces", s.authed(s.createWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/start", s.authed(s.startWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/stop", s.authed(s.stopWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/archive", s.authed(s.archiveWorkspace))
	mux.HandleFunc("GET /pty", s.pty)
	return mux
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// authed verifies the Bearer Runtime token before invoking a control handler.
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearer(r)
		if _, err := auth.Verify(token, s.secret); err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
			return
		}
		next(w, r)
	}
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	var req protocol.CreateWorkspaceRequest
	if !decode(w, r, &req) {
		return
	}
	worktree, err := s.ws.Create(r.Context(), req.WorkspaceID, req.Branch, "origin/"+req.BaseBranch)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"worktree": worktree})
}

func (s *Server) startWorkspace(w http.ResponseWriter, r *http.Request) {
	// The Anthropic token is supplied out-of-band by the control plane at
	// provision time and held in agent memory (M2 wiring); empty here.
	name, err := s.ws.Start(r.Context(), r.PathValue("id"), "")
	respond(w, name, err)
}

func (s *Server) stopWorkspace(w http.ResponseWriter, r *http.Request) {
	err := s.ws.Stop(r.Context(), r.PathValue("id"))
	respond(w, "stopped", err)
}

func (s *Server) archiveWorkspace(w http.ResponseWriter, r *http.Request) {
	err := s.ws.Archive(r.Context(), r.PathValue("id"))
	respond(w, "archived", err)
}

// pty bridges the browser WebSocket to the workspace's tmux PTY.
func (s *Server) pty(w http.ResponseWriter, r *http.Request) {
	claims, err := auth.Verify(r.URL.Query().Get("token"), s.secret)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	sess, err := ptyx.Attach(s.ws.SessionName(claims.WorkspaceID))
	if err != nil {
		_ = conn.WriteJSON(protocol.PtyServerMessage{T: "exit", Code: intptr(1)})
		return
	}
	defer sess.Close()

	go pumpOut(conn, sess)
	pumpIn(conn, sess)
}

// pumpOut streams PTY output to the browser.
// TODO(M3): coalesce on a ~16-33ms flush, apply backpressure, and run redaction.
func pumpOut(conn *websocket.Conn, sess *ptyx.Session) {
	buf := make([]byte, 8192)
	seq := 0
	for {
		n, err := sess.Read(buf)
		if err != nil {
			_ = conn.WriteJSON(protocol.PtyServerMessage{T: "exit", Code: intptr(0)})
			return
		}
		if err := conn.WriteJSON(protocol.PtyServerMessage{
			T: "output", Data: string(buf[:n]), Seq: seq,
		}); err != nil {
			return
		}
		seq++
	}
}

// pumpIn forwards browser frames to the PTY.
// TODO(M3): enforce one-writer / read-only for additional connections.
func pumpIn(conn *websocket.Conn, sess *ptyx.Session) {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var m protocol.PtyClientMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.T {
		case "input":
			_, _ = sess.Write([]byte(m.Data))
		case "resize":
			_ = sess.Resize(m.Cols, m.Rows)
		case "ping":
			_ = conn.WriteJSON(protocol.PtyServerMessage{T: "pong"})
		}
	}
}

// ---------------------------------------------------------------------------

func respond(w http.ResponseWriter, ok string, err error) {
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"result": ok})
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "malformed JSON body")
		return false
	}
	return true
}

func bearer(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) > len(prefix) && h[:len(prefix)] == prefix {
		return h[len(prefix):]
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var body protocol.ErrorResponse
	body.Error.Code = code
	body.Error.Message = message
	writeJSON(w, status, body)
}

func intptr(v int) *int { return &v }
