import type { CSSProperties, ReactNode } from "react";

/*
 * A deliberately small, SAFE markdown renderer for notebook md cells.
 *
 * It builds React elements directly — there is no HTML string anywhere, so
 * React's own escaping is the whole XSS story (no dangerouslySetInnerHTML).
 * Supported: # / ## / ### headings, paragraphs, **bold**, *italic*, `code`,
 * fenced ``` blocks, "- " / "* " and "1. " lists, and [text](url) links whose
 * url is http(s) — anything else renders as plain text.
 */

type Block =
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "p"; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

const HEADING = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ kind: "h", level: h[1].length as 1 | 2 | 3, text: h[2] });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flush();
      const kind = b ? "ul" : "ol";
      const last = out[out.length - 1];
      const text = (b ?? n)![1];
      if (last && last.kind === kind) last.items.push(text);
      else out.push({ kind, items: [text] });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\s][^*\n]*?\*)|(\[([^\]\n]+)\]\(([^)\s]+)\))/g;
const SAFE_URL = /^https?:\/\/[^\s]+$/i;

function inline(text: string, keyBase = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}${k++}`;
    const [whole, code, bold, italic, link, linkText, url] = m;
    if (code) {
      out.push(
        <code key={key} className="mono" style={codeInline}>
          {code.slice(1, -1)}
        </code>,
      );
    } else if (bold) {
      out.push(<strong key={key}>{inline(bold.slice(2, -2), `${key}.`)}</strong>);
    } else if (italic) {
      out.push(<em key={key}>{inline(italic.slice(1, -1), `${key}.`)}</em>);
    } else if (link) {
      out.push(
        SAFE_URL.test(url) ? (
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--accent-ink)" }}
          >
            {inline(linkText, `${key}.`)}
          </a>
        ) : (
          <span key={key}>{inline(linkText, `${key}.`)}</span>
        ),
      );
    }
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Plain text of an inline run — markers stripped, for the table of contents. */
function plain(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** The headings a markdown source declares (fenced blocks excluded). */
export function markdownHeadings(src: string): { level: 1 | 2 | 3; text: string }[] {
  return parse(src)
    .filter((b): b is Extract<Block, { kind: "h" }> => b.kind === "h")
    .map((b) => ({ level: b.level, text: plain(b.text) }));
}

const HEADING_SIZE: Record<1 | 2 | 3, number> = { 1: 22, 2: 17, 3: 14.5 };

export function Markdown({ source, style }: { source: string; style?: CSSProperties }) {
  const blocks = parse(source);
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text)", ...style }}>
      {blocks.map((b, i) => {
        const first = i === 0;
        switch (b.kind) {
          case "h": {
            const Tag = `h${b.level}` as "h1" | "h2" | "h3";
            return (
              <Tag
                key={i}
                style={{
                  fontSize: HEADING_SIZE[b.level],
                  fontWeight: 600,
                  letterSpacing: b.level === 1 ? "-0.4px" : "-0.2px",
                  lineHeight: 1.3,
                  margin: first ? "0 0 8px" : "16px 0 8px",
                }}
              >
                {inline(b.text)}
              </Tag>
            );
          }
          case "p":
            return (
              <p key={i} style={{ margin: first ? "0 0 8px" : "8px 0" }}>
                {inline(b.text)}
              </p>
            );
          case "code":
            return (
              <pre
                key={i}
                className="mono"
                style={{
                  margin: "8px 0",
                  padding: "10px 12px",
                  background: "var(--surface-alt)",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  fontSize: 12,
                  lineHeight: "18px",
                  overflowX: "auto",
                  whiteSpace: "pre",
                }}
              >
                {b.text}
              </pre>
            );
          case "ul":
          case "ol": {
            const Tag = b.kind;
            return (
              <Tag key={i} style={{ margin: "6px 0", paddingLeft: 22 }}>
                {b.items.map((it, j) => (
                  <li key={j} style={{ margin: "2px 0" }}>
                    {inline(it)}
                  </li>
                ))}
              </Tag>
            );
          }
        }
        return null;
      })}
    </div>
  );
}

const codeInline: CSSProperties = {
  fontSize: "0.9em",
  background: "var(--surface-alt)",
  border: "1px solid var(--border-soft)",
  borderRadius: 5,
  padding: "0 4px",
  color: "var(--accent-deep)",
};
