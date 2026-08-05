package server

import "strings"

// Redactor removes process secrets from terminal output before it reaches a
// browser. It retains a small suffix between calls so a secret split across
// adjacent PTY reads cannot leak one half in an earlier WebSocket frame.
type Redactor struct {
	secrets []string
	maxLen  int
	pending string
}

// NewRedactor ignores empty and duplicate secrets. Sorting longest-first keeps
// a shorter secret that is contained in a longer one from leaving a fragment.
func NewRedactor(secrets []string) *Redactor {
	seen := make(map[string]struct{})
	active := make([]string, 0, len(secrets))
	maxLen := 0
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if _, ok := seen[secret]; ok {
			continue
		}
		seen[secret] = struct{}{}
		active = append(active, secret)
		if len(secret) > maxLen {
			maxLen = len(secret)
		}
	}
	for i := 0; i < len(active); i++ {
		for j := i + 1; j < len(active); j++ {
			if len(active[j]) > len(active[i]) {
				active[i], active[j] = active[j], active[i]
			}
		}
	}
	return &Redactor{secrets: active, maxLen: maxLen}
}

// Redact emits only text that cannot be the beginning of a secret extending
// into a later PTY read. Call Flush when the stream ends to emit the final
// non-secret suffix.
func (r *Redactor) Redact(data []byte) string {
	if len(r.secrets) == 0 {
		return string(data)
	}
	all := r.pending + string(data)
	cut := len(all) - (r.maxLen - 1)
	if cut < 0 {
		cut = 0
	}
	// Do not cut through a partial secret. If the suffix just before cut is a
	// prefix of any secret, retain it until the following read disambiguates it.
	for _, secret := range r.secrets {
		limit := len(secret) - 1
		if limit > cut {
			limit = cut
		}
		for n := limit; n > 0; n-- {
			if all[cut-n:cut] == secret[:n] {
				cut -= n
				break
			}
		}
	}

	out := r.replace(all[:cut])
	r.pending = all[cut:]
	return out
}

// Flush emits the final buffered bytes after applying the same replacement.
func (r *Redactor) Flush() string {
	out := r.replace(r.pending)
	r.pending = ""
	return out
}

func (r *Redactor) replace(text string) string {
	for _, secret := range r.secrets {
		text = strings.ReplaceAll(text, secret, "***")
	}
	return text
}
