"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

/**
 * Renders assistant/user prose as GitHub-flavored Markdown with syntax-
 * highlighted fenced code blocks. The hljs token palette lives in globals.css
 * (`.md-body .hljs-*`) so it can color classes react-markdown emits that we
 * can't reach with Tailwind. Memoized because message text is immutable once
 * streamed — re-highlighting on every parent render is wasted work.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
