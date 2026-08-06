// Package server is a thin HTTP/WS shell over the workspace service. Next (the
// control plane) calls the HTTP routes; the browser connects directly to WS
// /pty. Every request carries a Runtime token the agent verifies — the agent
// trusts nothing else.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"runtime-agent/internal/auth"
	"runtime-agent/internal/conversation"
	"runtime-agent/internal/protocol"
	"runtime-agent/internal/ptyx"
	"runtime-agent/internal/workspace"
)

// Frozen wire contract knobs. 16 ms ≈ 60 fps terminal; 4 KB matches xterm's
// natural write chunking. Changing these changes user-visible latency, so keep
// them in one place.
const (
	coalesceInterval  = 16 * time.Millisecond
	coalesceThreshold = 4096
	// SSE keeps proxies from idling out an in-flight but quiet stream.
	sseHeartbeat      = 20 * time.Second
	maxWSMessageBytes = 64 * 1024
)

type Server struct {
	secret   string
	ws       *workspace.Service
	upgrader websocket.Upgrader
	broker   *ptyx.Broker
}

type claimsContextKey struct{}

func New(secret string, ws *workspace.Service) *Server {
	return &Server{
		secret: secret,
		ws:     ws,
		broker: ptyx.NewBroker(),
		upgrader: websocket.Upgrader{
			// The Daytona preview proxy already gates access; the Runtime token in
			// the URL is the real authorization check.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /workspaces", s.authed(s.createWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/start", s.authed(s.startWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/stop", s.authed(s.stopWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/resume", s.authed(s.resumeWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/archive", s.authed(s.archiveWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/restore", s.authed(s.restoreWorkspace))
	mux.HandleFunc("POST /workspaces/{id}/destroy", s.authed(s.destroyWorkspace))
	mux.HandleFunc("GET /pty", s.pty)
	mux.HandleFunc("GET /events", s.events)
	mux.HandleFunc("GET /workspaces/{id}/summary", s.authed(s.workspaceSummary))
	return mux
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// authed verifies the Bearer Runtime token before invoking a control handler.
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearer(r)
		claims, err := auth.Verify(token, s.secret)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), claimsContextKey{}, claims)))
	}
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	var req protocol.CreateWorkspaceRequest
	if !decode(w, r, &req) {
		return
	}
	if !s.requireWorkspace(w, r, req.WorkspaceID) {
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
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	// The Anthropic token is supplied out-of-band by the control plane at
	// provision time and held in agent memory (M2 wiring); empty here.
	name, err := s.ws.Start(r.Context(), r.PathValue("id"), "")
	respond(w, name, err)
}

func (s *Server) stopWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	err := s.ws.Stop(r.Context(), r.PathValue("id"))
	respond(w, "stopped", err)
}

func (s *Server) resumeWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	name, err := s.ws.Resume(r.Context(), r.PathValue("id"), "")
	respond(w, name, err)
}

func (s *Server) archiveWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	var req protocol.ArchiveWorkspaceRequest
	if !decode(w, r, &req) {
		return
	}
	if req.ArchivedAt == "" || len(req.Uploads) == 0 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "archive requires archivedAt and upload URLs")
		return
	}
	manifest, err := s.ws.Archive(r.Context(), r.PathValue("id"), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, manifest)
}

func (s *Server) destroyWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	err := s.ws.Destroy(r.Context(), r.PathValue("id"))
	respond(w, "destroyed", err)
}

func (s *Server) restoreWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	var req protocol.RestoreWorkspaceRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Branch == "" || len(req.Downloads) == 0 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "restore requires a branch and download URLs")
		return
	}
	name, err := s.ws.Restore(r.Context(), r.PathValue("id"), req)
	respond(w, name, err)
}

// workspaceSummary serves the current WorkspaceSummary — the canonical, cross-
// milestone summary Mission Engine consumes. Cheap enough for polling; git
// stats are shelled out at request time (typical <20ms on a healthy worktree).
func (s *Server) workspaceSummary(w http.ResponseWriter, r *http.Request) {
	if !s.requireWorkspace(w, r, r.PathValue("id")) {
		return
	}
	summary := s.ws.SummaryOf(r.Context(), r.PathValue("id"))
	writeJSON(w, http.StatusOK, summary)
}

// requireWorkspace binds a verified Runtime token to the exact workspace a
// control request addresses. A token for one workspace must never be usable to
// stop, archive, destroy, or inspect another workspace on the same computer.
func (s *Server) requireWorkspace(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	claims, _ := r.Context().Value(claimsContextKey{}).(*protocol.RuntimeTokenClaims)
	if claims == nil || workspaceID == "" || claims.WorkspaceID != workspaceID {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Runtime token does not authorize this workspace")
		return false
	}
	return true
}

// pty bridges the browser WebSocket to the workspace's tmux PTY. Every attach
// receives PTY output (tmux fans it out), but only the current writer's
// keystrokes reach the PTY — the broker enforces one-writer per workspace.
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
	conn.SetReadLimit(maxWSMessageBytes)

	sess, err := ptyx.Attach(s.ws.SessionName(claims.WorkspaceID))
	if err != nil {
		_ = conn.WriteJSON(protocol.PtyServerMessage{T: "exit", Code: intptr(1)})
		return
	}
	defer sess.Close()

	// Serialize all WriteJSON calls on this connection — the coalescer flushes
	// from its own goroutine, role updates from the broker's, and pongs from
	// pumpIn. gorilla/websocket requires exclusive writer access.
	var writeMu sync.Mutex
	writeFrame := func(msg protocol.PtyServerMessage) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(msg)
	}

	// Broker role: attaches this connection, tells us if we're the writer, and
	// re-notifies us later if a reader is promoted after the writer detaches.
	setRole := func(writer bool) {
		w := writer
		_ = writeFrame(protocol.PtyServerMessage{T: "role", Writer: &w})
	}
	attachment := s.broker.Attach(claims.WorkspaceID, setRole)
	defer attachment.Detach()

	// Output pipeline: PTY → coalescer → WS. Coalescing satisfies the frozen
	// contract ("output is coalesced") and prevents one-keystroke-per-frame
	// flooding. The redactor preserves a suffix between calls so no secret can
	// leak when it crosses a PTY read boundary.
	redactor := NewRedactor(append(s.ws.RedactionSecrets(), s.secret))
	coalescer := ptyx.NewCoalescer(coalesceInterval, coalesceThreshold, func(seq int, data []byte) error {
		output := redactor.Redact(data)
		if output == "" {
			return nil
		}
		return writeFrame(protocol.PtyServerMessage{T: "output", Data: output, Seq: intptr(seq)})
	})
	go coalescer.Run()
	defer func() {
		coalescer.Stop()
		if output := redactor.Flush(); output != "" {
			_ = writeFrame(protocol.PtyServerMessage{T: "output", Data: output, Seq: intptr(coalescer.NextSeq())})
		}
	}()

	go pumpOut(sess, coalescer, writeFrame, func() bool {
		return s.ws.SessionAlive(context.Background(), claims.WorkspaceID)
	})
	pumpIn(conn, sess, attachment.IsWriter, writeFrame)
}

// pumpOut reads PTY bytes and hands them to the coalescer, which decides when
// to flush an `output` frame. On PTY EOF/error it returns; it only sends `exit`
// if the tmux session is actually gone.
//
// The PTY is a `tmux attach` client, and that client EOFs on *detach* (a
// reconnect, resize race, or a competing attach) just as it does on Claude's
// real *exit*. Reporting exit on every EOF made the UI show "Claude exited"
// while Claude was still sitting at its prompt, and each false exit triggered
// another reconnect. sessionAlive() distinguishes the two: if the session still
// exists it was a detach — close quietly and let the client re-attach.
func pumpOut(sess *ptyx.Session, c *ptyx.Coalescer, send func(protocol.PtyServerMessage) error, sessionAlive func() bool) {
	buf := make([]byte, 8192)
	for {
		n, err := sess.Read(buf)
		if n > 0 {
			_ = c.Write(buf[:n])
		}
		if err != nil {
			if !sessionAlive() {
				_ = send(protocol.PtyServerMessage{T: "exit", Code: intptr(0)})
			}
			return
		}
	}
}

// pumpIn forwards writer input to the PTY; reader input frames are dropped.
// Resize is honored from any client so a late-joining reader can right-size
// its own xterm. Ping/pong keeps the connection alive.
func pumpIn(conn *websocket.Conn, sess *ptyx.Session, isWriter func() bool, send func(protocol.PtyServerMessage) error) {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var m protocol.PtyClientMessage
		if json.Unmarshal(data, &m) != nil || !m.Valid() {
			continue
		}
		switch m.T {
		case "input":
			if isWriter() {
				_, _ = sess.Write([]byte(m.Data))
			}
		case "resize":
			_ = sess.Resize(m.Cols, m.Rows)
		case "ping":
			_ = send(protocol.PtyServerMessage{T: "pong"})
		}
	}
}

// events serves the Conversation event stream as SSE.
//
// Frames:
//
//	id: <byte-offset-into-JSONL>
//	data: <AgentEvent JSON>
//
// The `id:` line is the JSONL byte offset AT THE END of the emitted record.
// On reconnect, the browser's EventSource resends it as `Last-Event-ID`; the
// agent starts its watcher at that offset, so no event is duplicated or
// skipped between disconnect and reconnect. This is the entire correctness
// contract of the stream.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	claims, err := auth.Verify(r.URL.Query().Get("token"), s.secret)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid Runtime token")
		return
	}

	fromOffset := int64(0)
	if h := r.Header.Get("Last-Event-ID"); h != "" {
		if v, perr := strconv.ParseInt(h, 10, 64); perr == nil && v > 0 {
			fromOffset = v
		}
	}
	// Programmatic reconnects (browser-initiated close then reopen) can't set
	// the header; allow ?lastEventId= as an escape hatch.
	if q := r.URL.Query().Get("lastEventId"); q != "" && fromOffset == 0 {
		if v, perr := strconv.ParseInt(q, 10, 64); perr == nil && v > 0 {
			fromOffset = v
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx/proxy buffering
	w.WriteHeader(http.StatusOK)

	// Serialize every write on this response — the ticker, the watcher goroutine,
	// and the state emitter all write frames concurrently.
	var writeMu sync.Mutex
	writeSSE := func(id int64, payload []byte) bool {
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, err := fmt.Fprintf(w, "id: %d\ndata: %s\n\n", id, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	writeHeartbeat := func() bool {
		writeMu.Lock()
		defer writeMu.Unlock()
		if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Synthetic initial `state` event so subscribers know whether the workspace
	// is running before any conversation event lands. Not resumable — clients
	// re-observe the state on each connect. Emitted only on fresh connects
	// (fromOffset == 0) so a resume doesn't re-fire it.
	if fromOffset == 0 {
		state := "starting"
		if s.ws.SessionLog(claims.WorkspaceID) != "" {
			state = "running"
		}
		payload, _ := json.Marshal(protocol.WorkspaceStateChanged{
			T: "state", WorkspaceID: claims.WorkspaceID, State: state,
		})
		if !writeSSE(0, payload) {
			return
		}
	}

	// Watcher tails the JSONL and delivers events on `out`. Its lifetime is
	// tied to the HTTP request context — when the browser closes the SSE
	// connection, r.Context() cancels and the watcher exits.
	pathFn := func() string { return s.ws.SessionLog(claims.WorkspaceID) }
	watcher := conversation.New(pathFn, fromOffset)
	out := make(chan conversation.Event, 64)
	go watcher.Run(r.Context(), out)

	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-out:
			var payload []byte
			var mErr error
			switch {
			case ev.Message != nil:
				payload, mErr = json.Marshal(ev.Message)
			case ev.Usage != nil:
				payload, mErr = json.Marshal(ev.Usage)
			default:
				continue
			}
			if mErr != nil {
				continue
			}
			if !writeSSE(ev.ID, payload) {
				return
			}
		case <-heartbeat.C:
			if !writeHeartbeat() {
				return
			}
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
