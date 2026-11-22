"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, msg, ApiError, playMessageSound } from "@/lib/api";

type Tracking = {
  number: number;
  status: "NEW" | "IN_KITCHEN" | "READY" | "ON_THE_WAY" | "DELIVERED" | "CANCELLED";
  etaMinutes: number;
  cancelReason: string | null;
  repartidorName: string | null;
  rated: boolean;
};

type ChatMsg = {
  id: string;
  channel?: "JEFE_CLIENT" | "RIDER_CLIENT";
  senderRole: "JEFE" | "REPARTIDOR" | "CLIENT";
  senderName: string;
  text: string;
  createdAt: string;
};

const STEPS = ["IN_KITCHEN", "READY", "ON_THE_WAY", "DELIVERED"] as const;
const TITLE: Record<string, string> = {
  NEW: "Hemos recibido tu pedido",
  IN_KITCHEN: "Estamos preparando tu pedido",
  READY: "Tu pedido está listo y esperando repartidor",
  ON_THE_WAY: "Tu pedido va en camino",
  DELIVERED: "Pedido entregado. ¡Que aproveche!",
  CANCELLED: "Pedido cancelado",
};

function RatingForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function send() {
    if (!score) return setErr("Elige de 1 a 5 estrellas.");
    setBusy(true);
    setErr("");
    try {
      await api(`/public/orders/${token}/rating`, {
        method: "POST",
        body: JSON.stringify({ score, ...(comment.trim() && { comment: comment.trim() }) }),
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "ALREADY_RATED") onDone();
      else { setErr(msg(e)); setBusy(false); }
    }
  }

  return (
    <div className="card">
      <strong>¿Qué tal ha ido?</strong>
      <div className="stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={n <= score ? "on" : ""} aria-label={`${n} estrellas`} onClick={() => setScore(n)}>★</button>
        ))}
      </div>
      <textarea rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Cuéntanos más (opcional)" />
      {err && <div className="banner error">{err}</div>}
      <button type="button" className="btn" style={{ marginTop: 10 }} onClick={send} disabled={busy}>Enviar valoración</button>
    </div>
  );
}

function OrderChat({ token, repartidorName }: { token: string; repartidorName: string | null }) {
  const [channel, setChannel] = useState<"JEFE_CLIENT" | "RIDER_CLIENT">("JEFE_CLIENT");
  const [jefeMsgs, setJefeMsgs] = useState<ChatMsg[]>([]);
  const [riderMsgs, setRiderMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const seenIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [jm, rm] = await Promise.all([
          api<ChatMsg[]>(`/public/orders/${token}/messages?channel=JEFE_CLIENT`),
          api<ChatMsg[]>(`/public/orders/${token}/messages?channel=RIDER_CLIENT`),
        ]);
        if (!alive) return;
        const incoming = [...jm, ...rm].filter((m) => m.senderRole !== "CLIENT");
        if (seenIds.current !== null && incoming.some((m) => !seenIds.current!.has(m.id))) {
          playMessageSound();
        }
        seenIds.current = new Set(incoming.map((m) => m.id));
        setJefeMsgs(jm);
        setRiderMsgs(rm);
      } catch {
        /* ignore */
      }
    };
    load();
    const id = setInterval(load, 3500);
    return () => { alive = false; clearInterval(id); };
  }, [token]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      const m = await api<ChatMsg>(`/public/orders/${token}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: text.trim(), channel }),
      });
      if (channel === "JEFE_CLIENT") setJefeMsgs((p) => [...p, m]);
      else setRiderMsgs((p) => [...p, m]);
      setText("");
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  const msgs = channel === "JEFE_CLIENT" ? jefeMsgs : riderMsgs;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button
          type="button"
          onClick={() => setChannel("JEFE_CLIENT")}
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: channel === "JEFE_CLIENT" ? "var(--accent)" : "var(--card)",
            color: channel === "JEFE_CLIENT" ? "var(--accent-text)" : "var(--text)",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          🏪 Restaurante ({jefeMsgs.length})
        </button>
        <button
          type="button"
          onClick={() => setChannel("RIDER_CLIENT")}
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: channel === "RIDER_CLIENT" ? "var(--accent)" : "var(--card)",
            color: channel === "RIDER_CLIENT" ? "var(--accent-text)" : "var(--text)",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          🛵 Repartidor{repartidorName ? ` (${repartidorName})` : ""} ({riderMsgs.length})
        </button>
      </div>
      <div className="muted" style={{ fontSize: ".8rem", marginBottom: 6 }}>
        {channel === "JEFE_CLIENT"
          ? "🔒 Chat privado con el jefe del restaurante (el repartidor no ve estos mensajes)."
          : "🔒 Chat privado con tu repartidor (el restaurante no ve estos mensajes)."}
      </div>
      <div style={{ maxHeight: 200, overflowY: "auto", margin: "8px 0", display: "flex", flexDirection: "column", gap: 6 }}>
        {msgs.length === 0 && (
          <p className="muted" style={{ margin: 0, fontSize: ".9rem" }}>
            {channel === "JEFE_CLIENT"
              ? "Escribe al restaurante si tienes alguna duda sobre tu pedido."
              : "Escribe al repartidor para indicaciones de entrega (portal, timbre…)."}
          </p>
        )}
        {msgs.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.senderRole === "CLIENT" ? "flex-end" : "flex-start",
              background: m.senderRole === "CLIENT" ? "var(--accent)" : "var(--line)",
              color: m.senderRole === "CLIENT" ? "var(--accent-text)" : "var(--text)",
              padding: "6px 10px",
              borderRadius: 10,
              maxWidth: "85%",
            }}
          >
            <div style={{ fontSize: ".75rem", opacity: 0.8, fontWeight: 600 }}>
              {m.senderRole === "CLIENT" ? "Tú" : m.senderName}
            </div>
            <div>{m.text}</div>
          </div>
        ))}
      </div>
      <form onSubmit={send} style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={channel === "JEFE_CLIENT" ? "Mensaje privado al restaurante…" : "Mensaje privado al repartidor…"}
          maxLength={500}
        />
        <button type="submit" className="btn" style={{ width: "auto", padding: "8px 16px" }} disabled={busy || !text.trim()}>
          Enviar
        </button>
      </form>
    </div>
  );
}

export default function Tracking() {
  const { token } = useParams<{ token: string }>();
  const [t, setT] = useState<Tracking | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Tracking>(`/public/orders/${token}`)
        .then((r) => { if (alive) { setT(r); setError(""); } })
        .catch((e) => { if (alive && e instanceof ApiError && e.code === "NOT_FOUND") setError(msg(e)); });
    load();
    const id = setInterval(load, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [token]);

  if (error) return <main><div className="banner error">{error}</div></main>;
  if (!t) return <main><p className="muted">Cargando…</p></main>;
  const step = STEPS.indexOf(t.status as (typeof STEPS)[number]);

  return (
    <main>
      <p className="muted">Pedido #{t.number}</p>
      <div className="status">{TITLE[t.status]}</div>
      {t.status === "CANCELLED" ? (
        <div className="banner error">Motivo: {t.cancelReason ?? "—"}. Si tienes dudas, llámanos.</div>
      ) : (
        <>
          <div className="steps" aria-hidden>{STEPS.map((s, i) => <div key={s} className={i <= step ? "on" : ""} />)}</div>
          {t.status === "ON_THE_WAY" && (
            <div className="card">
              {t.repartidorName && <p style={{ margin: 0 }}>Tu repartidor es <strong>{t.repartidorName}</strong>.</p>}
              <p style={{ margin: "6px 0 0" }}>Llegada estimada: unos <strong>{t.etaMinutes} minutos</strong>.</p>
            </div>
          )}
          {t.status !== "ON_THE_WAY" && t.status !== "DELIVERED" && (
            <p className="muted">Tiempo estimado total: unos {t.etaMinutes} minutos de trayecto, más la preparación.</p>
          )}
          {t.status !== "DELIVERED" && <OrderChat token={token} repartidorName={t.repartidorName} />}
        </>
      )}
      {t.status === "DELIVERED" &&
        (t.rated ? (
          <p className="muted">¡Gracias por tu valoración!</p>
        ) : (
          <RatingForm token={token} onDone={() => setT({ ...t, rated: true })} />
        ))}
      <p className="muted">Esta página se actualiza sola. Guarda el enlace para volver a verla.</p>
    </main>
  );
}
