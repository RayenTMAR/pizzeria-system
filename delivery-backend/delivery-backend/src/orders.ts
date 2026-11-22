import { Prisma, PaymentMethod, OrderSource } from "@prisma/client";
import { createHash } from "crypto";
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
  promoCode: z.string().max(40).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(50),
        note: z.string().max(200).optional(),
        selectedModifiers: z
          .array(z.object({ modifierOptionId: z.string().uuid() }))
          .optional(),
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

export async function resolveZoneAndPromo(
  restaurantId: string,
  km: number,
  subtotal: Prisma.Decimal,
  settings: { maxRadiusKm: number; minOrder: Prisma.Decimal | null; deliveryFee: Prisma.Decimal },
  promoCodeStr?: string,
  enforceMinOrder = true
) {
  const zones = await prisma.deliveryZone.findMany({
    where: { restaurantId, isActive: true },
    orderBy: { minKm: "asc" },
  });

  let deliveryFee = settings.deliveryFee;
  let minOrderAmount: Prisma.Decimal | null = settings.minOrder;

  if (zones.length > 0) {
    const zone = zones.find((z) => km >= z.minKm && km <= z.maxKm);
    if (!zone) throw new OrderError("OUT_OF_ZONE");
    deliveryFee = zone.deliveryFee;
    minOrderAmount = zone.minOrderAmount;
  } else {
    if (km > settings.maxRadiusKm) throw new OrderError("OUT_OF_ZONE");
  }

  if (enforceMinOrder && minOrderAmount && minOrderAmount.gt(0) && subtotal.lt(minOrderAmount)) {
    throw new OrderError("BELOW_MIN_ORDER");
  }

  let discountAmount = new Prisma.Decimal(0);
  let appliedPromo: { id: string; code: string } | null = null;
  if (promoCodeStr && promoCodeStr.trim()) {
    const code = promoCodeStr.trim().toUpperCase();
    const promo = await prisma.promoCode.findUnique({
      where: { restaurantId_code: { restaurantId, code } },
    });
    if (!promo || !promo.isActive) throw new OrderError("INVALID_PROMO");
    if (promo.expiresAt && promo.expiresAt < new Date()) throw new OrderError("PROMO_EXPIRED");
    if (promo.maxUses !== null && promo.usedCount >= promo.maxUses)
      throw new OrderError("PROMO_LIMIT_REACHED");
    if (enforceMinOrder && subtotal.lt(promo.minOrderAmount))
      throw new OrderError("PROMO_MIN_ORDER");

    if (promo.discountType === "PERCENTAGE") {
      discountAmount = subtotal.mul(promo.discountValue).div(100);
    } else {
      discountAmount = promo.discountValue;
    }
    if (discountAmount.gt(subtotal)) discountAmount = subtotal;
    discountAmount = new Prisma.Decimal(discountAmount.toFixed(2));
    appliedPromo = { id: promo.id, code: promo.code };
  }

  return { deliveryFee, minOrderAmount, discountAmount, appliedPromo };
}

function buildVatBreakdown(
  grossByRate: Map<number, number>,
  totalGross: number
): {
  netAmount: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  vatBreakdown: { rate: number; base: number; quota: number }[];
} {
  const sumRaw = [...grossByRate.values()].reduce((a, b) => a + b, 0);
  const scale = sumRaw > 0 ? totalGross / sumRaw : 1;

  const breakdown: { rate: number; base: number; quota: number }[] = [];
  let totalBase = 0;
  let totalQuota = 0;

  for (const [rate, rawGross] of grossByRate.entries()) {
    const scaledGross = rawGross * scale;
    const base = Number((scaledGross / (1 + rate / 100)).toFixed(2));
    const quota = Number((scaledGross - base).toFixed(2));
    breakdown.push({ rate, base, quota });
    totalBase += base;
    totalQuota += quota;
  }

  const netRounded = Number(totalBase.toFixed(2));
  const vatRounded = Number((totalGross - netRounded).toFixed(2));
  if (breakdown.length > 0 && Math.abs(totalBase + totalQuota - totalGross) > 0.001) {
    const diff = Number((totalGross - (totalBase + totalQuota)).toFixed(2));
    breakdown[0].quota = Number((breakdown[0].quota + diff).toFixed(2));
  }

  return {
    netAmount: new Prisma.Decimal(netRounded.toFixed(2)),
    vatAmount: new Prisma.Decimal(vatRounded.toFixed(2)),
    vatBreakdown: breakdown,
  };
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

  // Products + modifier groups + prices (all validated & calculated server-side)
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, restaurantId, available: true },
    include: {
      modifierGroups: {
        orderBy: { sortOrder: "asc" },
        include: {
          modifierGroup: {
            include: { options: { orderBy: { sortOrder: "asc" } } },
          },
        },
      },
    },
  });
  if (products.length !== ids.length) throw new OrderError("PRODUCT_UNAVAILABLE");
  const byId = new Map(products.map((p) => [p.id, p]));

  const preparedItems: {
    productId: string;
    name: string;
    unitPrice: Prisma.Decimal;
    vatRate: Prisma.Decimal;
    quantity: number;
    note?: string;
    modifiers: { groupName: string; optionName: string; priceDelta: Prisma.Decimal }[];
  }[] = [];

  let subtotal = new Prisma.Decimal(0);
  const grossByRate = new Map<number, number>();

  for (const i of input.items) {
    const prod = byId.get(i.productId)!;
    const selectedIds = (i.selectedModifiers ?? []).map((m) => m.modifierOptionId);
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new OrderError("INVALID_MODIFIERS");
    }

    const optionLookup = new Map<
      string,
      { groupId: string; groupName: string; optionName: string; priceDelta: Prisma.Decimal; isAvailable: boolean }
    >();
    for (const pmg of prod.modifierGroups) {
      const g = pmg.modifierGroup;
      for (const opt of g.options) {
        optionLookup.set(opt.id, {
          groupId: g.id,
          groupName: g.name,
          optionName: opt.name,
          priceDelta: opt.priceDelta,
          isAvailable: opt.isAvailable,
        });
      }
    }

    const countByGroup = new Map<string, number>();
    const chosenMods: { groupName: string; optionName: string; priceDelta: Prisma.Decimal }[] = [];
    let modDeltaSum = new Prisma.Decimal(0);

    for (const optId of selectedIds) {
      const found = optionLookup.get(optId);
      if (!found) throw new OrderError("INVALID_MODIFIERS");
      if (!found.isAvailable) throw new OrderError("MODIFIER_UNAVAILABLE");
      countByGroup.set(found.groupId, (countByGroup.get(found.groupId) ?? 0) + 1);
      chosenMods.push({
        groupName: found.groupName,
        optionName: found.optionName,
        priceDelta: found.priceDelta,
      });
      modDeltaSum = modDeltaSum.add(found.priceDelta);
    }

    for (const pmg of prod.modifierGroups) {
      const g = pmg.modifierGroup;
      const cnt = countByGroup.get(g.id) ?? 0;
      if (cnt < g.minSelections || cnt > g.maxSelections) {
        throw new OrderError("INVALID_MODIFIERS");
      }
    }

    const unitPrice = prod.price.add(modDeltaSum);
    const lineGross = unitPrice.mul(i.quantity);
    subtotal = subtotal.add(lineGross);

    const rateNum = Number(prod.vatRate);
    grossByRate.set(rateNum, (grossByRate.get(rateNum) ?? 0) + Number(lineGross));

    preparedItems.push({
      productId: i.productId,
      name: prod.name,
      unitPrice,
      vatRate: prod.vatRate,
      quantity: i.quantity,
      note: i.note,
      modifiers: chosenMods,
    });
  }

  // Road distance and time -> tiered zone & promo check -> opening hours / closing cutoff
  const route = await routeFor(s, input);
  const { deliveryFee, discountAmount, appliedPromo } = await resolveZoneAndPromo(
    restaurantId,
    route.km,
    subtotal,
    s,
    input.promoCode,
    true
  );

  if (deliveryFee.gt(0)) {
    const defRate = Number(restaurant.defaultVatRate);
    grossByRate.set(defRate, (grossByRate.get(defRate) ?? 0) + Number(deliveryFee));
  }

  const total = subtotal.add(deliveryFee).sub(discountAmount);
  const etaMinutes = route.minutes + s.dropoffBufferMinutes + restaurant.extraPrepMinutes;

  if (enforceRules) {
    const t = checkOrderTiming({
      now: new Date(),
      timezone: restaurant.timezone,
      hours: restaurant.hours,
      prepMinutes: s.prepMinutes + restaurant.extraPrepMinutes,
      etaMinutes: route.minutes + s.dropoffBufferMinutes,
      graceMinutesAfterClose: s.graceMinutesAfterClose,
    });
    if (!t.ok) throw new OrderError(t.reason);
  }

  if (input.paymentMethod === "CASH") {
    if (enforceRules && input.cashAmount === undefined) throw new OrderError("CASH_AMOUNT_REQUIRED");
    if (input.cashAmount !== undefined && total.gt(input.cashAmount))
      throw new OrderError("CASH_AMOUNT_TOO_LOW");
  }

  const { netAmount, vatAmount, vatBreakdown } = buildVatBreakdown(grossByRate, Number(total));

  const order = await prisma.$transaction(async (tx) => {
    const prev = await tx.order.findFirst({
      where: { restaurantId },
      orderBy: { number: "desc" },
      select: { number: true, fiscalHash: true },
    });
    const nextNumber = (prev?.number ?? 0) + 1;
    const createdAt = new Date();
    const invoiceNumber = `${createdAt.getFullYear()}-${String(nextNumber).padStart(6, "0")}`;
    const previousInvoiceHash = prev?.fiscalHash ?? "GENESIS";
    const fiscalHash = createHash("sha256")
      .update([restaurant.nifCif, invoiceNumber, createdAt.toISOString(), total.toFixed(2), previousInvoiceHash].join("|"))
      .digest("hex");

    if (appliedPromo) {
      await tx.promoCode.update({
        where: { id: appliedPromo.id },
        data: { usedCount: { increment: 1 } },
      });
    }

    return tx.order.create({
      data: {
        restaurantId,
        clientId,
        number: nextNumber,
        createdAt,
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
        destLat: route.lat ?? null,
        destLng: route.lng ?? null,
        total,
        deliveryFee,
        discountAmount,
        promoCode: appliedPromo?.code ?? null,
        invoiceNumber,
        netAmount,
        vatAmount,
        vatBreakdown,
        fiscalHash,
        previousInvoiceHash,
        paymentMethod: input.paymentMethod,
        cashAmount: input.paymentMethod === "CASH" ? input.cashAmount : undefined,
        items: {
          create: preparedItems.map((it) => ({
            productId: it.productId,
            name: it.name,
            unitPrice: it.unitPrice,
            vatRate: it.vatRate,
            quantity: it.quantity,
            note: it.note,
            modifiers: it.modifiers.length ? { create: it.modifiers } : undefined,
          })),
        },
        events: { create: { type: "CREATED", actorId, data: { source } } },
      },
      include: { items: { include: { modifiers: true } } },
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
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
  const merged = { ...order, ...patch };
  let distanceKm = order.distanceKm;
  let etaMinutes = order.etaMinutes;
  let destLat = order.destLat;
  let destLng = order.destLng;
  try {
    const r = await roadRoute(settings, addressString(merged, settings.city));
    distanceKm = r.km;
    etaMinutes = r.minutes + settings.dropoffBufferMinutes + restaurant.extraPrepMinutes;
    if (r.lat != null && r.lng != null) {
      destLat = r.lat;
      destLng = r.lng;
    }
  } catch {
    /* keep the previous estimate if the lookup fails */
  }
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { ...patch, distanceKm, etaMinutes, destLat, destLng },
  });
  await logEvent(orderId, "ADDRESS_EDITED", actorId, patch as Prisma.InputJsonValue);
  return updated;
}

/**
 * Pre-check shown on the website before ordering: is the address inside the zone,
 * is the restaurant open, can it still arrive before closing? Returns the estimated
 * minutes (preparation + extraPrep + road time + drop-off), deliveryFee, minOrder, and discount.
 */
export async function quoteAddress(
  restaurantId: string,
  a: Parameters<typeof addressString>[0],
  opts?: { subtotal?: number; promoCode?: string }
) {
  const r = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: { settings: true, hours: true },
  });
  if (!r || !r.active || !r.settings) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const s = r.settings;
  const route = await routeFor(s, a);

  const subtotalDec = new Prisma.Decimal(opts?.subtotal ?? 0);
  const enforceMin = opts?.subtotal !== undefined && opts.subtotal > 0;
  const { deliveryFee, minOrderAmount, discountAmount, appliedPromo } = await resolveZoneAndPromo(
    restaurantId,
    route.km,
    subtotalDec,
    s,
    opts?.promoCode,
    enforceMin
  );

  const eta = route.minutes + s.dropoffBufferMinutes;
  const t = checkOrderTiming({
    now: new Date(),
    timezone: r.timezone,
    hours: r.hours,
    prepMinutes: s.prepMinutes + r.extraPrepMinutes,
    etaMinutes: eta,
    graceMinutesAfterClose: s.graceMinutesAfterClose,
  });
  if (!t.ok) throw new OrderError(t.reason);

  return {
    etaMinutes: eta + s.prepMinutes + r.extraPrepMinutes,
    extraPrepMinutes: r.extraPrepMinutes,
    distanceKm: route.km,
    deliveryFee: Number(deliveryFee),
    minOrderAmount: minOrderAmount ? Number(minOrderAmount) : 0,
    discountAmount: Number(discountAmount),
    promoCode: appliedPromo?.code ?? null,
  };
}
