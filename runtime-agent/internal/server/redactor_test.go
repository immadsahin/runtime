package server

import "testing"

func TestRedactorReplacesWholeAndRepeatedSecrets(t *testing.T) {
	r := NewRedactor([]string{"secret-value"})
	got := r.Redact([]byte("before secret-value after secret-value")) + r.Flush()
	if got != "before *** after ***" {
		t.Fatalf("redacted output = %q", got)
	}
}

func TestRedactorDoesNotLeakSecretsSplitAcrossReads(t *testing.T) {
	r := NewRedactor([]string{"secret-value"})
	got := r.Redact([]byte("before secret-"))
	got += r.Redact([]byte("value after"))
	got += r.Flush()
	if got != "before *** after" {
		t.Fatalf("split secret leaked or output changed: %q", got)
	}
}

func TestRedactorRetainsOrdinaryShortOutput(t *testing.T) {
	r := NewRedactor([]string{"secret-value"})
	got := r.Redact([]byte("ok")) + r.Flush()
	if got != "ok" {
		t.Fatalf("ordinary output = %q", got)
	}
}
