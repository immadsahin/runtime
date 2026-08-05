// Package cast records a workspace's terminal as an asciinema v2 cast, so a
// Snapshot can replay the session in the browser with no Runtime Computer
// (M4 invariant: Replay never requires Runtime).
//
// Recording is server-side and starts at SESSION start, independent of any
// browser connection (M4 invariant #3). The recorder taps the tmux pane via
// `pipe-pane` into a FIFO; a goroutine stamps the arriving bytes with elapsed
// time and frames them as asciinema v2. Terminal safety comes first: if writing
// the cast ever fails, the recorder detaches the pipe and keeps draining rather
// than back-pressuring — and freezing — the user's live terminal.
package cast

// DefaultCastName is the on-disk filename of a Snapshot's terminal cast. It is
// the one place the Go agent needs to know an artifact name; the storage path
// scheme (and every other artifact name) lives on the Next side, since Next
// mints the upload URLs.
const DefaultCastName = "session.cast"
