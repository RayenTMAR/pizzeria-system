import { Prisma, PaymentMethod, OrderSource } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";
import { roadRoute } from "./maps";
import { checkOrderTiming } from "./rules";
import { pushToJefes } from "./push";

export class OrderError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

export const addressFields = {
  streetType: z.string().min(1), // calle, avenida...
  streetName: z.string().min(1),
  streetNumber: z.string().min(1),
  postalCode: z.string().regex(/^\d{5}$/),
  floor: z.string().optional(),
  door: z.string().optional(),
};

export const orderInput = z.object({
  clientName: z.string().min(1),
  clientPhone: z.string().min(6),
  ...addressFields,
  notes: z.string().max(500).optional(),
  paymentMethod: z.nativeEnum(PaymentMethod),
  cashAmount: z.number().positive().optional(), // what the client will pay with
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50),
        note: z.string().max(200).optional(),
      })
    )
    .min(1),
});
export type OrderInput = z.infer<typeof orderInput>;

export const addressString = (
  a: { streetType: string; streetName: string; streetNumber: string; postalCode: string },
  city: string
) => `${a.streetType} ${a.streetName} ${a.streetNumber}, ${a.postalCode} ${city}, España`;

export const logEvent = (
  orderId: string,
  type: string,
  actorId?: string,
  data?: Prisma.InputJsonValue
) => prisma.orderEvent.create({ data: { orderId, type, actorId, data } });

async function routeFor(
  settings: { lat: number; lng: number; city: string },
  a: Parameters<typeof addressString>[0]
) {
  try {
    return await roadRoute(settings, addressString(a, settings.city));
  } catch {
    throw new OrderError("ADDRESS_NOT_FOUND");
  }
}

/**
 * Creates an order that is auto-accepted (status IN_KITCHEN, waiting to print).
 * `enforceRules` = true for the website (hours, cutoff, cash amount required);
 * the jefe's manual orders skip the timing rules but still get the zone check.
 */
export async function createOrder(
  restaurantId: string,
  input: OrderInput,
  source: OrderSource,
  enforceRules: boolean,
  actorId?: string,
  clientId?: string
) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: { settings: true, hours: true },
  });
  if (!restaurant || !restaurant.active || !restaurant.settings)
    throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const s = restaurant.settings;

  // Products and total (prices are snapshotted on the order)
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, restaurantId, available: true },
  });
  if (products.length !== ids.length) throw new OrderError("PRODUCT_UNAVAILABLE");
  const byId = new Map(products.map((p) => [p.id, p]));
  let subtotal = new Prisma.Decimal(0);
  for (const i of input.items)
    subtotal = subtotal.add(byId.get(i.productId)!.price.mul(i.quantity));
  if (s.minOrder && subtotal.lt(s.minOrder)) throw new OrderError("BELOW_MIN_ORDER");
  const total = subtotal.add(s.deliveryFee);

  if (input.paymentMethod === "CASH") {
    if (enforceRules && input.cashAmount === undefined) throw new OrderError("CASH_AMOUNT_REQUIRED");
    if (input.cashAmount !== undefined && total.gt(input.cashAmount))
      throw new OrderError("CASH_AMOUNT_TOO_LOW");
  }

  // Road distance and time -> zone check -> opening hours / closing cutoff
  const route = await routeFor(s, input);
  if (route.km > s.maxRadiusKm) throw new OrderError("OUT_OF_ZONE");
  const etaMinutes = route.minutes + s.dropoffBufferMinutes;
  if (enforceRules) {
    const t = checkOrderTiming({
      now: new Date(),
      timezone: restaurant.timezone,
      hours: restaurant.hours,
      prepMinutes: s.prepMinutes,
      etaMinutes,
      graceMinutesAfterClose: s.graceMinutesAfterClose,
    });
    if (!t.ok) throw new OrderError(t.reason);
  }

  const order = await prisma.$transaction(async (tx) => {
    const last = await tx.order.aggregate({ where: { restaurantId }, _max: { number: true } });
    return tx.order.create({
      data: {
        restaurantId,
        clientId,
        number: (last._max.number ?? 0) + 1,
        source,
        clientName: input.clientName,
        clientPhone: input.clientPhone,
        streetType: input.streetType,
        streetName: input.streetName,
        streetNumber: input.streetNumber,
        postalCode: input.postalCode,
        floor: input.floor,
        door: input.door,
        notes: input.notes,
        distanceKm: route.km,
        etaMinutes,
        total,
        paymentMethod: input.paymentMethod,
        cashAmount: input.paymentMethod === "CASH" ? input.cashAmount : undefined,
        items: {
          create: input.items.map((i) => ({
            productId: i.productId,
            name: byId.get(i.productId)!.name,
            unitPrice: byId.get(i.productId)!.price,
            quantity: i.quantity,
            note: i.note,
          })),
        },
        events: { create: { type: "CREATED", actorId, data: { source } } },
      },
      include: { items: true },
    });
  });
  // Push to the jefe's phone (the ticket also prints automatically, nothing waits on this)
  pushToJefes(restaurantId, () => ({
    title: `Nuevo pedido #${order.number}`,
    body: `${order.clientName} · ${Number(order.total).toFixed(2)} €`,
    data: { type: "NEW_ORDER", orderId: order.id },
  })).catch((e) => console.error("push failed", e));
  return order;
}

/** Re-calculates distance/time after a rider or jefe edits the address. */
export async function updateAddress(
  restaurantId: string,
  orderId: string,
  patch: Partial<Record<keyof typeof addressFields, string>>,
  actorId: string
) {
  const order = await prisma.order.findFirst({ where: { id: orderId, restaurantId } });
  if (!order) throw new OrderError("NOT_FOUND", 404);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { restaurantId } });
  const merged = { ...order, ...patch };
  let distanceKm = order.distanceKm;
  let etaMinutes = order.etaMinutes;
  try {
    const r = await roadRoute(settings, addressString(merged, settings.city));
    distanceKm = r.km;
    etaMinutes = r.minutes + settings.dropoffBufferMinutes;
  } catch {
    /* keep the previous estimate if the lookup fails */
  }
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { ...patch, distanceKm, etaMinutes },
  });
  await logEvent(orderId, "ADDRESS_EDITED", actorId, patch as Prisma.InputJsonValue);
  return updated;
}

/**
 * Pre-check shown on the website before ordering: is the address inside the zone,
 * is the restaurant open, can it still arrive before closing? Returns the estimated
 * minutes (preparation + road time + drop-off) or throws an OrderError with the reason.
 */
export async function quoteAddress(restaurantId: string, a: Parameters<typeof addressString>[0]) {
  const r = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: { settings: true, hours: true },
  });
  if (!r || !r.active || !r.settings) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const s = r.settings;
  const route = await routeFor(s, a);
  if (route.km > s.maxRadiusKm) throw new OrderError("OUT_OF_ZONE");
  const eta = route.minutes + s.dropoffBufferMinutes;
  const t = checkOrderTiming({
    now: new Date(),
    timezone: r.timezone,
    hours: r.hours,
    prepMinutes: s.prepMinutes,
    etaMinutes: eta,
    graceMinutesAfterClose: s.graceMinutesAfterClose,
  });
  if (!t.ok) throw new OrderError(t.reason);
  return { etaMinutes: eta + s.prepMinutes };
}
