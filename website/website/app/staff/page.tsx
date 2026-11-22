"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { getApiBase, eur, playMessageSound } from "@/lib/api";

type Role = "JEFE" | "REPARTIDOR";
type Lang = "es" | "en";

const L10N: Record<Lang, Record<string, string>> = {
  es: {
    "login.title": "Acceso del personal",
    "login.email": "Correo electrónico",
    "login.password": "Contraseña",
    "login.button": "Entrar",
    ratings: "Valoraciones",
    noRatings: "Aún no hay valoraciones",
    rider: "Repartidor",
    "status.OFF": "Fuera de turno",
    "status.AVAILABLE": "Disponible en el restaurante",
    "status.DELIVERING": "Repartiendo",
    "status.COMING_BACK": "Volviendo al restaurante",
    noShift: "Sin turno abierto. Espera a que el jefe abra tu turno.",
    noOrders: "No tienes pedidos asignados",
    myOrders: "Mis pedidos",
    delivered: "ENTREGADO",
    confirmTitle: "Confirmar entrega",
    confirmBody: "¿Confirmas que has entregado el pedido",
    yes: "Sí",
    no: "No",
    call: "Llamar",
    map: "Mapa",
    edit: "Editar dirección",
    save: "Guardar",
    readyBtn: "LISTO PARA REPARTIR",
    myShift: "Mi turno",
    deliveries: "Entregas",
    cashCollected: "Efectivo cobrado",
    changeGiven: "Cambio recibido",
    cashDue: "Efectivo a entregar",
    cardPayments: "Pagos con tarjeta",
    logout: "Cerrar sesión",
    payCash: "Efectivo",
    payCard: "Tarjeta",
    paysWith: "paga con",
    giveChange: "cambio",
    notes: "Notas",
    stop: "Parada",
    floor: "planta",
    door: "puerta",
    streetType: "Tipo de vía",
    streetName: "Nombre de la vía",
    streetNumber: "Número",
    postalCode: "Código postal",
    floorLbl: "Planta",
    doorLbl: "Puerta",
    collect: "Cobrar",
    total: "Total",
    history: "Historial de entregas",
    noHistory: "Aún no has entregado ningún pedido en este turno",
    copy: "Copiar",
    copied: "¡Copiado!",
    chatJefe: "Chat Jefe",
    chatClient: "Chat cliente",
    chatEmpty: "Aún no hay mensajes",
    chatHint: "Escribe un mensaje…",
    send: "Enviar",
  },
  en: {
    "login.title": "Staff login",
    "login.email": "Email",
    "login.password": "Password",
    "login.button": "Log in",
    ratings: "Ratings",
    noRatings: "No ratings yet",
    rider: "Rider",
    "status.OFF": "Off shift",
    "status.AVAILABLE": "Available at the restaurant",
    "status.DELIVERING": "Delivering",
    "status.COMING_BACK": "Coming back to the restaurant",
    noShift: "No open shift. Wait for the jefe to open your shift.",
    noOrders: "You have no assigned orders",
    myOrders: "My orders",
    delivered: "DELIVERED",
    confirmTitle: "Confirm delivery",
    confirmBody: "Do you confirm you delivered order",
    yes: "Yes",
    no: "No",
    call: "Call",
    map: "Map",
    edit: "Edit address",
    save: "Save",
    readyBtn: "READY TO DELIVER",
    myShift: "My shift",
    deliveries: "Deliveries",
    cashCollected: "Cash collected",
    changeGiven: "Change received",
    cashDue: "Cash to hand over",
    cardPayments: "Card payments",
    logout: "Log out",
    payCash: "Cash",
    payCard: "Card",
    paysWith: "pays with",
    giveChange: "change",
    notes: "Notes",
    stop: "Stop",
    floor: "floor",
    door: "door",
    streetType: "Street type",
    streetName: "Street name",
    streetNumber: "Number",
    postalCode: "Postal code",
    floorLbl: "Floor",
    doorLbl: "Door",
    collect: "Collect",
    total: "Total",
    history: "Delivery history",
    noHistory: "No deliveries completed in this shift yet",
    copy: "Copy",
    copied: "Copied!",
    chatJefe: "Chat with Jefe",
    chatClient: "Client chat",
    chatEmpty: "No messages yet",
    chatHint: "Write a message…",
    send: "Send",
  },
};

const ERR_ES: Record<string, string> = {
  NETWORK: "Sin conexión con el servidor",
  INVALID_CREDENTIALS: "Email o contraseña incorrectos",
  NOT_COMING_BACK: "Solo puedes marcarte listo al volver al restaurante",
  NOT_YOUR_ORDER: "Este pedido no es tuyo",
  INVALID_STATUS: "El pedido no está en un estado válido para esta acción",
  RIDER_FULL: "El repartidor ya lleva 4 pedidos",
  RIDER_NOT_ON_SHIFT: "El repartidor no tiene turno abierto",
  RIDER_HAS_ORDERS: "El repartidor aún tiene pedidos en curso",
  SHIFT_ALREADY_OPEN: "Ya tiene un turno abierto",
  OUT_OF_ZONE: "Dirección fuera de la zona de reparto",
  ADDRESS_NOT_FOUND: "No se encuentra la dirección",
  CASH_AMOUNT_TOO_LOW: "El importe con el que paga es menor que el total",
  PRODUCT_UNAVAILABLE: "Algún producto no está disponible",
  VALIDATION: "Revisa los datos introducidos",
};

const hhmm = (iso?: string | null) => {
  if (!iso) return "…";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const riderStatusEs = (s: string, active: number) =>
  s === "AVAILABLE" ? "disponible" : s === "DELIVERING" ? `repartiendo (${active})` : s === "COMING_BACK" ? "volviendo" : "fuera de turno";

export default function StaffAppPage() {
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [name, setName] = useState("");
  const [lang, setLang] = useState<Lang>("es");
  const [ready, setReady] = useState(false);

  // Login form
  const [email, setEmail] = useState("jefe@demo.test");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [toast, setToast] = useState("");

  // Jefe state
  const [jefeTab, setJefeTab] = useState<"pedidos" | "riders" | "caja" | "menu" | "ratings">("pedidos");
  const [manualOpen, setManualOpen] = useState(false);
  const [orders, setOrders] = useState<any[]>([]);
  const [staffRiders, setStaffRiders] = useState<any[]>([]);
  const [liveRiders, setLiveRiders] = useState<{ riders: any[]; suggestedRiderId: string | null }>({ riders: [], suggestedRiderId: null });
  const [shifts, setShifts] = useState<any[]>([]);
  const [shiftSummaries, setShiftSummaries] = useState<Record<string, any>>({});
  const [editingShiftIds, setEditingShiftIds] = useState<Record<string, boolean>>({});
  const [menuCats, setMenuCats] = useState<any[]>([]);
  const [ratingsData, setRatingsData] = useState<{ average: number | null; count: number; ratings: any[] }>({ average: null, count: 0, ratings: [] });

  // Manual order form state
  const [mCart, setMCart] = useState<Record<string, number>>({});
  const [mForm, setMForm] = useState({
    clientName: "", clientPhone: "", streetType: "calle", streetName: "", streetNumber: "",
    postalCode: "", floor: "", door: "", notes: "", pay: "CARD" as "CARD" | "CASH", cash: "",
  });

  // Rider state
  const [riderShift, setRiderShift] = useState<any>({ onShift: false });
  const [riderSummary, setRiderSummary] = useState<any>(null);
  const [riderViewRatings, setRiderViewRatings] = useState(false);

  // Modals & Chat
  const [modal, setModal] = useState<any>(null);
  const [chatOpen, setChatOpen] = useState<{ title: string; subtitle?: string; endpoint: string; myRole: string } | null>(null);
  const [chatMsgs, setChatMsgs] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState("");
  const seenMsgIds = useRef<Set<string> | null>(null);

  const tr = useCallback((k: string) => L10N[role === "JEFE" ? "es" : lang]?.[k] ?? L10N.es[k] ?? k, [role, lang]);

  const showNotice = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2800);
  };

  const staffFetch = useCallback(
    async (path: string, method = "GET", body?: any, customToken?: string | null) => {
      const tk = customToken !== undefined ? customToken : token;
      const res = await fetch(getApiBase() + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 401 && tk) {
        localStorage.removeItem("staff_token");
        localStorage.removeItem("staff_role");
        localStorage.removeItem("staff_name");
        setToken(null);
        setRole(null);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const code = data?.error ?? `HTTP_${res.status}`;
        throw new Error(ERR_ES[code] ?? code);
      }
      return data;
    },
    [token]
  );

  useEffect(() => {
    const t = localStorage.getItem("staff_token");
    const r = localStorage.getItem("staff_role") as Role | null;
    const n = localStorage.getItem("staff_name") ?? "";
    const l = (localStorage.getItem("staff_lang") as Lang) || "es";
    if (t && r) {
      setToken(t);
      setRole(r);
      setName(n);
      setLang(r === "JEFE" ? "es" : l);
    }
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!token || !role) return;
    try {
      if (role === "JEFE") {
        const [ord, sr, lr, sh, mn, rt, inbox] = await Promise.all([
          staffFetch("/orders"),
          staffFetch("/staff/riders"),
          staffFetch("/riders"),
          staffFetch("/shifts"),
          staffFetch("/menu?all=1"),
          staffFetch("/ratings"),
          staffFetch("/chat/inbox"),
        ]);
        if (seenMsgIds.current !== null) {
          const newMsg = (inbox as any[]).find((m) => !seenMsgIds.current!.has(m.id));
          if (newMsg) {
            playMessageSound();
            showNotice(`💬 ${newMsg.senderName}: ${newMsg.text}`);
          }
        }
        seenMsgIds.current = new Set((inbox as any[]).map((m) => m.id));
        setOrders(ord);
        setStaffRiders(sr);
        setLiveRiders(lr);
        setShifts(sh);
        setMenuCats(mn);
        setRatingsData(rt);
        // Fetch shift summaries for today's shifts
        const sums: Record<string, any> = {};
        await Promise.all(
          sh.slice(0, 10).map(async (s: any) => {
            try {
              sums[s.id] = await staffFetch(`/shifts/${s.id}/summary`);
            } catch {}
          })
        );
        setShiftSummaries(sums);
      } else {
        const [sh, ord, rt, inbox] = await Promise.all([
          staffFetch("/me/shift"),
          staffFetch("/orders"),
          staffFetch("/ratings"),
          staffFetch("/chat/inbox"),
        ]);
        if (seenMsgIds.current !== null) {
          const newMsg = (inbox as any[]).find((m) => !seenMsgIds.current!.has(m.id));
          if (newMsg) {
            playMessageSound();
            showNotice(`💬 ${newMsg.senderName}: ${newMsg.text}`);
          }
        }
        seenMsgIds.current = new Set((inbox as any[]).map((m) => m.id));
        setRiderShift(sh);
        setOrders(ord);
        setRatingsData(rt);
        if (sh.onShift) {
          const sum = await staffFetch("/me/summary");
          setRiderSummary(sum);
        } else {
          setRiderSummary(null);
        }
      }
    } catch {}
  }, [token, role, staffFetch]);

  useEffect(() => {
    if (!token || !role) return;
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [token, role, refresh]);

  // Poll open chat
  useEffect(() => {
    if (!chatOpen || !token) return;
    let alive = true;
    const loadChat = () =>
      staffFetch(chatOpen.endpoint)
        .then((m) => { if (alive) setChatMsgs(m); })
        .catch(() => {});
    loadChat();
    const id = setInterval(loadChat, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [chatOpen, token, staffFetch]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    try {
      const r = await staffFetch("/auth/login", "POST", { email: email.trim(), password }, null);
      localStorage.setItem("staff_token", r.token);
      localStorage.setItem("staff_role", r.role);
      localStorage.setItem("staff_name", r.name);
      const chosenLang: Lang = r.role === "JEFE" ? "es" : lang;
      localStorage.setItem("staff_lang", chosenLang);
      setToken(r.token);
      setRole(r.role);
      setName(r.name);
      setLang(chosenLang);
      setPassword("");
    } catch (err: any) {
      showNotice(err.message || "Error al iniciar sesión");
    } finally {
      setLoginBusy(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem("staff_token");
    localStorage.removeItem("staff_role");
    localStorage.removeItem("staff_name");
    setToken(null);
    setRole(null);
    setManualOpen(false);
    setRiderViewRatings(false);
  }

  async function switchLang(l: Lang) {
    setLang(l);
    localStorage.setItem("staff_lang", l);
    if (token) {
      try { await staffFetch("/me/language", "POST", { language: l }); } catch {}
    }
  }

  function formatAddress(o: any) {
    const extra = [
      o.floor ? `${tr("floor")} ${o.floor}` : "",
      o.door ? `${tr("door")} ${o.door}` : "",
    ].filter(Boolean).join(" ");
    return `${o.streetType} ${o.streetName} ${o.streetNumber}${extra ? `, ${extra}` : ""} (${o.postalCode})`;
  }

  function formatPayLine(o: any) {
    if (o.paymentMethod === "CARD") return tr("payCard");
    if (!o.cashAmount) return tr("payCash");
    const change = Number(o.cashAmount) - Number(o.total);
    return `${tr("payCash")} · ${tr("paysWith")} ${eur(o.cashAmount)} · ${tr("giveChange")} ${eur(change)}`;
  }

  function copyText(txt: string) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).catch(() => {});
    }
    showNotice(`${tr("copied")}: ${txt}`);
  }

  function openGoogleMaps(o: any) {
    const mapAddr = `${o.streetType} ${o.streetName} ${o.streetNumber}, ${o.postalCode}`;
    copyText(mapAddr);
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapAddr)}`, "_blank", "noopener");
  }

  async function sendChatMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!chatOpen || !chatInput.trim()) return;
    try {
      await staffFetch(chatOpen.endpoint, "POST", { text: chatInput.trim() });
      setChatInput("");
      const updated = await staffFetch(chatOpen.endpoint);
      setChatMsgs(updated);
    } catch (err: any) {
      showNotice(err.message);
    }
  }

  async function submitManualOrder(e: React.FormEvent) {
    e.preventDefault();
    const items = Object.entries(mCart)
      .filter(([, q]) => q > 0)
      .map(([productId, quantity]) => ({ productId, quantity }));
    if (items.length === 0) return showNotice("Añade al menos un producto.");
    const allProds = new Map(menuCats.flatMap((c: any) => c.products).map((p: any) => [p.id, p]));
    const total = items.reduce((s, i) => s + Number(allProds.get(i.productId)?.price ?? 0) * i.quantity, 0);
    const cashNum = Number(mForm.cash.replace(",", "."));
    if (mForm.pay === "CASH" && mForm.cash.trim() && (!cashNum || cashNum < total)) {
      return showNotice(ERR_ES.CASH_AMOUNT_TOO_LOW);
    }
    try {
      await staffFetch("/orders", "POST", {
        clientName: mForm.clientName.trim(),
        clientPhone: mForm.clientPhone.trim(),
        streetType: mForm.streetType,
        streetName: mForm.streetName.trim(),
        streetNumber: mForm.streetNumber.trim(),
        postalCode: mForm.postalCode.trim(),
        ...(mForm.floor.trim() && { floor: mForm.floor.trim() }),
        ...(mForm.door.trim() && { door: mForm.door.trim() }),
        ...(mForm.notes.trim() && { notes: mForm.notes.trim() }),
        paymentMethod: mForm.pay,
        ...(mForm.pay === "CASH" && cashNum ? { cashAmount: cashNum } : {}),
        items,
      });
      setMCart({});
      setMForm({
        clientName: "", clientPhone: "", streetType: "calle", streetName: "", streetNumber: "",
        postalCode: "", floor: "", door: "", notes: "", pay: "CARD", cash: "",
      });
      setManualOpen(false);
      setJefeTab("pedidos");
      await refresh();
      showNotice("Pedido manual creado");
    } catch (err: any) {
      showNotice(err.message);
    }
  }

  if (!ready) return <main><p className="muted">Cargando…</p></main>;

  // ==================== LOGIN SCREEN ====================
  if (!token || !role) {
    return (
      <main style={{ maxWidth: 440, paddingTop: 24 }}>
        {toast && <div className="banner error">{toast}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <strong>Staff App (iOS & Android)</strong>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setLang("es")} className="btn" style={{ width: "auto", padding: "6px 12px", opacity: lang === "es" ? 1 : 0.45 }}>ES</button>
            <button type="button" onClick={() => setLang("en")} className="btn" style={{ width: "auto", padding: "6px 12px", opacity: lang === "en" ? 1 : 0.45 }}>EN</button>
          </div>
        </div>
        <div className="card" style={{ padding: 20 }}>
          <h1 style={{ marginTop: 0 }}>{L10N[lang]["login.title"]}</h1>
          <p className="muted" style={{ fontSize: ".88rem", marginBottom: 12 }}>
            Selecciona cuenta rápida para probar:
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            <button type="button" onClick={() => setEmail("jefe@demo.test")} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: email === "jefe@demo.test" ? "var(--accent)" : "var(--card)", color: email === "jefe@demo.test" ? "#fff" : "var(--text)", cursor: "pointer", fontSize: ".82rem", fontWeight: 600 }}>
              Jefe (jefe@demo.test)
            </button>
            <button type="button" onClick={() => setEmail("rep1@demo.test")} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: email === "rep1@demo.test" ? "var(--accent)" : "var(--card)", color: email === "rep1@demo.test" ? "#fff" : "var(--text)", cursor: "pointer", fontSize: ".82rem", fontWeight: 600 }}>
              Repartidor 1 (rep1@demo.test)
            </button>
            <button type="button" onClick={() => setEmail("rep2@demo.test")} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: email === "rep2@demo.test" ? "var(--accent)" : "var(--card)", color: email === "rep2@demo.test" ? "#fff" : "var(--text)", cursor: "pointer", fontSize: ".82rem", fontWeight: 600 }}>
              Repartidor 2 (rep2@demo.test)
            </button>
          </div>
          <form onSubmit={handleLogin}>
            <label>{L10N[lang]["login.email"]}</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <label>{L10N[lang]["login.password"]}</label>
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="SEED_JEFE_PASSWORD" />
            <button type="submit" className="btn" style={{ marginTop: 16 }} disabled={loginBusy}>
              {loginBusy ? "…" : L10N[lang]["login.button"]}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // ==================== JEFE INTERFACE ====================
  if (role === "JEFE") {
    const liveByUserId = new Map(liveRiders.riders.map((r: any) => [r.id, r]));
    const availProds = new Map(menuCats.flatMap((c: any) => c.products.filter((p: any) => p.available)).map((p: any) => [p.id, p]));
    const mItems = Object.entries(mCart).filter(([, q]) => q > 0);
    const mTotal = mItems.reduce((s, [id, q]) => s + Number(availProds.get(id)?.price ?? 0) * q, 0);
    const mCount = mItems.reduce((s, [, q]) => s + q, 0);

    return (
      <main style={{ paddingBottom: 100 }}>
        {toast && <div className="banner ok" style={{ position: "sticky", top: 8, zIndex: 30, background: "var(--card)" }}>{toast}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h1 style={{ margin: "4px 0" }}>Jefe · {name}</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn"
              style={{ width: "auto", padding: "8px 12px", fontSize: ".9rem" }}
              onClick={() => setManualOpen(!manualOpen)}
            >
              {manualOpen ? "← Volver a Pedidos" : "＋ Pedido manual"}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
            >
              Salir
            </button>
          </div>
        </div>

        {/* 5 Tabs */}
        {!manualOpen && (
          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)", margin: "12px 0", overflowX: "auto" }}>
            {([
              ["pedidos", "Pedidos"],
              ["riders", "Repartidores"],
              ["caja", "Caja"],
              ["menu", "Menú"],
              ["ratings", "Valoraciones"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setJefeTab(id)}
                style={{
                  padding: "10px 12px",
                  border: 0,
                  borderBottom: jefeTab === id ? "3px solid var(--accent)" : "3px solid transparent",
                  background: "none",
                  color: jefeTab === id ? "var(--accent)" : "var(--muted)",
                  fontWeight: 700,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* MANUAL ORDER FORM (Same as Client Website) */}
        {manualOpen && (
          <form onSubmit={submitManualOrder}>
            <h2>Pedido manual (mismo formulario que la web)</h2>
            {menuCats.map((c: any) => {
              const avail = (c.products ?? []).filter((p: any) => p.available);
              if (!avail.length) return null;
              return (
                <section key={c.id}>
                  <h2 style={{ fontSize: "1rem", margin: "12px 0 6px" }}>{c.name}</h2>
                  {avail.map((p: any) => (
                    <div className="card product" key={p.id}>
                      <div>
                        <strong>{p.name}</strong> · {eur(p.price)}
                        {p.description && <p>{p.description}</p>}
                      </div>
                      <div className="qty">
                        {(mCart[p.id] ?? 0) > 0 && (
                          <>
                            <button type="button" className="minus" onClick={() => setMCart((prev) => ({ ...prev, [p.id]: Math.max(0, (prev[p.id] ?? 0) - 1) }))}>−</button>
                            <span>{mCart[p.id]}</span>
                          </>
                        )}
                        <button type="button" onClick={() => setMCart((prev) => ({ ...prev, [p.id]: Math.min(50, (prev[p.id] ?? 0) + 1) }))}>+</button>
                      </div>
                    </div>
                  ))}
                </section>
              );
            })}

            <h2>Datos del cliente</h2>
            <div className="card">
              <label>Nombre</label>
              <input required value={mForm.clientName} onChange={(e) => setMForm({ ...mForm, clientName: e.target.value })} />
              <label>Teléfono</label>
              <input required type="tel" minLength={6} value={mForm.clientPhone} onChange={(e) => setMForm({ ...mForm, clientPhone: e.target.value })} />
            </div>

            <h2>Dirección de entrega</h2>
            <div className="card">
              <div className="row">
                <div>
                  <label>Tipo de vía</label>
                  <select value={mForm.streetType} onChange={(e) => setMForm({ ...mForm, streetType: e.target.value })}>
                    {["calle", "avenida", "plaza", "paseo", "camino", "carretera"].map((v) => <option key={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label>Código postal</label>
                  <input required pattern="\d{5}" maxLength={5} value={mForm.postalCode} onChange={(e) => setMForm({ ...mForm, postalCode: e.target.value })} />
                </div>
              </div>
              <label>Nombre de la vía</label>
              <input required value={mForm.streetName} onChange={(e) => setMForm({ ...mForm, streetName: e.target.value })} />
              <div className="row3">
                <div><label>Número</label><input required value={mForm.streetNumber} onChange={(e) => setMForm({ ...mForm, streetNumber: e.target.value })} /></div>
                <div><label>Planta</label><input value={mForm.floor} onChange={(e) => setMForm({ ...mForm, floor: e.target.value })} placeholder="opcional" /></div>
                <div><label>Puerta</label><input value={mForm.door} onChange={(e) => setMForm({ ...mForm, door: e.target.value })} placeholder="opcional" /></div>
              </div>
              <label>Notas para el repartidor (opcional)</label>
              <textarea rows={2} maxLength={500} value={mForm.notes} onChange={(e) => setMForm({ ...mForm, notes: e.target.value })} placeholder="Ej.: llámame al llegar / no llames al timbre, hay un bebé" />
            </div>

            <h2>Pago en la entrega</h2>
            <div className="pay">
              <label><input type="radio" name="mpay" checked={mForm.pay === "CARD"} onChange={() => setMForm({ ...mForm, pay: "CARD" })} style={{ width: "auto" }} /> Tarjeta</label>
              <label><input type="radio" name="mpay" checked={mForm.pay === "CASH"} onChange={() => setMForm({ ...mForm, pay: "CASH" })} style={{ width: "auto" }} /> Efectivo</label>
            </div>
            {mForm.pay === "CASH" && (
              <div className="card" style={{ marginTop: 8 }}>
                <label>¿Con cuánto va a pagar? (€)</label>
                <input inputMode="decimal" value={mForm.cash} onChange={(e) => setMForm({ ...mForm, cash: e.target.value })} placeholder={mTotal ? `Total ${eur(mTotal)}` : ""} />
                <p className="muted" style={{ margin: "6px 0 0" }}>Así el repartidor lleva el cambio preparado.</p>
              </div>
            )}

            <div className="bar">
              <div className="inner">
                <div className="total">{mCount} {mCount === 1 ? "producto" : "productos"} · {eur(mTotal)}</div>
                <button className="btn" type="submit" disabled={mCount === 0}>Hacer pedido</button>
              </div>
            </div>
          </form>
        )}

        {/* TAB 1: PEDIDOS */}
        {!manualOpen && jefeTab === "pedidos" && (
          <div>
            {([
              ["IN_KITCHEN", "En cocina"],
              ["READY", "Listos"],
              ["ON_THE_WAY", "En camino"],
              ["DELIVERED", "Entregados"],
            ] as const).map(([code, title]) => {
              const list = orders.filter((o) => o.status === code);
              if (!list.length) return null;
              return (
                <section key={code}>
                  <h2>{title} ({list.length})</h2>
                  {list.map((o) => (
                    <div className="card" key={o.id}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                        <span>#{o.number} · {o.clientName} · {hhmm(o.createdAt)}</span>
                        <span>Total {eur(o.total)} · ~{o.etaMinutes} min</span>
                      </div>
                      <div className="muted">{formatAddress(o)} · Tel: {o.clientPhone}</div>
                      <div style={{ margin: "4px 0" }}>{(o.items ?? []).map((i: any) => `${i.quantity}× ${i.name}`).join(", ")}</div>
                      <div>{formatPayLine(o)}</div>
                      {o.notes && <div className="muted" style={{ fontStyle: "italic" }}>Notas: {o.notes}</div>}
                      {o.repartidor && <div style={{ color: "var(--accent)", fontWeight: 600 }}>Repartidor: {o.repartidor.name}</div>}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        {code === "IN_KITCHEN" && (
                          <>
                            <button type="button" className="btn" style={{ width: "auto", padding: "6px 14px" }} onClick={async () => { await staffFetch(`/orders/${o.id}/ready`, "POST"); refresh(); }}>Listo</button>
                            <button type="button" style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }} onClick={async () => { await staffFetch(`/orders/${o.id}/reprint`, "POST"); showNotice("Reimpresión enviada a cocina"); }}>Reimprimir</button>
                          </>
                        )}
                        {(code === "READY" || code === "ON_THE_WAY") && (
                          <button
                            type="button"
                            className="btn"
                            style={{ width: "auto", padding: "6px 14px" }}
                            onClick={() => setModal({ type: "assign", order: o })}
                          >
                            {code === "READY" ? "Asignar" : "Reasignar"}
                          </button>
                        )}
                        <button
                          type="button"
                          style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
                          onClick={() => setChatOpen({
                            title: `Chat privado · #${o.number} ${o.clientName}`,
                            subtitle: "🔒 Chat privado Jefe ↔ Cliente (el repartidor no ve estos mensajes)",
                            endpoint: `/orders/${o.id}/messages`,
                            myRole: "JEFE",
                          })}
                        >
                          💬 Chat privado cliente
                        </button>
                        {code !== "DELIVERED" && (
                          <button
                            type="button"
                            style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--bad)", background: "transparent", color: "var(--bad)", cursor: "pointer" }}
                            onClick={() => setModal({ type: "cancel", order: o, reason: "" })}
                          >
                            Cancelar
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              );
            })}
            {orders.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 32 }}>Sin pedidos hoy</p>}
          </div>
        )}

        {/* TAB 2: REPARTIDORES */}
        {!manualOpen && jefeTab === "riders" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span className="muted">Equipo de reparto ({staffRiders.length} repartidores)</span>
              <button
                type="button"
                className="btn"
                style={{ width: "auto", padding: "6px 14px" }}
                onClick={() => setModal({ type: "newRider", name: "", email: "", password: "", documentNumber: "", phone: "" })}
              >
                ＋ Nuevo repartidor
              </button>
            </div>
            {staffRiders.map((r) => {
              const live = liveByUserId.get(r.id);
              return (
                <div className="card" key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div>
                    <strong>{r.name}</strong> {r.email && <span className="muted" style={{ fontSize: ".8rem" }}>({r.email})</span>}
                    <div className="muted" style={{ fontSize: ".85rem" }}>
                      Doc: {r.documentNumber || "—"} · Tel: {r.phone || "—"}
                    </div>
                    <div style={{ fontWeight: 600 }}>
                      {live ? riderStatusEs(live.status, live.activeOrders) : "Fuera de turno"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
                      onClick={() => setChatOpen({ title: `Chat · ${r.name}`, endpoint: `/chat/staff/${r.id}`, myRole: "JEFE" })}
                    >
                      💬 Chat
                    </button>
                    <button
                      type="button"
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
                      onClick={() => setModal({ type: "editRider", rider: r, name: r.name, documentNumber: r.documentNumber || "", phone: r.phone || "" })}
                    >
                      ✏️ Editar
                    </button>
                    {!live ? (
                      <button
                        type="button"
                        className="btn"
                        style={{ width: "auto", padding: "6px 14px" }}
                        onClick={() => setModal({ type: "openShift", rider: r, changeGiven: "30" })}
                      >
                        Abrir turno
                      </button>
                    ) : (
                      <button
                        type="button"
                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
                        onClick={async () => {
                          try {
                            await staffFetch(`/shifts/${live.shiftId}/close`, "POST");
                            await refresh();
                          } catch (err: any) {
                            showNotice(err.message);
                          }
                        }}
                      >
                        Cerrar turno
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* TAB 3: CAJA */}
        {!manualOpen && jefeTab === "caja" && (
          <div>
            {shifts.map((s) => {
              const sum = shiftSummaries[s.id];
              const isClosed = s.endedAt !== null;
              const isEditing = editingShiftIds[s.id] ?? false;
              const showSettleButtons = isClosed && (s.settlement === "PENDING" || isEditing);
              const showCorregirButton = isClosed && s.settlement !== "PENDING" && !isEditing;
              const stLabel = !isClosed ? "en curso" : s.settlement === "BALANCED" ? "cuadrado" : s.settlement === "DIFFERENCE" ? `diferencia ${eur(s.difference ?? 0)}` : "pendiente de liquidar";

              return (
                <div className="card" key={s.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 8, marginBottom: 8 }}>
                    <div>
                      <strong>Turno de {s.user?.name}</strong>
                      <div className="muted">
                        {hhmm(s.startedAt)}–{isClosed ? hhmm(s.endedAt) : "…"} · <strong style={{ color: "var(--accent)" }}>{stLabel}</strong>
                      </div>
                      {s.settlementNote && <div className="muted" style={{ fontStyle: "italic" }}>Nota: {s.settlementNote}</div>}
                    </div>
                    {showCorregirButton && (
                      <button
                        type="button"
                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer", fontWeight: 600 }}
                        onClick={() => setEditingShiftIds((p) => ({ ...p, [s.id]: true }))}
                      >
                        Corregir
                      </button>
                    )}
                  </div>
                  {sum && (
                    <div>
                      <div>Entregas: <strong>{sum.deliveries}</strong></div>
                      <div>Efectivo cobrado: <strong>{eur(sum.cashCollected)}</strong></div>
                      <div>Cambio entregado: <strong>{eur(sum.changeGiven)}</strong></div>
                      <div style={{ fontWeight: 700, marginTop: 4 }}>Efectivo a recibir: {eur(sum.cashDue)}</div>
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                        <strong>Pagos con tarjeta: {(sum.cardPayments ?? []).length}</strong> <span className="muted">(uno por uno, nunca sumados)</span>
                        {(sum.cardPayments ?? []).map((c: any) => (
                          <div key={c.orderNumber} style={{ paddingLeft: 10, fontFamily: "monospace" }}>#{c.orderNumber} — {eur(c.amount)}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {showSettleButtons && (
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn"
                        style={{ width: "auto", padding: "6px 14px" }}
                        onClick={async () => {
                          await staffFetch(`/shifts/${s.id}/settle`, "POST", { settlement: "BALANCED" });
                          setEditingShiftIds((p) => ({ ...p, [s.id]: false }));
                          await refresh();
                        }}
                      >
                        Cuadrado
                      </button>
                      <button
                        type="button"
                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
                        onClick={() => setModal({ type: "settleDiff", shift: s, difference: s.difference ?? "-2", note: s.settlementNote ?? "" })}
                      >
                        Con diferencia
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {shifts.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 32 }}>Sin turnos hoy</p>}
          </div>
        )}

        {/* TAB 4: MENÚ */}
        {!manualOpen && jefeTab === "menu" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <span className="muted">Carta del restaurante ({menuCats.length} categorías)</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--ok)", background: "transparent", color: "var(--ok)", fontWeight: 600, cursor: "pointer" }}
                  onClick={async () => { await staffFetch("/restaurant/hours", "POST", { openMin: 0, closeMin: 1440 }); showNotice("Web abierta 24h para pedidos"); }}
                >
                  🟢 Abrir web 24h
                </button>
                <button
                  type="button"
                  style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
                  onClick={async () => { await staffFetch("/restaurant/hours", "POST", { openMin: 780, closeMin: 1440 }); showNotice("Horario 13:00–00:00 restaurado"); }}
                >
                  🕒 Horario 13:00–00:00
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ width: "auto", padding: "6px 14px" }}
                  onClick={() => setModal({ type: "category", cat: null, name: "" })}
                >
                  ＋ Nueva categoría
                </button>
              </div>
            </div>
            {menuCats.map((cat: any) => (
              <div className="card" key={cat.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 8, marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <strong>{cat.name}</strong>
                    <button type="button" style={{ border: "1px solid var(--line)", background: "var(--card)", borderRadius: 6, padding: "2px 6px", cursor: "pointer" }} onClick={() => setModal({ type: "category", cat, name: cat.name })}>✏️</button>
                    <button type="button" style={{ border: "1px solid var(--line)", background: "var(--card)", borderRadius: 6, padding: "2px 6px", cursor: "pointer", color: "var(--bad)" }} onClick={async () => { await staffFetch(`/menu/categories/${cat.id}`, "DELETE"); refresh(); }}>🗑️</button>
                  </div>
                  <button
                    type="button"
                    style={{ padding: "4px 10px", borderRadius: 8, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent)", fontWeight: 600, cursor: "pointer" }}
                    onClick={() => setModal({ type: "product", categoryId: cat.id, prod: null, name: "", description: "", price: "9.50" })}
                  >
                    ＋ Añadir plato
                  </button>
                </div>
                {(cat.products ?? []).map((p: any) => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                    <div style={{ opacity: p.available ? 1 : 0.5, textDecoration: p.available ? "none" : "line-through" }}>
                      <strong>{p.name}</strong> · <span style={{ color: "var(--accent)", fontWeight: 600 }}>{eur(p.price)}</span>
                      {p.description && <div className="muted" style={{ fontSize: ".85rem" }}>{p.description}</div>}
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <button
                        type="button"
                        style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid var(--line)", background: p.available ? "var(--ok)" : "var(--card)", color: p.available ? "#fff" : "var(--muted)", cursor: "pointer", fontSize: ".78rem", fontWeight: 600 }}
                        onClick={async () => { await staffFetch(`/menu/products/${p.id}`, "PATCH", { available: !p.available }); refresh(); }}
                      >
                        {p.available ? "Disponible" : "Agotado"}
                      </button>
                      <button type="button" style={{ border: "1px solid var(--line)", background: "var(--card)", borderRadius: 6, padding: "3px 7px", cursor: "pointer" }} onClick={() => setModal({ type: "product", categoryId: cat.id, prod: p, name: p.name, description: p.description || "", price: String(p.price) })}>✏️</button>
                      <button type="button" style={{ border: "1px solid var(--line)", background: "var(--card)", borderRadius: 6, padding: "3px 7px", cursor: "pointer", color: "var(--bad)" }} onClick={async () => { await staffFetch(`/menu/products/${p.id}`, "DELETE"); refresh(); }}>🗑️</button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* TAB 5: VALORACIONES */}
        {!manualOpen && jefeTab === "ratings" && (
          <div>
            {ratingsData.average !== null && (
              <h2>★ {Number(ratingsData.average).toFixed(1)} ({ratingsData.count})</h2>
            )}
            {ratingsData.ratings.map((r: any) => (
              <div className="card" key={r.id}>
                <div style={{ color: "#f59f00", fontSize: "1.1rem" }}>{"★".repeat(r.score)}{"☆".repeat(5 - r.score)}</div>
                {r.comment && <div style={{ margin: "4px 0" }}>{r.comment}</div>}
                <div className="muted">#{r.orderNumber}{r.repartidor ? ` · Repartidor: ${r.repartidor}` : ""} · {hhmm(r.createdAt)}</div>
              </div>
            ))}
            {ratingsData.ratings.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 32 }}>Aún no hay valoraciones</p>}
          </div>
        )}

        {/* JEFE MODALS */}
        {modal && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
            <div className="card" style={{ maxWidth: 400, width: "100%", padding: 16 }}>
              {modal.type === "assign" && (
                <>
                  <strong>Asignar repartidor · #{modal.order.number}</strong>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
                    {liveRiders.riders.length === 0 && <p className="muted">Ningún repartidor con turno abierto</p>}
                    {liveRiders.riders.map((r: any) => (
                      <button
                        key={r.id}
                        type="button"
                        className="btn"
                        onClick={async () => {
                          try {
                            await staffFetch(`/orders/${modal.order.id}/assign`, "POST", { repartidorId: r.id });
                            setModal(null);
                            await refresh();
                          } catch (err: any) {
                            showNotice(err.message);
                          }
                        }}
                      >
                        {r.id === liveRiders.suggestedRiderId ? "★ " : ""}{r.name} — {riderStatusEs(r.status, r.activeOrders)}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={() => setModal(null)} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Cerrar</button>
                </>
              )}

              {modal.type === "cancel" && (
                <>
                  <strong>Cancelar pedido #{modal.order.number}</strong>
                  <label>Motivo</label>
                  <input value={modal.reason} onChange={(e) => setModal({ ...modal, reason: e.target.value })} placeholder="Ej.: Fuera de stock / petición del cliente" />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Volver</button>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        try {
                          await staffFetch(`/orders/${modal.order.id}/cancel`, "POST", { reason: modal.reason.trim() });
                          setModal(null);
                          await refresh();
                        } catch (err: any) {
                          showNotice(err.message);
                        }
                      }}
                    >
                      Cancelar pedido
                    </button>
                  </div>
                </>
              )}

              {modal.type === "openShift" && (
                <>
                  <strong>Abrir turno · {modal.rider.name}</strong>
                  <label>Cambio entregado (€)</label>
                  <input type="number" value={modal.changeGiven} onChange={(e) => setModal({ ...modal, changeGiven: e.target.value })} />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Volver</button>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        try {
                          await staffFetch("/shifts/open", "POST", { userId: modal.rider.id, changeGiven: Number(modal.changeGiven) || 0 });
                          setModal(null);
                          await refresh();
                        } catch (err: any) {
                          showNotice(err.message);
                        }
                      }}
                    >
                      Abrir turno
                    </button>
                  </div>
                </>
              )}

              {modal.type === "newRider" && (
                <>
                  <strong>Nuevo repartidor</strong>
                  <label>Nombre completo *</label>
                  <input value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} placeholder="Ej.: Miguel Ángel" />
                  <label>Correo electrónico (para entrar en la app) *</label>
                  <input type="email" value={modal.email} onChange={(e) => setModal({ ...modal, email: e.target.value })} placeholder="Ej.: rep3@demo.test" />
                  <label>Contraseña (para entrar en la app) *</label>
                  <input type="password" value={modal.password} onChange={(e) => setModal({ ...modal, password: e.target.value })} placeholder="Mínimo 4 caracteres" />
                  <label>DNI / NIE / Pasaporte</label>
                  <input value={modal.documentNumber} onChange={(e) => setModal({ ...modal, documentNumber: e.target.value })} placeholder="Ej.: 71458291K" />
                  <label>Teléfono</label>
                  <input value={modal.phone} onChange={(e) => setModal({ ...modal, phone: e.target.value })} placeholder="Ej.: 644112233" />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Cancelar</button>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        try {
                          await staffFetch("/staff/riders", "POST", {
                            name: modal.name.trim(),
                            email: modal.email.trim(),
                            password: modal.password,
                            documentNumber: modal.documentNumber.trim(),
                            phone: modal.phone.trim(),
                          });
                          setModal(null);
                          await refresh();
                          showNotice("Repartidor añadido");
                        } catch (err: any) {
                          showNotice(err.message);
                        }
                      }}
                    >
                      Crear repartidor
                    </button>
                  </div>
                </>
              )}

              {modal.type === "editRider" && (
                <>
                  <strong>Datos del repartidor</strong>
                  <label>Nombre</label>
                  <input value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} />
                  <label>DNI / NIE / Pasaporte</label>
                  <input value={modal.documentNumber} onChange={(e) => setModal({ ...modal, documentNumber: e.target.value })} />
                  <label>Teléfono</label>
                  <input value={modal.phone} onChange={(e) => setModal({ ...modal, phone: e.target.value })} />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Cancelar</button>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        try {
                          await staffFetch(`/staff/riders/${modal.rider.id}`, "PATCH", {
                            name: modal.name.trim(),
                            documentNumber: modal.documentNumber.trim(),
                            phone: modal.phone.trim(),
                          });
                          setModal(null);
                          await refresh();
                        } catch (err: any) {
                          showNotice(err.message);
                        }
                      }}
                    >
                      Guardar
                    </button>
                  </div>
                </>
              )}

              {modal.type === "settleDiff" && (
                <>
                  <strong>Liquidar con diferencia</strong>
                  <label>Diferencia (− falta, + sobra)</label>
                  <input type="number" step="0.5" value={modal.difference} onChange={(e) => setModal({ ...modal, difference: e.target.value })} />
                  <label>Nota</label>
                  <input value={modal.note} onChange={(e) => setModal({ ...modal, note: e.target.value })} />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Cancelar</button>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        await staffFetch(`/shifts/${modal.shift.id}/settle`, "POST", {
                          settlement: "DIFFERENCE",
                          difference: Number(modal.difference) || 0,
                          note: modal.note.trim(),
                        });
                        setEditingShiftIds((p) => ({ ...p, [modal.shift.id]: false }));
                        setModal(null);
                        await refresh();
                      }}
                    >
                      Guardar
                    </button>
                  </div>
                </>
              )}

              {modal.type === "category" && (
                <>
                  <strong>{modal.cat ? "Editar categoría" : "Nueva categoría"}</strong>
                  <label>Nombre de la categoría</label>
                  <input value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} placeholder="Ej.: Pizzas, Kebab, Bebidas" />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Cancelar</button>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        if (!modal.name.trim()) return;
                        if (modal.cat) await staffFetch(`/menu/categories/${modal.cat.id}`, "PATCH", { name: modal.name.trim() });
                        else await staffFetch("/menu/categories", "POST", { name: modal.name.trim() });
                        setModal(null);
                        await refresh();
                      }}
                    >
                      Guardar
                    </button>
                  </div>
                </>
              )}

              {modal.type === "product" && (
                <>
                  <strong>{modal.prod ? "Editar plato" : "Nuevo plato"}</strong>
                  <label>Nombre</label>
                  <input value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })} />
                  <label>Descripción / ingredientes (opcional)</label>
                  <input value={modal.description} onChange={(e) => setModal({ ...modal, description: e.target.value })} />
                  <label>Precio (€)</label>
                  <input type="number" step="0.5" value={modal.price} onChange={(e) => setModal({ ...modal, price: e.target.value })} />
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>Cancelar</button>
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        if (!modal.name.trim()) return;
                        const payload = {
                          categoryId: modal.categoryId,
                          name: modal.name.trim(),
                          description: modal.description.trim(),
                          price: Number(String(modal.price).replace(",", ".")) || 0,
                        };
                        if (modal.prod) await staffFetch(`/menu/products/${modal.prod.id}`, "PATCH", payload);
                        else await staffFetch("/menu/products", "POST", payload);
                        setModal(null);
                        await refresh();
                      }}
                    >
                      Guardar
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* CHAT MODAL */}
        {chatOpen && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
            <div className="card" style={{ maxWidth: 420, width: "100%", padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                <div>
                  <strong>💬 {chatOpen.title}</strong>
                  {chatOpen.subtitle && <div className="muted" style={{ fontSize: ".78rem" }}>{chatOpen.subtitle}</div>}
                </div>
                <button type="button" onClick={() => setChatOpen(null)} style={{ border: 0, background: "none", fontSize: "1.2rem", cursor: "pointer", color: "var(--text)" }}>✕</button>
              </div>
              <div style={{ maxHeight: 260, overflowY: "auto", margin: "10px 0", display: "flex", flexDirection: "column", gap: 6 }}>
                {chatMsgs.length === 0 && <p className="muted" style={{ textAlign: "center" }}>{tr("chatEmpty")}</p>}
                {chatMsgs.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: m.senderRole === chatOpen.myRole ? "flex-end" : "flex-start",
                      background: m.senderRole === chatOpen.myRole ? "var(--accent)" : "var(--line)",
                      color: m.senderRole === chatOpen.myRole ? "#fff" : "var(--text)",
                      padding: "6px 10px",
                      borderRadius: 10,
                      maxWidth: "85%",
                    }}
                  >
                    <div style={{ fontSize: ".75rem", opacity: 0.85, fontWeight: 600 }}>{m.senderName} · {hhmm(m.createdAt)}</div>
                    <div>{m.text}</div>
                  </div>
                ))}
              </div>
              <form onSubmit={sendChatMessage} style={{ display: "flex", gap: 8 }}>
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder={tr("chatHint")} />
                <button type="submit" className="btn" style={{ width: "auto", padding: "8px 16px" }}>{tr("send")}</button>
              </form>
            </div>
          </div>
        )}
      </main>
    );
  }

  // ==================== REPARTIDOR INTERFACE ====================
  const st = riderShift.onShift ? (riderShift.status as string) : "OFF";
  const hist = (riderSummary?.history ?? []) as any[];
  const cards = (riderSummary?.cardPayments ?? []) as any[];

  return (
    <main>
      {toast && <div className="banner ok" style={{ position: "sticky", top: 8, zIndex: 30, background: "var(--card)" }}>{toast}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>{name}</h1>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setChatOpen({ title: tr("chatJefe"), endpoint: "/chat/staff/me", myRole: "REPARTIDOR" })}
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
          >
            💬 {tr("chatJefe")}
          </button>
          <button
            type="button"
            onClick={() => setRiderViewRatings(!riderViewRatings)}
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}
          >
            ★ {tr("ratings")}
          </button>
          <button type="button" onClick={() => switchLang(lang === "es" ? "en" : "es")} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer", fontWeight: 700 }}>
            {lang.toUpperCase()}
          </button>
          <button type="button" onClick={handleLogout} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}>
            {tr("logout")}
          </button>
        </div>
      </div>

      {riderViewRatings ? (
        <div>
          <button type="button" onClick={() => setRiderViewRatings(false)} style={{ marginBottom: 12, border: 0, background: "none", color: "var(--accent)", fontWeight: 700, cursor: "pointer" }}>
            ← Volver
          </button>
          {ratingsData.average !== null && <h2>★ {Number(ratingsData.average).toFixed(1)} ({ratingsData.count})</h2>}
          {ratingsData.ratings.map((r: any) => (
            <div className="card" key={r.id}>
              <div style={{ color: "#f59f00" }}>{"★".repeat(r.score)}{"☆".repeat(5 - r.score)}</div>
              {r.comment && <div>{r.comment}</div>}
              <div className="muted">#{r.orderNumber} · {r.repartidor} · {hhmm(r.createdAt)}</div>
            </div>
          ))}
          {ratingsData.ratings.length === 0 && <p className="muted">{tr("noRatings")}</p>}
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 16, fontWeight: 700, fontSize: "1.15rem", borderLeft: "5px solid var(--accent)" }}>
            {tr(`status.${st}`)}
          </div>

          {st === "COMING_BACK" && (
            <button
              type="button"
              className="btn"
              style={{ height: 64, fontSize: "1.2rem", margin: "12px 0" }}
              onClick={async () => {
                try {
                  await staffFetch("/me/ready", "POST");
                  await refresh();
                } catch (err: any) {
                  showNotice(err.message);
                }
              }}
            >
              {tr("readyBtn")}
            </button>
          )}

          {st === "OFF" ? (
            <p className="muted" style={{ textAlign: "center", padding: 32 }}>{tr("noShift")}</p>
          ) : (
            <>
              <h2>{tr("myOrders")} ({orders.length}/4)</h2>
              {orders.length === 0 && <div className="card muted">{tr("noOrders")}</div>}
              {orders.map((o) => {
                const addr = formatAddress(o);
                return (
                  <div className="card" key={o.id}>
                    <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>
                      {tr("stop")} {o.stopNumber ?? 1} · #{o.number} · {o.clientName}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                      <span onClick={() => copyText(addr)} style={{ cursor: "pointer" }}>{addr}</span>
                      <button type="button" onClick={() => copyText(addr)} style={{ padding: "2px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer", fontSize: ".78rem" }}>📋 {tr("copy")}</button>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                      <span onClick={() => copyText(o.clientPhone)} style={{ cursor: "pointer" }}>Tel: {o.clientPhone}</span>
                      <button type="button" onClick={() => copyText(o.clientPhone)} style={{ padding: "2px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer", fontSize: ".78rem" }}>📋 {tr("copy")}</button>
                    </div>
                    <div style={{ fontWeight: 700, marginTop: 6 }}>
                      {tr("total")} {eur(o.total)} · {formatPayLine(o)}
                    </div>
                    {o.notes && <div className="muted" style={{ fontStyle: "italic", marginTop: 4 }}>{tr("notes")}: {o.notes}</div>}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                      <button type="button" onClick={() => openGoogleMaps(o)} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}>📍 {tr("map")}</button>
                      <a href={`tel:${o.clientPhone}`} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", textDecoration: "none" }}>📞 {tr("call")}</a>
                      <button type="button" onClick={() => setModal({ type: "editAddr", order: o, streetType: o.streetType, streetName: o.streetName, streetNumber: o.streetNumber, postalCode: o.postalCode, floor: o.floor || "", door: o.door || "" })} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)", cursor: "pointer" }}>✏️ {tr("edit")}</button>
                      <button
                        type="button"
                        onClick={() => setChatOpen({
                          title: `${tr("chatClient")} · #${o.number} ${o.clientName}`,
                          subtitle: "🔒 Chat privado Repartidor ↔ Cliente (el jefe no ve estos mensajes)",
                          endpoint: `/orders/${o.id}/messages`,
                          myRole: "REPARTIDOR",
                        })}
                        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent)", fontWeight: 600, cursor: "pointer" }}
                      >
                        💬 {tr("chatClient")}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      style={{ marginTop: 10 }}
                      onClick={() => setModal({ type: "confirmDelivered", order: o })}
                    >
                      {tr("delivered")}
                    </button>
                  </div>
                );
              })}

              {riderSummary && (
                <>
                  <h2>{tr("myShift")}</h2>
                  <div className="card">
                    <div>{tr("deliveries")}: <strong>{riderSummary.deliveries}</strong></div>
                    <div>{tr("cashCollected")}: <strong>{eur(riderSummary.cashCollected)}</strong></div>
                    <div>{tr("changeGiven")}: <strong>{eur(riderSummary.changeGiven)}</strong></div>
                    <div style={{ fontWeight: 700, marginTop: 4 }}>{tr("cashDue")}: {eur(riderSummary.cashDue)}</div>
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                      <strong>{tr("cardPayments")}: {cards.length}</strong>
                      {cards.map((c: any) => (
                        <div key={c.orderNumber} style={{ paddingLeft: 10, fontFamily: "monospace" }}>#{c.orderNumber} — {eur(c.amount)}</div>
                      ))}
                    </div>
                  </div>

                  <h2>{tr("history")} ({hist.length})</h2>
                  <div className="card">
                    {hist.length === 0 && <p className="muted" style={{ margin: 0 }}>{tr("noHistory")}</p>}
                    {hist.map((h: any) => (
                      <div key={h.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                        <strong>#{h.number} · {h.clientName} · {hhmm(h.deliveredAt)}</strong>
                        <div className="muted">{formatAddress(h)}</div>
                        <div>{tr("total")} {eur(h.total)} · {formatPayLine(h)}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {/* RIDER MODALS */}
      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 }}>
          <div className="card" style={{ maxWidth: 400, width: "100%", padding: 16 }}>
            {modal.type === "confirmDelivered" && (
              <>
                <strong>{tr("confirmTitle")}</strong>
                <p>{tr("confirmBody")} #{modal.order.number}?</p>
                {modal.order.paymentMethod === "CASH" && (
                  <div className="card" style={{ background: "var(--bg)" }}>
                    <strong>{tr("collect")}: {eur(modal.order.total)}</strong>
                    <div>{formatPayLine(modal.order)}</div>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>{tr("no")}</button>
                  <button
                    type="button"
                    className="btn"
                    style={{ flex: 1 }}
                    onClick={async () => {
                      try {
                        await staffFetch(`/orders/${modal.order.id}/delivered`, "POST");
                        setModal(null);
                        await refresh();
                      } catch (err: any) {
                        showNotice(err.message);
                      }
                    }}
                  >
                    {tr("yes")}
                  </button>
                </div>
              </>
            )}

            {modal.type === "editAddr" && (
              <>
                <strong>{tr("edit")} · #{modal.order.number}</strong>
                <label>{tr("streetType")}</label>
                <select value={modal.streetType} onChange={(e) => setModal({ ...modal, streetType: e.target.value })}>
                  {["calle", "avenida", "plaza", "paseo", "camino", "carretera"].map((v) => <option key={v}>{v}</option>)}
                </select>
                <label>{tr("streetName")}</label>
                <input value={modal.streetName} onChange={(e) => setModal({ ...modal, streetName: e.target.value })} />
                <div className="row3">
                  <div><label>{tr("streetNumber")}</label><input value={modal.streetNumber} onChange={(e) => setModal({ ...modal, streetNumber: e.target.value })} /></div>
                  <div><label>{tr("floorLbl")}</label><input value={modal.floor} onChange={(e) => setModal({ ...modal, floor: e.target.value })} /></div>
                  <div><label>{tr("doorLbl")}</label><input value={modal.door} onChange={(e) => setModal({ ...modal, door: e.target.value })} /></div>
                </div>
                <label>{tr("postalCode")}</label>
                <input maxLength={5} value={modal.postalCode} onChange={(e) => setModal({ ...modal, postalCode: e.target.value })} />
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => setModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--card)", color: "var(--text)" }}>{tr("no")}</button>
                  <button
                    type="button"
                    className="btn"
                    style={{ flex: 1 }}
                    onClick={async () => {
                      try {
                        await staffFetch(`/orders/${modal.order.id}/address`, "PATCH", {
                          streetType: modal.streetType,
                          streetName: modal.streetName.trim(),
                          streetNumber: modal.streetNumber.trim(),
                          postalCode: modal.postalCode.trim(),
                          floor: modal.floor.trim(),
                          door: modal.door.trim(),
                        });
                        setModal(null);
                        await refresh();
                      } catch (err: any) {
                        showNotice(err.message);
                      }
                    }}
                  >
                    {tr("save")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* CHAT MODAL */}
      {chatOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
          <div className="card" style={{ maxWidth: 420, width: "100%", padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
              <div>
                <strong>💬 {chatOpen.title}</strong>
                {chatOpen.subtitle && <div className="muted" style={{ fontSize: ".78rem" }}>{chatOpen.subtitle}</div>}
              </div>
              <button type="button" onClick={() => setChatOpen(null)} style={{ border: 0, background: "none", fontSize: "1.2rem", cursor: "pointer", color: "var(--text)" }}>✕</button>
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto", margin: "10px 0", display: "flex", flexDirection: "column", gap: 6 }}>
              {chatMsgs.length === 0 && <p className="muted" style={{ textAlign: "center" }}>{tr("chatEmpty")}</p>}
              {chatMsgs.map((m) => (
                <div
                  key={m.id}
                  style={{
                    alignSelf: m.senderRole === chatOpen.myRole ? "flex-end" : "flex-start",
                    background: m.senderRole === chatOpen.myRole ? "var(--accent)" : "var(--line)",
                    color: m.senderRole === chatOpen.myRole ? "#fff" : "var(--text)",
                    padding: "6px 10px",
                    borderRadius: 10,
                    maxWidth: "85%",
                  }}
                >
                  <div style={{ fontSize: ".75rem", opacity: 0.85, fontWeight: 600 }}>{m.senderName} · {hhmm(m.createdAt)}</div>
                  <div>{m.text}</div>
                </div>
              ))}
            </div>
            <form onSubmit={sendChatMessage} style={{ display: "flex", gap: 8 }}>
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder={tr("chatHint")} />
              <button type="submit" className="btn" style={{ width: "auto", padding: "8px 16px" }}>{tr("send")}</button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
