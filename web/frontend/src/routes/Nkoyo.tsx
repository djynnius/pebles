import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "react-router-dom";
import { api, errorText, type User } from "../api";
import { NkoyoAvatar } from "../components/Avatar";
import { CloudModelsWarning } from "../components/CloudModels";
import { ErrorBlock } from "../components/State";

/*
 * /nkoyo — the assistant screen (spec §5 "nkoyo").
 *
 * Nkoyo is an agent harness over LOCAL Ollama models only (REQ-43); every tool
 * it runs executes inside the signed-in user's own session, so it can never
 * exceed their grants (REQ-45). Mutating tools are graded ask-first: pebblesd
 * refuses them and tells the model why, which is what the approval row below
 * picks up on — the reply shape is {content, model, tools_used}, there is no
 * structured pending field, so the refusal text is the signal.
 */

interface ChatReply {
  content: string;
  model?: string;
  tools_used?: string[];
}

interface Msg {
  role: string;
  content: string;
  model?: string;
  tools?: string[];
  /** Tools this turn refused for want of approval (parsed from the reply). */
  pending?: string[];
}

/** pebblesd's ask-first tools (crates/pebblesd/src/nkoyo.rs `tools()`). */
const ASK_FIRST = ["write_file", "sql_exec"];

const SUGGESTIONS = [
  { title: "Profile a table", body: "Profile the biggest table in my lake and flag odd columns." },
  { title: "Write a query", body: "Write a query that counts rows per month in " },
  { title: "Summarize a notebook", body: "Summarize what my latest notebook does." },
  { title: "Find slow jobs", body: "Which of my jobs failed or ran longest recently?" },
];

/**
 * Which tools this reply was blocked on. pebblesd's refusal is verbatim
 * `tool "x" needs the user's approval before it can run`; when the model
 * paraphrases it, fall back to the ask-first tools it tried this turn.
 */
function pendingApprovals(content: string, tools: string[]): string[] {
  const found = new Set<string>();
  const re = /tool\s+["“']?([a-z_]+)["”']?\s+needs the user's approval/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) found.add(m[1]);
  if (found.size === 0 && /needs (the user's |your )?approval/i.test(content)) {
    for (const t of tools) if (ASK_FIRST.includes(t)) found.add(t);
  }
  return Array.from(found);
}

export function Nkoyo({ user }: { user: User }) {
  // Home's ask bar hands the draft over rather than sending it — the model call
  // stays a deliberate act on this screen.
  const handover = (useLocation().state as { prompt?: string } | null)?.prompt ?? "";
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState(handover);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState("");
  const [approved, setApproved] = useState<string[]>([]);
  const lastPrompt = useRef("");
  const scroller = useRef<HTMLDivElement | null>(null);
  // Models that run on ollama.com — when non-empty, data does leave the cluster.
  const [cloudModels, setCloudModels] = useState<string[]>([]);

  useEffect(() => {
    api
      .get<{ cloud_models?: string[] }>("/nkoyo/config")
      .then((c) => setCloudModels(Array.isArray(c.cloud_models) ? c.cloud_models : []))
      .catch(() => setCloudModels([]));
  }, []);

  useEffect(() => {
    api
      .get<Msg[]>("/nkoyo/chat")
      .then((m) => setMessages(m.map((x) => ({ role: x.role, content: x.content }))))
      // A history that cannot be read is worth saying: otherwise a restarting
      // pebblesd looks exactly like a brand-new conversation.
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, thinking]);

  const send = (prompt: string, approvals: string[] = []) => {
    const text = prompt.trim();
    if (!text || thinking) return;
    lastPrompt.current = text;
    setMessages((cur) => [...cur, { role: "user", content: text }]);
    setDraft("");
    setApproved([]);
    setThinking(true);
    setError("");
    api
      .post<ChatReply>("/nkoyo/send", { prompt: text, approved: approvals })
      .then((reply) => {
        const tools = reply.tools_used ?? [];
        setMessages((cur) => [
          ...cur,
          {
            role: "assistant",
            content: reply.content,
            model: reply.model,
            tools,
            pending: pendingApprovals(reply.content, tools),
          },
        ]);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setThinking(false));
  };

  const newChat = () => {
    setMessages([]);
    setError("");
    setApproved([]);
    // If the server keeps the old transcript the next reply would carry it,
    // so a failed clear is a fact the user needs, not a swallowed one.
    api.post("/nkoyo/clear").catch((e) => setError(errorText(e)));
  };

  const firstUserLine = messages.find((m) => m.role === "user")?.content;
  const empty = messages.length === 0;

  return (
    <div style={{ display: "flex", height: "calc(100vh - 52px)", minHeight: 0 }}>
      {/* ---- history sidebar --------------------------------------------- */}
      <aside
        style={{
          width: 250,
          flex: "0 0 250px",
          borderRight: "1px solid var(--border)",
          background: "var(--surface-alt)",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          minHeight: 0,
        }}
      >
        <button
          type="button"
          onClick={newChat}
          style={{
            background: "var(--deep-soft)",
            color: "var(--deep-text)",
            border: "none",
            borderRadius: 12,
            fontWeight: 600,
            fontSize: 13,
            padding: "9px 14px",
            textAlign: "left",
          }}
        >
          + New chat
        </button>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: "0.8px",
              textTransform: "uppercase",
              color: "var(--text-faint)",
              padding: "4px 6px 8px",
            }}
          >
            Recent
          </div>
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              background: empty ? "transparent" : "var(--surface)",
              border: empty ? "1px solid transparent" : "1px solid var(--border)",
              fontSize: 12.5,
              color: empty ? "var(--text-dim)" : "var(--text-mid)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {firstUserLine ?? "Current chat"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "10px 6px" }}>
            One conversation at a time — “New chat” clears it.
          </div>
        </div>

        <div
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            color: "var(--text-dim)",
            borderTop: "1px solid var(--border)",
            paddingTop: 12,
          }}
        >
          {cloudModels.length > 0 ? (
            <CloudModelsWarning models={cloudModels} />
          ) : (
            "Runs entirely on your cluster. No data leaves your hosts."
          )}
        </div>
      </aside>

      {/* ---- conversation ------------------------------------------------- */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div ref={scroller} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {empty ? (
            <div
              style={{
                maxWidth: 720,
                margin: "0 auto",
                padding: "60px 24px 24px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 18,
              }}
            >
              <NkoyoAvatar size={72} />
              <h1
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  letterSpacing: "-0.5px",
                  textAlign: "center",
                }}
              >
                Hi {user.username} — what are we looking at today?
              </h1>
              <AskBox
                value={draft}
                onChange={setDraft}
                onSend={() => send(draft)}
                busy={thinking}
              />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0,1fr))",
                  gap: 12,
                  width: "100%",
                }}
              >
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    onClick={() => setDraft(s.body)}
                    style={{
                      textAlign: "left",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 14,
                      padding: 16,
                      color: "var(--text)",
                    }}
                  >
                    <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>
                      {s.title}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{s.body}</div>
                  </button>
                ))}
              </div>
              {error && <ErrorBlock error={error} style={{ width: "100%", marginBottom: 0 }} />}
            </div>
          ) : (
            <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 24px 8px" }}>
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
                    <div
                      style={{
                        maxWidth: "82%",
                        background: "var(--deep-soft)",
                        color: "var(--deep-text)",
                        borderRadius: "12px 12px 3px 12px",
                        padding: "10px 14px",
                        fontSize: 13.5,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "break-word",
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                    <div style={{ flexShrink: 0, paddingTop: 2 }}>
                      <NkoyoAvatar size={28} />
                    </div>
                    <div style={{ maxWidth: "92%" }}>
                      <div
                        style={{
                          background: "var(--surface-alt)",
                          border: "1px solid var(--track)",
                          borderRadius: "12px 12px 12px 3px",
                          padding: "10px 14px",
                          fontSize: 13.5,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "break-word",
                        }}
                      >
                        {m.content || "(no answer)"}
                      </div>
                      {(m.tools?.length || m.model) && (
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            flexWrap: "wrap",
                            marginTop: 6,
                            alignItems: "center",
                          }}
                        >
                          {m.model && (
                            <span className="mono" style={{ ...chip, color: "var(--text-dim)" }}>
                              {m.model}
                            </span>
                          )}
                          {(m.tools ?? []).map((t, j) => (
                            <span key={`${t}-${j}`} className="mono" style={chip}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      {m.pending && m.pending.length > 0 && i === messages.length - 1 && (
                        <div
                          style={{
                            marginTop: 10,
                            background: "var(--accent-tint)",
                            border: "1px solid var(--accent)",
                            borderRadius: 12,
                            padding: "12px 14px",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color: "var(--accent-tint-ink)",
                              marginBottom: 8,
                            }}
                          >
                            Nkoyo needs approval before it can continue
                          </div>
                          {m.pending.map((t) => (
                            <label
                              key={t}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                fontSize: 12.5,
                                marginBottom: 6,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={approved.includes(t)}
                                onChange={(e) =>
                                  setApproved((cur) =>
                                    e.target.checked ? [...cur, t] : cur.filter((x) => x !== t),
                                  )
                                }
                              />
                              <span className="mono">{t}</span>
                            </label>
                          ))}
                          <button
                            type="button"
                            onClick={() => send(lastPrompt.current, approved)}
                            disabled={approved.length === 0 || thinking}
                            style={{
                              marginTop: 6,
                              background:
                                approved.length === 0 ? "var(--track)" : "var(--accent)",
                              color:
                                approved.length === 0 ? "var(--text-dim)" : "var(--on-accent)",
                              border: "none",
                              borderRadius: 11,
                              fontWeight: 600,
                              fontSize: 12.5,
                              padding: "7px 14px",
                            }}
                          >
                            Approve &amp; continue
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
              {thinking && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 16,
                    color: "var(--text-dim)",
                    fontSize: 12.5,
                  }}
                >
                  <NkoyoAvatar size={28} />
                  <span style={{ opacity: 0.75 }}>Nkoyo is thinking…</span>
                </div>
              )}
              {error && <ErrorBlock error={error} />}
            </div>
          )}
        </div>

        {/* sticky composer */}
        {!empty && (
          <div
            style={{
              flex: "0 0 auto",
              borderTop: "1px solid var(--border)",
              background: "var(--surface)",
              padding: "14px 24px 10px",
            }}
          >
            <div style={{ maxWidth: 760, margin: "0 auto" }}>
              <AskBox
                value={draft}
                onChange={setDraft}
                onSend={() => send(draft)}
                busy={thinking}
              />
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-dim)",
                  textAlign: "center",
                  marginTop: 8,
                }}
              >
                Nkoyo can make mistakes. Verify important results.
              </div>
            </div>
          </div>
        )}
        {empty && (
          <div
            style={{
              flex: "0 0 auto",
              fontSize: 11,
              color: "var(--text-dim)",
              textAlign: "center",
              padding: "0 24px 16px",
            }}
          >
            Nkoyo can make mistakes. Verify important results.
          </div>
        )}
      </div>
    </div>
  );
}

/** The 720px ask box: textarea, context chips, and the accent → send. */
function AskBox({
  value,
  onChange,
  onSend,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 720,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 12,
      }}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        rows={2}
        placeholder="Ask Nkoyo about your data…"
        aria-label="Ask Nkoyo"
        style={{
          width: "100%",
          border: "none",
          outline: "none",
          resize: "none",
          background: "transparent",
          color: "var(--text)",
          fontSize: 14,
          lineHeight: 1.6,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        {["@ table", "▧ notebook", "◍ analytics-md"].map((c) => (
          <span key={c} style={{ ...chip, color: "var(--text-faint)" }}>
            {c}
          </span>
        ))}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onSend}
          disabled={busy || !value.trim()}
          aria-label="Send"
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            border: "none",
            background: busy || !value.trim() ? "var(--track)" : "var(--accent)",
            color: busy || !value.trim() ? "var(--text-dim)" : "var(--on-accent)",
            fontSize: 14,
          }}
        >
          →
        </button>
      </div>
    </div>
  );
}

const chip: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 20,
  padding: "3px 9px",
  fontSize: 11,
  color: "var(--text-mid)",
  background: "var(--surface-alt)",
};
