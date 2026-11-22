"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, SLUG, eur, errorText, msg } from "@/lib/api";

type Product = { id: string; name: string; description: string | null; price: string };
type Category = { id: string; name: string; products: Product[] };
type Menu = {
  name: string;
  open: boolean;
  hours: { weekday: number; openMin: number; closeMin: number }[];
  categories: Category[];
};

type ClientOrder = {
  id: string;
  number: number;
  status: string;
  trackingToken: string;
  total: string;
  paymentMethod: string;
  createdAt: string;
  items: { productId: string; name: string; quantity: number; unitPrice: string }[];
};

type ClientProfile = {
  id: string;
  name: string;
  email: string;
  phone: string;
  streetType: string;
  streetName: string;
  streetNumber: string;
  postalCode: string;
  floor: string | null;
  door: string | null;
  notes: string | null;
  orders?: ClientOrder[];
};

const STATUS_ES: Record<string, string> = {
  NEW: "Recibido",
  IN_KITCHEN: "En cocina",
  READY: "Listo",
  ON_THE_WAY: "En camino",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
};

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export default function Home() {
  const router = useRouter();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [loadError, setLoadError] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [f, setF] = useState({
    clientName: "", clientPhone: "", streetType: "calle", streetName: "", streetNumber: "",
    postalCode: "", floor: "", door: "", notes: "",
  });
  const [pay, setPay] = useState<"CARD" | "CASH">("CARD");
  const [cash, setCash] = useState("");
  const [quote, setQuote] = useState<{ kind: "idle" | "loading" | "ok" | "error"; text: string }>({ kind: "idle", text: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Client Account State
  const [clientToken, setClientToken] = useState<string | null>(null);
  const [client, setClient] = useState<ClientProfile | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [authErr, setAuthErr] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    api<Menu>(`/public/${SLUG}/menu`).then(setMenu).catch((e) => setLoadError(msg(e)));
    const tk = localStorage.getItem("client_token");
    if (tk) {
      setClientToken(tk);
      loadClientMe(tk);
    }
  }, []);

  async function loadClientMe(tk: string) {
    try {
      const me = await api<ClientProfile>(`/public/${SLUG}/clients/me`, {
        headers: { Authorization: `Bearer ${tk}` },
      });
      setClient(me);
      setF((p) => ({
        clientName: p.clientName || me.name || "",
        clientPhone: p.clientPhone || me.phone || "",
        streetType: me.streetType || p.streetType || "calle",
        streetName: p.streetName || me.streetName || "",
        streetNumber: p.streetNumber || me.streetNumber || "",
        postalCode: p.postalCode || me.postalCode || "",
        floor: p.floor || me.floor || "",
        door: p.door || me.door || "",
        notes: p.notes || me.notes || "",
      }));
    } catch {
      localStorage.removeItem("client_token");
      setClientToken(null);
      setClient(null);
    }
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault();
    setAuthErr("");
    setAuthBusy(true);
    try {
      const path = authMode === "login" ? `/public/${SLUG}/clients/login` : `/public/${SLUG}/clients/register`;
      const payload =
        authMode === "login"
          ? { email: authForm.email.trim(), password: authForm.password }
          : {
              name: authForm.name.trim(),
              email: authForm.email.trim(),
              phone: authForm.phone.trim(),
              password: authForm.password,
              streetType: f.streetType,
              streetName: f.streetName.trim(),
              streetNumber: f.streetNumber.trim(),
              postalCode: f.postalCode.trim(),
              floor: f.floor.trim(),
              door: f.door.trim(),
              notes: f.notes.trim(),
            };
      const res = await api<{ token: string; client: ClientProfile }>(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      localStorage.setItem("client_token", res.token);
      setClientToken(res.token);
      setAccountOpen(false);
      await loadClientMe(res.token);
    } catch (err) {
      setAuthErr(msg(err));
    } finally {
      setAuthBusy(false);
    }
  }

  function logoutClient() {
    localStorage.removeItem("client_token");
    setClientToken(null);
    setClient(null);
    setAccountOpen(false);
  }

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const products = useMemo(() => new Map((menu?.categories ?? []).flatMap((c) => c.products).map((p) => [p.id, p])), [menu]);
  const items = Object.entries(cart).filter(([, q]) => q > 0);
  const total = items.reduce((s, [id, q]) => s + Number(products.get(id)?.price ?? 0) * q, 0);
  const count = items.reduce((s, [, q]) => s + q, 0);
  const change = (id: string, d: number) => setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(50, (c[id] ?? 0) + d)) }));

  // Estimated time (and zone / opening-hours check) once the address looks complete
  useEffect(() => {
    if (!f.streetName.trim() || !f.streetNumber.trim() || !/^\d{5}$/.test(f.postalCode)) {
      setQuote({ kind: "idle", text: "" });
      return;
    }
    let cancelled = false;
    setQuote({ kind: "loading", text: "Calculando tiempo de entrega…" });
    const t = setTimeout(() => {
      api<{ etaMinutes: number }>(`/public/${SLUG}/quote`, {
        method: "POST",
        body: JSON.stringify({ streetType: f.streetType, streetName: f.streetName.trim(), streetNumber: f.streetNumber.trim(), postalCode: f.postalCode }),
      })
        .then((r) => !cancelled && setQuote({ kind: "ok", text: `Tiempo estimado de entrega: unos ${r.etaMinutes} minutos.` }))
        .catch((e) => !cancelled && setQuote({ kind: "error", text: msg(e) }));
    }, 700);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.streetType, f.streetName, f.streetNumber, f.postalCode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const cashNum = Number(cash.replace(",", "."));
    if (items.length === 0) return setError("Añade al menos un producto.");
    if (pay === "CASH" && (!cashNum || cashNum < total)) return setError(errorText.CASH_AMOUNT_TOO_LOW);
    setBusy(true);
    try {
      const r = await api<{ trackingToken: string }>(`/public/${SLUG}/orders`, {
        method: "POST",
        headers: clientToken ? { Authorization: `Bearer ${clientToken}` } : undefined,
        body: JSON.stringify({
          clientName: f.clientName.trim(), clientPhone: f.clientPhone.trim(),
          streetType: f.streetType, streetName: f.streetName.trim(), streetNumber: f.streetNumber.trim(), postalCode: f.postalCode,
          ...(f.floor.trim() && { floor: f.floor.trim() }), ...(f.door.trim() && { door: f.door.trim() }),
          ...(f.notes.trim() && { notes: f.notes.trim() }),
          paymentMethod: pay, ...(pay === "CASH" && { cashAmount: cashNum }),
          items: items.map(([productId, quantity]) => ({ productId, quantity })),
        }),
      });
      router.push(`/pedido/${r.trackingToken}`);
    } catch (err) {
      setError(msg(err));
      if (err instanceof ApiError && err.code === "VALIDATION") setError("Revisa el teléfono y la dirección (código postal de 5 cifras).");
      setBusy(false);
    }
  }

  if (loadError) return <main><div className="banner error">{loadError}</div></main>;
  if (!menu) return <main><p className="muted">Cargando…</p></main>;
  const h = menu.hours[0];

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: "8px 0 4px" }}>{menu.name}</h1>
        <button
          type="button"
          onClick={() => setAccountOpen(!accountOpen)}
          style={{
            padding: "8px 14px",
            borderRadius: 10,
            border: "1px solid var(--line)",
            background: "var(--card)",
            color: "var(--text)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          👤 {client ? client.name : "Mi cuenta"}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Reparto a domicilio gratis{h ? ` · de ${hhmm(h.openMin)} a ${hhmm(h.closeMin)}` : ""}</p>

      {/* CLIENT ACCOUNT PANEL */}
      {accountOpen && (
        <div className="card" style={{ marginBottom: 16 }}>
          {client ? (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 8, marginBottom: 8 }}>
                <div>
                  <strong>Hola, {client.name}</strong>
                  <div className="muted" style={{ fontSize: ".85rem" }}>{client.email} · Tel: {client.phone}</div>
                </div>
                <button
                  type="button"
                  onClick={logoutClient}
                  style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
                >
                  Cerrar sesión
                </button>
              </div>
              <strong>Mis pedidos ({client.orders?.length ?? 0})</strong>
              {(client.orders ?? []).length === 0 ? (
                <p className="muted" style={{ margin: "6px 0 0" }}>Aún no has hecho pedidos con esta cuenta.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  {(client.orders ?? []).map((o) => (
                    <div key={o.id} style={{ padding: 10, borderRadius: 10, border: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div>
                        <strong>Pedido #{o.number}</strong> · <span style={{ color: "var(--accent)", fontWeight: 600 }}>{STATUS_ES[o.status] ?? o.status}</span> · {eur(o.total)}
                        <div className="muted" style={{ fontSize: ".85rem" }}>
                          {o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => {
                            const nextCart: Record<string, number> = {};
                            o.items.forEach((i) => { nextCart[i.productId] = i.quantity; });
                            setCart(nextCart);
                            setAccountOpen(false);
                          }}
                          style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer", fontSize: ".85rem" }}
                        >
                          🔁 Repetir
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{ width: "auto", padding: "6px 12px", fontSize: ".85rem" }}
                          onClick={() => router.push(`/pedido/${o.trackingToken}`)}
                        >
                          Ver seguimiento / Chat
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={submitAuth}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button
                  type="button"
                  onClick={() => { setAuthMode("login"); setAuthErr(""); }}
                  style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid var(--line)", background: authMode === "login" ? "var(--accent)" : "var(--card)", color: authMode === "login" ? "var(--accent-text)" : "var(--text)", fontWeight: 700, cursor: "pointer" }}
                >
                  Iniciar sesión
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthMode("register"); setAuthErr(""); }}
                  style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid var(--line)", background: authMode === "register" ? "var(--accent)" : "var(--card)", color: authMode === "register" ? "var(--accent-text)" : "var(--text)", fontWeight: 700, cursor: "pointer" }}
                >
                  Crear cuenta
                </button>
              </div>
              {authMode === "register" && (
                <>
                  <label>Nombre</label>
                  <input required value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} />
                  <label>Teléfono</label>
                  <input required type="tel" minLength={6} value={authForm.phone} onChange={(e) => setAuthForm({ ...authForm, phone: e.target.value })} />
                </>
              )}
              <label>Correo electrónico</label>
              <input required type="email" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} />
              <label>Contraseña</label>
              <input required type="password" minLength={4} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} />
              {authErr && <div className="banner error">{authErr}</div>}
              <button type="submit" className="btn" style={{ marginTop: 12 }} disabled={authBusy}>
                {authBusy ? "…" : authMode === "login" ? "Entrar en mi cuenta" : "Crear cuenta y guardar mis datos"}
              </button>
              <p className="muted" style={{ fontSize: ".82rem", margin: "8px 0 0" }}>
                Con tu cuenta guardamos tu dirección habitual y puedes ver el historial y seguimiento de tus pedidos.
              </p>
            </form>
          )}
        </div>
      )}

      {!menu.open && (
        <div className="banner closed">
          Ahora mismo estamos cerrados y no se pueden hacer pedidos.{h ? ` Abrimos de ${hhmm(h.openMin)} a ${hhmm(h.closeMin)}.` : ""}
        </div>
      )}

      {menu.categories.map((c) => (
        <section key={c.id}>
          <h2>{c.name}</h2>
          {c.products.map((p) => (
            <div className="card product" key={p.id}>
              <div>
                <strong>{p.name}</strong> · {eur(p.price)}
                {p.description && <p>{p.description}</p>}
              </div>
              <div className="qty">
                {(cart[p.id] ?? 0) > 0 && (
                  <>
                    <button type="button" className="minus" aria-label={`Quitar ${p.name}`} onClick={() => change(p.id, -1)}>−</button>
                    <span>{cart[p.id]}</span>
                  </>
                )}
                <button type="button" aria-label={`Añadir ${p.name}`} onClick={() => change(p.id, 1)}>+</button>
              </div>
            </div>
          ))}
        </section>
      ))}

      <form onSubmit={submit} id="checkout">
        <h2>Tus datos</h2>
        <div className="card">
          <label htmlFor="n">Nombre</label>
          <input id="n" required value={f.clientName} onChange={set("clientName")} autoComplete="name" />
          <label htmlFor="t">Teléfono</label>
          <input id="t" required type="tel" minLength={6} value={f.clientPhone} onChange={set("clientPhone")} autoComplete="tel" />
        </div>

        <h2>Dirección de entrega</h2>
        <div className="card">
          <div className="row">
            <div>
              <label htmlFor="st">Tipo de vía</label>
              <select id="st" value={f.streetType} onChange={set("streetType")}>
                {["calle", "avenida", "plaza", "paseo", "camino", "carretera"].map((v) => <option key={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="cp">Código postal</label>
              <input id="cp" required inputMode="numeric" pattern="\d{5}" maxLength={5} value={f.postalCode} onChange={set("postalCode")} autoComplete="postal-code" />
            </div>
          </div>
          <label htmlFor="sn">Nombre de la vía</label>
          <input id="sn" required value={f.streetName} onChange={set("streetName")} autoComplete="address-line1" />
          <div className="row3">
            <div><label htmlFor="num">Número</label><input id="num" required value={f.streetNumber} onChange={set("streetNumber")} /></div>
            <div><label htmlFor="fl">Planta</label><input id="fl" value={f.floor} onChange={set("floor")} placeholder="opcional" /></div>
            <div><label htmlFor="dr">Puerta</label><input id="dr" value={f.door} onChange={set("door")} placeholder="opcional" /></div>
          </div>
          <label htmlFor="nt">Notas para el repartidor (opcional)</label>
          <textarea id="nt" rows={2} maxLength={500} value={f.notes} onChange={set("notes")} placeholder="Ej.: llámame al llegar / no llames al timbre, hay un bebé" />
        </div>
        {quote.kind !== "idle" && <div className={`banner ${quote.kind === "ok" ? "ok" : quote.kind === "error" ? "error" : ""}`}>{quote.text}</div>}

        <h2>Pago en la entrega</h2>
        <div className="pay">
          <label><input type="radio" name="pay" checked={pay === "CARD"} onChange={() => setPay("CARD")} style={{ width: "auto" }} /> Tarjeta</label>
          <label><input type="radio" name="pay" checked={pay === "CASH"} onChange={() => setPay("CASH")} style={{ width: "auto" }} /> Efectivo</label>
        </div>
        {pay === "CASH" && (
          <div className="card" style={{ marginTop: 8 }}>
            <label htmlFor="cash">¿Con cuánto vas a pagar? (€)</label>
            <input id="cash" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder={total ? `Total ${eur(total)}` : ""} />
            <p className="muted" style={{ margin: "6px 0 0" }}>Así el repartidor lleva el cambio preparado.</p>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}

        <div className="bar">
          <div className="inner">
            <div className="total">{count} {count === 1 ? "producto" : "productos"} · {eur(total)}</div>
            <button className="btn" type="submit" disabled={busy || !menu.open || count === 0 || quote.kind === "error"}>
              {busy ? "Enviando…" : "Hacer pedido"}
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}
