const ENV_API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3000";
export const SLUG = process.env.NEXT_PUBLIC_RESTAURANT_SLUG ?? "demo";

export function getApiBase(): string {
  if (typeof window !== "undefined" && window.location.hostname !== "localhost" && ENV_API.includes("localhost")) {
    return `http://${window.location.hostname}:3000`;
  }
  return ENV_API;
}

export const API = ENV_API;

export class ApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(getApiBase() + path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("NETWORK");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP_${res.status}`);
  return data as T;
}

export const errorText: Record<string, string> = {
  NETWORK: "No hay conexión con el servidor. Inténtalo de nuevo.",
  CLOSED: "Ahora mismo el restaurante está cerrado.",
  TOO_LATE: "Es demasiado tarde para que llegue antes del cierre.",
  OUT_OF_ZONE: "Tu dirección queda fuera de nuestra zona de reparto.",
  ADDRESS_NOT_FOUND: "No encontramos esa dirección. Revísala, por favor.",
  CASH_AMOUNT_REQUIRED: "Indica con cuánto vas a pagar en efectivo.",
  CASH_AMOUNT_TOO_LOW: "El importe con el que pagas es menor que el total.",
  PRODUCT_UNAVAILABLE: "Algún producto ya no está disponible. Recarga la página.",
  BELOW_MIN_ORDER: "No se alcanza el pedido mínimo.",
  VALIDATION: "Revisa los datos del formulario.",
  RESTAURANT_UNAVAILABLE: "El restaurante no está disponible.",
  NOT_FOUND: "No encontramos este pedido.",
  NOT_DELIVERED: "Podrás valorar el pedido cuando se entregue.",
  ALREADY_RATED: "Ya has valorado este pedido. ¡Gracias!",
  EMAIL_TAKEN: "Ya existe una cuenta con ese correo electrónico.",
  INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
};
export const msg = (e: unknown) => errorText[e instanceof ApiError ? e.code : "NETWORK"] ?? "Ha ocurrido un error.";

export const eur = (v: string | number) => `${Number(v).toFixed(2).replace(".", ",")} €`;

/** Plays a two-tone notification chime when a new message arrives. */
export function playMessageSound() {
  if (typeof window === "undefined") return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + i * 0.12);
      gain.gain.setValueAtTime(0.18, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.18);
    });
  } catch {
    /* ignore audio autoplay restrictions */
  }
}
