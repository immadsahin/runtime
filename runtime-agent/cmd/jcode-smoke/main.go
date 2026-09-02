// Command jcode-smoke drives a running `jcode api-bridge` through the internal
// jcode client to validate the wire protocol, event stream, and conversation
// assembly against a REAL jcode binary (not the fake bridge used in unit tests).
//
// Usage:
//
//	jcode api-bridge --api-socket /tmp/jcode-api.sock &
//	go run ./cmd/jcode-smoke /tmp/jcode-api.sock ["prompt"]
//
// It handshakes, opens a session in the current directory, optionally sends a
// prompt, and prints every event frame plus the assembled conversation records.
// A prompt turn needs a provider configured in jcode; without one the turn
// errors, which still exercises the client's event handling.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"runtime-agent/internal/jcode"
)

func main() {
	socket := "/tmp/jcode-api.sock"
	if len(os.Args) > 1 {
		socket = os.Args[1]
	}
	prompt := "Reply with exactly the word: pong"
	if len(os.Args) > 2 {
		prompt = os.Args[2]
	}

	ctx := context.Background()
	client, err := jcode.Dial(ctx, socket, "jcode-smoke")
	if err != nil {
		fatal("dial", err)
	}
	defer client.Close()
	fmt.Printf("✅ handshake OK — server=%q permissions=%v\n", client.Server(), client.Supports("permissions"))

	cwd, _ := os.Getwd()
	sess, err := client.CreateSession(ctx, cwd)
	if err != nil {
		fatal("create_session", err)
	}
	fmt.Printf("✅ session created: id=%s status=%s dir=%s\n", sess.SessionID, sess.Status, sess.WorkingDir)

	// Assemble records exactly as the workspace pipeline will, writing to stdout.
	consumer := jcode.NewSessionConsumer(sess.SessionID, prefixWriter{"  record> "}, time.Now)

	fmt.Printf("→ send_message: %q\n", prompt)
	if err := client.SendMessage(sess.SessionID, prompt); err != nil {
		fatal("send_message", err)
	}

	fmt.Println("--- events (up to 60s, until turn_done) ---")
	deadline := time.After(60 * time.Second)
	flush := time.NewTicker(200 * time.Millisecond)
	defer flush.Stop()
	for {
		select {
		case f, ok := <-client.Events():
			if !ok {
				fmt.Println("--- event stream closed ---")
				return
			}
			describe(f)
			_ = consumer.Handle(f)
			if f.Ev == jcode.EvTurnDone {
				_ = consumer.Flush()
				fmt.Println("✅ turn_done — pipeline validated end to end")
				return
			}
			if f.Ev == jcode.EvError {
				fmt.Printf("⚠️  error event: %s (%s) — protocol OK, provider likely unconfigured\n", f.Message, f.Code)
			}
		case <-flush.C:
			_ = consumer.Flush()
		case <-deadline:
			fmt.Println("--- 60s timeout ---")
			return
		}
	}
}

// describe prints a one-line summary of a frame, decoding the few kinds worth
// seeing so the real wire shape is visible.
func describe(f jcode.Frame) {
	switch f.Ev {
	case jcode.EvTextDelta:
		var p jcode.TextDelta
		_ = f.Into(&p)
		fmt.Printf("  ev=text_delta %q\n", p.Text)
	case jcode.EvToolStart:
		var p jcode.ToolStart
		_ = f.Into(&p)
		fmt.Printf("  ev=tool_start call=%s name=%s\n", p.CallID, p.Name)
	case jcode.EvToolDone:
		var p jcode.ToolDone
		_ = f.Into(&p)
		fmt.Printf("  ev=tool_done call=%s err=%q\n", p.CallID, p.Error)
	case jcode.EvTokenUsage:
		var p jcode.TokenUsage
		_ = f.Into(&p)
		fmt.Printf("  ev=token_usage in=%d out=%d cache=%d\n", p.Input, p.Output, p.CacheReadInput)
	default:
		fmt.Printf("  ev=%s\n", f.Ev)
	}
}

type prefixWriter struct{ prefix string }

func (p prefixWriter) Write(b []byte) (int, error) {
	fmt.Printf("%s%s", p.prefix, string(b))
	return len(b), nil
}

func fatal(what string, err error) {
	fmt.Fprintf(os.Stderr, "❌ %s: %v\n", what, err)
	os.Exit(1)
}
