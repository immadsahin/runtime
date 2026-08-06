"use client";

import { ArrowUp, ChevronDown, Hammer, Plus } from "lucide-react";
import { useRef, useState } from "react";

/**
 * The prompt composer pinned at the bottom of the conversation column. Sending
 * writes the text (plus a carriage return) into the live PTY, which is how a
 * prompt reaches Claude Code. Disabled unless this viewer holds the keyboard.
 */
export function SessionComposer({
  onSend,
  canSend,
  disabledPlaceholder = "Read-only — another viewer has the keyboard",
}: {
  onSend: (text: string) => void;
  canSend: boolean;
  /** Placeholder shown when input is disabled (offline, reader, connecting…). */
  disabledPlaceholder?: string;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const text = value.trim();
    if (text === "" || !canSend) return;
    onSend(text);
    setValue("");
    const el = textareaRef.current;
    if (el) el.style.height = "auto";
  }

  return (
    <form
      className="studio-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={
          canSend
            ? "Ask anything, / for commands, @ for context…"
            : disabledPlaceholder
        }
        aria-label="Message Claude"
        spellCheck={false}
        disabled={!canSend}
        onChange={(event) => {
          setValue(event.target.value);
          const el = event.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="studio-composer-footer">
        <span>
          <button
            type="button"
            aria-label="Attach (coming soon)"
            disabled
          >
            <Plus />
          </button>
          <span className="studio-composer-tag">
            <Hammer style={{ width: 12, marginRight: 4, display: "inline" }} />
            Build
            <ChevronDown style={{ width: 11, marginLeft: 2, display: "inline" }} />
          </span>
          <span className="studio-composer-model">claude opus 4.5</span>
        </span>
        <button
          type="submit"
          className="studio-composer-send"
          disabled={!canSend || value.trim() === ""}
          aria-label="Send"
        >
          <ArrowUp />
        </button>
      </div>
    </form>
  );
}
