"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, EU_ALLERGENS, SLUG, eur, errorText, msg } from "@/lib/api";

type ModifierOption = {
  id: string;
  name: string;
  priceDelta: string;
  isAvailable: boolean;
};

type ModifierGroup = {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  options: ModifierOption[];
};

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: string;
  allergens?: string[];
  isCombo?: boolean;
  vatRate?: string;
  modifierGroups?: { sortOrder: number; modifierGroup: ModifierGroup }[];
};

type Category = { id: string; name: string; products: Product[] };
type Menu = {
  name: string;
  open: boolean;
  extraPrepMinutes?: number;
  hours: { weekday: number; openMin: number; closeMin: number }[];
  categories: Category[];
};

type CartItem = {
  key: string;
  productId: string;
  name: string;
  quantity: number;
  selectedOptionIds: string[];
  optionNames: string[];
  unitPrice: number;
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

const ALLERGEN_MAP = new Map(EU_ALLERGENS.map((a) => [a.code, a]));
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export default function Home() {
  const router = useRouter();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [loadError, setLoadError] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [f, setF] = useState({
    clientName: "", clientPhone: "", streetType: "calle", streetName: "", streetNumber: "",
    postalCode: "", floor: "", door: "", notes: "",
  });
  const [promoCode, setPromoCode] = useState("");
  const [pay, setPay] = useState<"CARD" | "CASH">("CARD");
  const [cash, setCash] = useState("");
  const [quote, setQuote] = useState<{
    kind: "idle" | "loading" | "ok" | "error";
    text: string;
    deliveryFee?: number;
    discountAmount?: number;
    minOrderAmount?: number;
  }>({ kind: "idle", text: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Modifier Modal
  const [modModal, setModModal] = useState<{
    product: Product;
    selectedByGroup: Record<string, string[]>;
    err: string;
  } | null>(null);

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
  const subtotal = cart.reduce((s, item) => s + item.unitPrice * item.quantity, 0);
  const count = cart.reduce((s, item) => s + item.quantity, 0);
  const deliveryFee = quote.kind === "ok" ? (quote.deliveryFee ?? 0) : 0;
  const discountAmount = quote.kind === "ok" ? (quote.discountAmount ?? 0) : 0;
  const total = Math.max(0, subtotal + deliveryFee - discountAmount);

  function addSimpleOrOpenModal(p: Product) {
    const groups = p.modifierGroups ?? [];
    if (groups.length === 0) {
      addCartLine(p, [], [], Number(p.price));
      return;
    }
    const initial: Record<string, string[]> = {};
    for (const pmg of groups) {
      const g = pmg.modifierGroup;
      if (g.minSelections > 0) {
        const avail = g.options.filter((o) => o.isAvailable);
        initial[g.id] = avail.slice(0, g.minSelections).map((o) => o.id);
      } else {
        initial[g.id] = [];
      }
    }
    setModModal({ product: p, selectedByGroup: initial, err: "" });
  }

  function addCartLine(p: Product, optionIds: string[], optionNames: string[], unitPrice: number) {
    const sortedKey = `${p.id}::${[...optionIds].sort().join(",")}`;
    setCart((prev) => {
      const existing = prev.find((c) => c.key === sortedKey);
      if (existing) {
        return prev.map((c) => (c.key === sortedKey ? { ...c, quantity: Math.min(50, c.quantity + 1) } : c));
      }
      return [
        ...prev,
        {
          key: sortedKey,
          productId: p.id,
          name: p.name,
          quantity: 1,
          selectedOptionIds: optionIds,
          optionNames,
          unitPrice,
        },
      ];
    });
  }

  function changeCartQty(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((c) => (c.key === key ? { ...c, quantity: c.quantity + delta } : c))
        .filter((c) => c.quantity > 0)
    );
  }

  function confirmModifierModal() {
    if (!modModal) return;
    const { product, selectedByGroup } = modModal;
    const groups = product.modifierGroups ?? [];
    const chosenIds: string[] = [];
    const chosenNames: string[] = [];
    let delta = 0;

    for (const pmg of groups) {
      const g = pmg.modifierGroup;
      const sel = selectedByGroup[g.id] ?? [];
      if (sel.length < g.minSelections || sel.length > g.maxSelections) {
        setModModal({
          ...modModal,
          err: `Selecciona entre ${g.minSelections} y ${g.maxSelections} opciones en "${g.name}".`,
        });
        return;
      }
      for (const optId of sel) {
        const opt = g.options.find((o) => o.id === optId);
        if (opt) {
          chosenIds.push(opt.id);
          chosenNames.push(Number(opt.priceDelta) > 0 ? `${opt.name} (+${eur(opt.priceDelta)})` : opt.name);
          delta += Number(opt.priceDelta);
        }
      }
    }
    addCartLine(product, chosenIds, chosenNames, Number(product.price) + delta);
    setModModal(null);
  }

  // Estimated time + zone + promo pre-check
  useEffect(() => {
    if (!f.streetName.trim() || !f.streetNumber.trim() || !/^\d{5}$/.test(f.postalCode)) {
      setQuote({ kind: "idle", text: "" });
      return;
    }
    let cancelled = false;
    setQuote({ kind: "loading", text: "Calculando tiempo de entrega…" });
    const t = setTimeout(() => {
      api<{
        etaMinutes: number;
        extraPrepMinutes?: number;
        deliveryFee: number;
        minOrderAmount: number;
        discountAmount: number;
      }>(`/public/${SLUG}/quote`, {
        method: "POST",
        body: JSON.stringify({
          streetType: f.streetType,
          streetName: f.streetName.trim(),
          streetNumber: f.streetNumber.trim(),
          postalCode: f.postalCode,
          ...(subtotal > 0 ? { subtotal } : {}),
          ...(promoCode.trim() ? { promoCode: promoCode.trim() } : {}),
        }),
      })
        .then((r) => {
          if (cancelled) return;
          const parts = [`Tiempo estimado: unos ${r.etaMinutes} min`];
          if (r.extraPrepMinutes && r.extraPrepMinutes > 0) parts.push(`(+${r.extraPrepMinutes} min hora punta)`);
          if (r.deliveryFee > 0) parts.push(`· Envío ${eur(r.deliveryFee)}`);
          if (r.discountAmount > 0) parts.push(`· Descuento -${eur(r.discountAmount)}`);
          setQuote({
            kind: "ok",
            text: parts.join(" "),
            deliveryFee: r.deliveryFee,
            discountAmount: r.discountAmount,
            minOrderAmount: r.minOrderAmount,
          });
        })
        .catch((e) => !cancelled && setQuote({ kind: "error", text: msg(e) }));
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.streetType, f.streetName, f.streetNumber, f.postalCode, subtotal, promoCode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const cashNum = Number(cash.replace(",", "."));
    if (cart.length === 0) return setError("Añade al menos un producto.");
    if (pay === "CASH" && (!cashNum || cashNum < total)) return setError(errorText.CASH_AMOUNT_TOO_LOW);
    setBusy(true);
    try {
      const r = await api<{ trackingToken: string }>(`/public/${SLUG}/orders`, {
        method: "POST",
        headers: clientToken ? { Authorization: `Bearer ${clientToken}` } : undefined,
        body: JSON.stringify({
          clientName: f.clientName.trim(),
          clientPhone: f.clientPhone.trim(),
          streetType: f.streetType,
          streetName: f.streetName.trim(),
          streetNumber: f.streetNumber.trim(),
          postalCode: f.postalCode,
          ...(f.floor.trim() && { floor: f.floor.trim() }),
          ...(f.door.trim() && { door: f.door.trim() }),
          ...(f.notes.trim() && { notes: f.notes.trim() }),
          ...(promoCode.trim() && { promoCode: promoCode.trim() }),
          paymentMethod: pay,
          ...(pay === "CASH" && { cashAmount: cashNum }),
          items: cart.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            ...(item.selectedOptionIds.length > 0 && {
              selectedModifiers: item.selectedOptionIds.map((modifierOptionId) => ({ modifierOptionId })),
            }),
          })),
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
      <p className="muted" style={{ marginTop: 0 }}>
        Reparto a domicilio{h ? ` · de ${hhmm(h.openMin)} a ${hhmm(h.closeMin)}` : ""}
        {menu.extraPrepMinutes && menu.extraPrepMinutes > 0 ? ` · ⏳ Hora punta (+${menu.extraPrepMinutes} min)` : ""}
      </p>

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
                            const nextCart: CartItem[] = [];
                            o.items.forEach((i) => {
                              const p = products.get(i.productId);
                              if (p && (p.modifierGroups ?? []).length === 0) {
                                nextCart.push({
                                  key: `${i.productId}::`,
                                  productId: i.productId,
                                  name: i.name,
                                  quantity: i.quantity,
                                  selectedOptionIds: [],
                                  optionNames: [],
                                  unitPrice: Number(p.price),
                                });
                              }
                            });
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
          {c.products.map((p) => {
            const qtyInCart = cart.filter((ci) => ci.productId === p.id).reduce((s, ci) => s + ci.quantity, 0);
            const hasMods = (p.modifierGroups ?? []).length > 0;
            return (
              <div className="card product" key={p.id}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <strong>{p.name}</strong> · {eur(p.price)}
                    {p.isCombo && (
                      <span style={{ fontSize: ".7rem", fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: "var(--accent)", color: "var(--accent-text)" }}>
                        COMBO
                      </span>
                    )}
                    {hasMods && (
                      <span className="muted" style={{ fontSize: ".75rem" }}>· Personalizable</span>
                    )}
                  </div>
                  {p.description && <p>{p.description}</p>}
                  {(p.allergens ?? []).length > 0 && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      {(p.allergens ?? []).map((code) => {
                        const a = ALLERGEN_MAP.get(code);
                        return (
                          <span key={code} style={{ fontSize: ".72rem", padding: "1px 6px", borderRadius: 6, border: "1px solid var(--line)", color: "var(--muted)" }}>
                            {a ? `${a.icon} ${a.label}` : code}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="qty">
                  {!hasMods && qtyInCart > 0 && (
                    <>
                      <button type="button" className="minus" aria-label={`Quitar ${p.name}`} onClick={() => changeCartQty(`${p.id}::`, -1)}>−</button>
                      <span>{qtyInCart}</span>
                    </>
                  )}
                  {hasMods && qtyInCart > 0 && <span>{qtyInCart}</span>}
                  <button type="button" aria-label={`Añadir ${p.name}`} onClick={() => addSimpleOrOpenModal(p)}>+</button>
                </div>
              </div>
            );
          })}
        </section>
      ))}

      {/* CART SUMMARY */}
      {cart.length > 0 && (
        <section>
          <h2>Tu carrito</h2>
          <div className="card">
            {cart.map((item) => (
              <div key={item.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                <div>
                  <strong>{item.quantity}× {item.name}</strong> · {eur(item.unitPrice * item.quantity)}
                  {item.optionNames.length > 0 && (
                    <div className="muted" style={{ fontSize: ".82rem" }}>{item.optionNames.join(", ")}</div>
                  )}
                </div>
                <div className="qty">
                  <button type="button" className="minus" onClick={() => changeCartQty(item.key, -1)}>−</button>
                  <span>{item.quantity}</span>
                  <button type="button" onClick={() => changeCartQty(item.key, 1)}>+</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

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
          <label htmlFor="promo">Código promocional (opcional)</label>
          <input id="promo" value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} placeholder="Ej.: BIENVENIDA" />
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

      {/* MODIFIER SELECTOR MODAL */}
      {modModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
          <div className="card" style={{ maxWidth: 460, width: "100%", maxHeight: "85vh", overflowY: "auto", padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
              <strong>{modModal.product.name} · {eur(modModal.product.price)}</strong>
              <button type="button" onClick={() => setModModal(null)} style={{ border: 0, background: "none", fontSize: "1.2rem", cursor: "pointer", color: "var(--text)" }}>✕</button>
            </div>
            {(modModal.product.modifierGroups ?? []).map((pmg, idx) => {
              const g = pmg.modifierGroup;
              const sel = modModal.selectedByGroup[g.id] ?? [];
              const isRadio = g.maxSelections === 1;
              return (
                <div key={g.id} style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    {modModal.product.isCombo ? `Paso ${idx + 1}: ` : ""}{g.name}{" "}
                    <span className="muted" style={{ fontSize: ".8rem", fontWeight: 400 }}>
                      ({g.minSelections > 0 ? `Obligatorio · mín. ${g.minSelections}` : "Opcional"}, máx. {g.maxSelections})
                    </span>
                  </div>
                  {g.options.map((opt) => {
                    const checked = sel.includes(opt.id);
                    return (
                      <label
                        key={opt.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 10px",
                          border: "1px solid var(--line)",
                          borderRadius: 8,
                          margin: "4px 0",
                          opacity: opt.isAvailable ? 1 : 0.45,
                          color: "var(--text)",
                        }}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type={isRadio ? "radio" : "checkbox"}
                            disabled={!opt.isAvailable}
                            checked={checked}
                            style={{ width: "auto" }}
                            onChange={() => {
                              setModModal((prev) => {
                                if (!prev) return null;
                                const cur = prev.selectedByGroup[g.id] ?? [];
                                let next: string[];
                                if (isRadio) {
                                  next = [opt.id];
                                } else if (cur.includes(opt.id)) {
                                  next = cur.filter((x) => x !== opt.id);
                                } else {
                                  if (cur.length >= g.maxSelections) return prev;
                                  next = [...cur, opt.id];
                                }
                                return { ...prev, err: "", selectedByGroup: { ...prev.selectedByGroup, [g.id]: next } };
                              });
                            }}
                          />
                          {opt.name} {!opt.isAvailable ? "(Agotado)" : ""}
                        </span>
                        <span>{Number(opt.priceDelta) > 0 ? `+${eur(opt.priceDelta)}` : "Incluido"}</span>
                      </label>
                    );
                  })}
                </div>
              );
            })}
            {modModal.err && <div className="banner error">{modModal.err}</div>}
            <button type="button" className="btn" style={{ marginTop: 14 }} onClick={confirmModifierModal}>
              Añadir al carrito
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
