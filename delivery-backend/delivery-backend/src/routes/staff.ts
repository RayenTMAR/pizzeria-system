import { Router, Request } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireRole, signToken } from "../auth";
import {
  createOrder,
  orderInput,
  OrderError,
  logEvent,
  updateAddress,
  addressFields,
  addressString,
} from "../orders";
import { optimizeMultiStopRoute } from "../maps";
import { workingDayStart, localParts } from "../rules";
import { pushToUsers, pushToJefes } from "../push";

export const staff = Router();
const MAX_PER_TRIP = 4;
const rid = (req: Request) => req.user!.restaurantId;
const param = (req: Request, k: string) => String(req.params[k]);

// ---------- Login ----------
staff.post("/auth/login", async (req, res) => {
  const { email, password } = z
    .object({ email: z.string().email(), password: z.string() })
    .parse(req.body);
  const u = await prisma.user.findUnique({ where: { email } });
  if (!u || !u.active || !u.restaurantId || !(await bcrypt.compare(password, u.passwordHash)))
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  res.json({
    token: signToken({ id: u.id, role: u.role, restaurantId: u.restaurantId }),
    role: u.role,
    name: u.name,
    language: u.language,
  });
});

// ---------- Helpers ----------
async function getOrder(req: Request, id: string) {
  const o = await prisma.order.findFirst({ where: { id, restaurantId: rid(req) } });
  if (!o) throw new OrderError("NOT_FOUND", 404);
  return o;
}

const activeCount = (userId: string, restaurantId: string, excludeOrderId?: string) =>
  prisma.order.count({
    where: {
      restaurantId,
      repartidorId: userId,
      status: "ON_THE_WAY",
      ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
    },
  });

const openShift = (userId: string, restaurantId: string) =>
  prisma.shift.findFirst({ where: { userId, restaurantId, endedAt: null } });

/** When a rider has no orders left on his trip he is "coming back". */
async function refreshRider(userId: string, restaurantId: string) {
  const shift = await openShift(userId, restaurantId);
  if (!shift || shift.availableSince) return;
  if ((await activeCount(userId, restaurantId)) === 0)
    await prisma.shift.update({ where: { id: shift.id }, data: { comingBack: true } });
}

const riderStatus = (shift: { comingBack: boolean }, active: number) =>
  active > 0 ? "DELIVERING" : shift.comingBack ? "COMING_BACK" : "AVAILABLE";

/** Optimizes stopNumber (1..N) across a rider's active ON_THE_WAY orders. */
async function optimizeRiderStops(restaurantId: string, repartidorId: string): Promise<string[]> {
  const active = await prisma.order.findMany({
    where: { restaurantId, repartidorId, status: "ON_THE_WAY" },
    orderBy: [{ stopNumber: "asc" }, { createdAt: "asc" }],
  });
  if (active.length < 2) return active.map((o) => o.id);
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { restaurantId } });
  const orderedIds = await optimizeMultiStopRoute(
    { lat: settings.lat, lng: settings.lng },
    active.map((o) => ({
      id: o.id,
      address: addressString(o, settings.city),
      lat: o.destLat,
      lng: o.destLng,
    }))
  );
  await prisma.$transaction(
    orderedIds.map((id, idx) =>
      prisma.order.update({ where: { id }, data: { stopNumber: idx + 1 } })
    )
  );
  return orderedIds;
}

// ---------- Orders ----------
/** Today's orders (day resets at dayResetHour). Riders only see their own active trip. */
staff.get("/orders", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const u = req.user!;
  const r = await prisma.restaurant.findUniqueOrThrow({
    where: { id: u.restaurantId },
    include: { settings: true },
  });

  // CloudPRNT unprinted job watchdog (> 60 seconds in IN_KITCHEN without printing)
  if (u.role === "JEFE") {
    const cutoff = new Date(Date.now() - 60_000);
    const staleUnprinted = await prisma.order.findMany({
      where: {
        restaurantId: u.restaurantId,
        status: "IN_KITCHEN",
        printedAt: null,
        printFailed: false,
        createdAt: { lt: cutoff },
      },
      select: { id: true, number: true },
    });
    if (staleUnprinted.length > 0) {
      await prisma.order.updateMany({
        where: { id: { in: staleUnprinted.map((o) => o.id) } },
        data: { printFailed: true },
      });
      pushToJefes(u.restaurantId, () => ({
        title: "¡Alerta de impresora!",
        body: `Pedido(s) #${staleUnprinted.map((o) => o.number).join(", #")} sin imprimir`,
        data: { type: "PRINT_FAILED" },
      })).catch(() => {});
    }
  }

  const from = workingDayStart(new Date(), r.timezone, r.settings?.dayResetHour ?? 2);
  const where: Prisma.OrderWhereInput = { restaurantId: u.restaurantId, createdAt: { gte: from } };
  if (u.role === "REPARTIDOR") {
    where.repartidorId = u.id;
    where.status = "ON_THE_WAY";
  }
  res.json(
    await prisma.order.findMany({
      where,
      orderBy: u.role === "REPARTIDOR" ? { stopNumber: "asc" } : { createdAt: "asc" },
      include: {
        items: { include: { modifiers: true } },
        repartidor: { select: { id: true, name: true } },
      },
    })
  );
});

/** Manual (phone) order entered by the jefe. */
staff.post("/orders", requireRole("JEFE"), async (req, res) => {
  const input = orderInput.parse(req.body);
  res.status(201).json(await createOrder(rid(req), input, "MANUAL", false, req.user!.id));
});

staff.post("/orders/:id/cancel", requireRole("JEFE"), async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
  const o = await getOrder(req, param(req, "id"));
  if (o.status === "DELIVERED" || o.status === "CANCELLED") throw new OrderError("INVALID_STATUS");
  await prisma.order.update({
    where: { id: o.id },
    data: { status: "CANCELLED", cancelReason: reason, cancelledById: req.user!.id },
  });
  await logEvent(o.id, "CANCELLED", req.user!.id, { reason });
  if (o.repartidorId) {
    await refreshRider(o.repartidorId, rid(req));
    pushToUsers([o.repartidorId], (lang) => ({
      title: lang === "en" ? "Order cancelled" : "Pedido cancelado",
      body: `#${o.number} · ${reason}`,
      data: { type: "CANCELLED", orderId: o.id },
    })).catch((e) => console.error("push failed", e));
  }
  res.json({ ok: true });
});

staff.post("/orders/:id/ready", requireRole("JEFE"), async (req, res) => {
  const o = await getOrder(req, param(req, "id"));
  if (o.status !== "IN_KITCHEN") throw new OrderError("INVALID_STATUS");
  await prisma.order.update({ where: { id: o.id }, data: { status: "READY" } });
  await logEvent(o.id, "READY", req.user!.id);
  res.json({ ok: true });
});

/** Assign (or re-assign, even after the trip started) a repartidor. */
staff.post("/orders/:id/assign", requireRole("JEFE"), async (req, res) => {
  const { repartidorId } = z.object({ repartidorId: z.string().uuid() }).parse(req.body);
  const o = await getOrder(req, param(req, "id"));
  if (o.status !== "READY" && o.status !== "ON_THE_WAY") throw new OrderError("INVALID_STATUS");
  const shift = await openShift(repartidorId, rid(req));
  if (!shift) throw new OrderError("RIDER_NOT_ON_SHIFT");
  const current = await activeCount(repartidorId, rid(req), o.id);
  if (current >= MAX_PER_TRIP) throw new OrderError("RIDER_FULL");

  const previous = o.repartidorId;
  await prisma.$transaction([
    prisma.order.update({
      where: { id: o.id },
      data: { status: "ON_THE_WAY", repartidorId, stopNumber: current + 1 },
    }),
    prisma.shift.update({
      where: { id: shift.id },
      data: { availableSince: null, comingBack: false },
    }),
  ]);
  await logEvent(o.id, previous ? "REASSIGNED" : "ASSIGNED", req.user!.id, {
    from: previous,
    to: repartidorId,
  });
  if (current + 1 >= 2) {
    await optimizeRiderStops(rid(req), repartidorId);
  }
  if (previous && previous !== repartidorId) await refreshRider(previous, rid(req));
  const where = `${o.streetType} ${o.streetName} ${o.streetNumber}`;
  pushToUsers([repartidorId], (lang) => ({
    title: lang === "en" ? "New order assigned" : "Nuevo pedido asignado",
    body: `#${o.number} · ${o.clientName} · ${where}`,
    data: { type: "ASSIGNED", orderId: o.id },
  })).catch((e) => console.error("push failed", e));
  if (previous && previous !== repartidorId) {
    pushToUsers([previous], (lang) => ({
      title: lang === "en" ? "Order reassigned" : "Pedido reasignado",
      body: lang === "en" ? `#${o.number} now goes with another rider` : `El pedido #${o.number} lo lleva otro repartidor`,
      data: { type: "REASSIGNED", orderId: o.id },
    })).catch((e) => console.error("push failed", e));
  }
  res.json({ ok: true });
});

/** The rider confirms a drop-off (the app shows a confirmation screen first). */
staff.post("/orders/:id/delivered", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const o = await getOrder(req, param(req, "id"));
  if (o.status !== "ON_THE_WAY") throw new OrderError("INVALID_STATUS");
  if (req.user!.role === "REPARTIDOR" && o.repartidorId !== req.user!.id)
    throw new OrderError("NOT_YOUR_ORDER", 403);
  await prisma.order.update({
    where: { id: o.id },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });
  await logEvent(o.id, "DELIVERED", req.user!.id);
  if (o.repartidorId) await refreshRider(o.repartidorId, rid(req));
  res.json({ ok: true });
});

/** The rider (or jefe) corrects the address after the jefe phoned the client. */
staff.patch("/orders/:id/address", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const patch = z.object(addressFields).partial().parse(req.body);
  const o = await getOrder(req, param(req, "id"));
  if (req.user!.role === "REPARTIDOR" && o.repartidorId !== req.user!.id)
    throw new OrderError("NOT_YOUR_ORDER", 403);
  res.json(await updateAddress(rid(req), o.id, patch, req.user!.id));
});

staff.post("/orders/:id/reprint", requireRole("JEFE"), async (req, res) => {
  const o = await getOrder(req, param(req, "id"));
  await prisma.order.update({ where: { id: o.id }, data: { printedAt: null, printFailed: false } });
  res.json({ ok: true });
});

/** Unreachable customer timer: starts 5-min countdown, alerts Jefe, notifies customer chat. */
staff.post("/orders/:id/unreachable", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const o = await getOrder(req, param(req, "id"));
  if (o.status !== "ON_THE_WAY") throw new OrderError("INVALID_STATUS");
  if (req.user!.role === "REPARTIDOR" && o.repartidorId !== req.user!.id)
    throw new OrderError("NOT_YOUR_ORDER", 403);
  const startedAt = o.unreachableStartedAt ?? new Date();
  if (!o.unreachableStartedAt) {
    await prisma.order.update({
      where: { id: o.id },
      data: { unreachableStartedAt: startedAt },
    });
    await logEvent(o.id, "UNREACHABLE_ATTEMPT", req.user!.id);
    await prisma.chatMessage.create({
      data: {
        restaurantId: rid(req),
        channel: "RIDER_CLIENT",
        orderId: o.id,
        senderRole: "REPARTIDOR",
        senderName: "Repartidor",
        text: "Tu repartidor está en la puerta y no logra contactar contigo. Por favor, responde en los próximos 5 minutos.",
      },
    });
    pushToJefes(rid(req), () => ({
      title: `¡Cliente no contesta! Pedido #${o.number}`,
      body: `${o.clientName} (${o.clientPhone}) no responde en la puerta.`,
      data: { type: "UNREACHABLE", orderId: o.id },
    })).catch(() => {});
  }
  res.json({ ok: true, unreachableStartedAt: startedAt });
});

/** After 5 minutes (or immediately by Jefe), mark unreachable order returned to store. */
staff.post("/orders/:id/unreachable-return", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const o = await getOrder(req, param(req, "id"));
  if (o.status !== "ON_THE_WAY") throw new OrderError("INVALID_STATUS");
  if (req.user!.role === "REPARTIDOR") {
    if (o.repartidorId !== req.user!.id) throw new OrderError("NOT_YOUR_ORDER", 403);
    if (!o.unreachableStartedAt || Date.now() - o.unreachableStartedAt.getTime() < 5 * 60_000) {
      throw new OrderError("WAIT_5_MINUTES");
    }
  }
  await prisma.order.update({
    where: { id: o.id },
    data: {
      status: "CANCELLED",
      cancelReason: "Incidencia: cliente no contesta (devuelto a tienda)",
      cancelledById: req.user!.id,
    },
  });
  await logEvent(o.id, "UNREACHABLE_RETURN", req.user!.id);
  if (o.repartidorId) await refreshRider(o.repartidorId, rid(req));
  res.json({ ok: true });
});

/** Optimize stop order (2-4 active orders) for a rider using Google Routes API / fallback. */
staff.post("/staff/riders/:riderId/optimize-route", requireRole("JEFE"), async (req, res) => {
  const riderId = param(req, "riderId");
  const stopOrder = await optimizeRiderStops(rid(req), riderId);
  if (stopOrder.length >= 2) {
    pushToUsers([riderId], (lang) => ({
      title: lang === "en" ? "Route updated" : "Ruta optimizada",
      body: lang === "en" ? "Your delivery stops have been reordered" : "Se ha calculado el orden óptimo de tus paradas",
      data: { type: "ROUTE_OPTIMIZED" },
    })).catch(() => {});
  }
  res.json({ ok: true, stopOrder });
});

/** Manual stop reorder fallback by the Jefe. */
staff.post("/staff/riders/:riderId/reorder-stops", requireRole("JEFE"), async (req, res) => {
  const riderId = param(req, "riderId");
  const { orderIds } = z.object({ orderIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
  const active = await prisma.order.findMany({
    where: { restaurantId: rid(req), repartidorId: riderId, status: "ON_THE_WAY" },
    select: { id: true },
  });
  const activeSet = new Set(active.map((o) => o.id));
  if (orderIds.some((id) => !activeSet.has(id))) throw new OrderError("INVALID_STATUS");
  await prisma.$transaction(
    orderIds.map((id, idx) =>
      prisma.order.update({ where: { id }, data: { stopNumber: idx + 1 } })
    )
  );
  res.json({ ok: true, stopOrder: orderIds });
});

/** Throttled live GPS update sent by Repartidor while status is DELIVERING. */
staff.patch("/staff/riders/me/location", requireRole("REPARTIDOR"), async (req, res) => {
  const { lat, lng } = z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .parse(req.body);
  const active = await activeCount(req.user!.id, rid(req));
  if (active === 0) return res.json({ ok: false, stopped: true });
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { lastLat: lat, lastLng: lng, lastLocationAt: new Date() },
  });
  res.json({ ok: true });
});

// ---------- Riders and the queue ----------
/** Riders on shift with live status. `suggested` = waited longest (first in, first out). */
staff.get("/riders", requireRole("JEFE"), async (req, res) => {
  const shifts = await prisma.shift.findMany({
    where: { restaurantId: rid(req), endedAt: null },
    include: { user: { select: { id: true, name: true } } },
  });
  const riders = await Promise.all(
    shifts.map(async (s) => {
      const active = await activeCount(s.userId, rid(req));
      return {
        id: s.user.id,
        name: s.user.name,
        shiftId: s.id,
        status: riderStatus(s, active),
        activeOrders: active,
        availableSince: s.availableSince,
      };
    })
  );
  const queue = riders
    .filter((r) => r.status === "AVAILABLE" && r.availableSince)
    .sort((a, b) => a.availableSince!.getTime() - b.availableSince!.getTime());
  res.json({ riders, suggestedRiderId: queue[0]?.id ?? null });
});

/** Rider's own state: shift on/off and status (shown in the profile screen). */
staff.get("/me/shift", requireRole("REPARTIDOR"), async (req, res) => {
  const s = await openShift(req.user!.id, rid(req));
  if (!s) return res.json({ onShift: false });
  const active = await activeCount(req.user!.id, rid(req));
  res.json({ onShift: true, since: s.startedAt, status: riderStatus(s, active) });
});

/** "Ready to deliver" button: only valid while coming back to the restaurant. */
staff.post("/me/ready", requireRole("REPARTIDOR"), async (req, res) => {
  const s = await openShift(req.user!.id, rid(req));
  if (!s) throw new OrderError("NOT_ON_SHIFT");
  if (!s.comingBack || (await activeCount(req.user!.id, rid(req))) > 0)
    throw new OrderError("NOT_COMING_BACK");
  await prisma.shift.update({
    where: { id: s.id },
    data: { comingBack: false, availableSince: new Date() },
  });
  res.json({ ok: true });
});

// ---------- Shifts (opened/closed by the jefe) ----------
staff.post("/shifts/open", requireRole("JEFE"), async (req, res) => {
  const { userId, changeGiven } = z
    .object({ userId: z.string().uuid(), changeGiven: z.number().min(0).default(0) })
    .parse(req.body);
  const rider = await prisma.user.findFirst({
    where: { id: userId, restaurantId: rid(req), role: "REPARTIDOR", active: true },
  });
  if (!rider) throw new OrderError("NOT_FOUND", 404);
  if (await openShift(userId, rid(req))) throw new OrderError("SHIFT_ALREADY_OPEN");
  // Opens as available: joins the queue straight away.
  res.status(201).json(
    await prisma.shift.create({
      data: { restaurantId: rid(req), userId, changeGiven, availableSince: new Date() },
    })
  );
});

staff.post("/shifts/:id/close", requireRole("JEFE"), async (req, res) => {
  const s = await prisma.shift.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req), endedAt: null },
  });
  if (!s) throw new OrderError("NOT_FOUND", 404);
  if ((await activeCount(s.userId, rid(req))) > 0) throw new OrderError("RIDER_HAS_ORDERS");
  res.json(
    await prisma.shift.update({
      where: { id: s.id },
      data: { endedAt: new Date(), availableSince: null, comingBack: false },
    })
  );
});

/** Jefe-only settlement: balanced, or a difference (missing / extra) with a note. */
staff.post("/shifts/:id/settle", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      settlement: z.enum(["BALANCED", "DIFFERENCE"]),
      difference: z.number().optional(), // negative = missing, positive = extra
      note: z.string().optional(),
    })
    .parse(req.body);
  const s = await prisma.shift.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req), endedAt: { not: null } },
  });
  if (!s) throw new OrderError("NOT_FOUND", 404);
  res.json(
    await prisma.shift.update({
      where: { id: s.id },
      data: {
        settlement: body.settlement,
        difference: body.settlement === "BALANCED" ? 0 : body.difference ?? 0,
        settlementNote: body.note,
      },
    })
  );
});

/** Closed shifts of today plus any older unsettled ones. */
staff.get("/shifts", requireRole("JEFE"), async (req, res) => {
  const r = await prisma.restaurant.findUniqueOrThrow({
    where: { id: rid(req) },
    include: { settings: true },
  });
  const from = workingDayStart(new Date(), r.timezone, r.settings?.dayResetHour ?? 2);
  res.json(
    await prisma.shift.findMany({
      where: {
        restaurantId: rid(req),
        OR: [{ startedAt: { gte: from } }, { endedAt: { not: null }, settlement: "PENDING" }],
      },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { startedAt: "desc" },
    })
  );
});

async function shiftSummary(
  shift: { userId: string; startedAt: Date; endedAt: Date | null; changeGiven: Prisma.Decimal },
  restaurantId: string
) {
  const orders = await prisma.order.findMany({
    where: {
      restaurantId,
      repartidorId: shift.userId,
      status: "DELIVERED",
      deliveredAt: { gte: shift.startedAt, lte: shift.endedAt ?? new Date() },
    },
    orderBy: { deliveredAt: "asc" },
  });
  const cash = orders.filter((o) => o.paymentMethod === "CASH");
  const cashCollected = cash.reduce((a, o) => a.add(o.total), new Prisma.Decimal(0));
  return {
    deliveries: orders.length,
    cashDeliveries: cash.length,
    cashCollected,
    changeGiven: shift.changeGiven,
    cashDue: cashCollected.add(shift.changeGiven),
    // each card payment listed on its own, never summed
    cardPayments: orders
      .filter((o) => o.paymentMethod === "CARD")
      .map((o) => ({ orderNumber: o.number, amount: o.total })),
    history: [...orders].reverse().map((o) => ({
      id: o.id,
      number: o.number,
      clientName: o.clientName,
      streetType: o.streetType,
      streetName: o.streetName,
      streetNumber: o.streetNumber,
      postalCode: o.postalCode,
      floor: o.floor,
      door: o.door,
      total: o.total,
      paymentMethod: o.paymentMethod,
      cashAmount: o.cashAmount,
      deliveredAt: o.deliveredAt,
    })),
  };
}

/** Jefe: summary of any shift. */
staff.get("/shifts/:id/summary", requireRole("JEFE"), async (req, res) => {
  const s = await prisma.shift.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!s) throw new OrderError("NOT_FOUND", 404);
  res.json(await shiftSummary(s, rid(req)));
});

/** Repartidor: summary of his current shift (no settlement info). */
staff.get("/me/summary", requireRole("REPARTIDOR"), async (req, res) => {
  const s = await openShift(req.user!.id, rid(req));
  if (!s) throw new OrderError("NOT_ON_SHIFT");
  res.json(await shiftSummary(s, rid(req)));
});

/** Jefe: all active repartidores (to open their shifts and edit their details). */
staff.get("/staff/riders", requireRole("JEFE"), async (req, res) => {
  res.json(
    await prisma.user.findMany({
      where: { restaurantId: rid(req), role: "REPARTIDOR", active: true },
      select: { id: true, name: true, email: true, phone: true, documentNumber: true },
      orderBy: { email: "asc" },
    })
  );
});

/** Jefe: create a new repartidor account. */
staff.post("/staff/riders", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1),
      email: z.string().email(),
      password: z.string().min(4),
      documentNumber: z.string().optional(),
      phone: z.string().optional(),
      language: z.enum(["es", "en"]).optional(),
    })
    .parse(req.body);
  const email = body.email.trim().toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw new OrderError("EMAIL_TAKEN", 409);
  const passwordHash = await bcrypt.hash(body.password, 10);
  res.status(201).json(
    await prisma.user.create({
      data: {
        restaurantId: rid(req),
        role: "REPARTIDOR",
        name: body.name.trim(),
        email,
        passwordHash,
        documentNumber: body.documentNumber?.trim() || null,
        phone: body.phone?.trim() || null,
        language: body.language ?? "es",
      },
      select: { id: true, name: true, email: true, phone: true, documentNumber: true },
    })
  );
});

/** Jefe: update a repartidor's name, DNI/NIE/passport number, and phone number. */
staff.patch("/staff/riders/:id", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).optional(),
      documentNumber: z.string().optional(),
      phone: z.string().optional(),
      password: z.string().min(4).optional(),
    })
    .parse(req.body);
  const rider = await prisma.user.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req), role: "REPARTIDOR", active: true },
  });
  if (!rider) throw new OrderError("NOT_FOUND", 404);
  const passwordHash = body.password ? await bcrypt.hash(body.password, 10) : undefined;
  res.json(
    await prisma.user.update({
      where: { id: rider.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.documentNumber !== undefined ? { documentNumber: body.documentNumber.trim() || null } : {}),
        ...(body.phone !== undefined ? { phone: body.phone.trim() || null } : {}),
        ...(passwordHash ? { passwordHash } : {}),
      },
      select: { id: true, name: true, email: true, phone: true, documentNumber: true },
    })
  );
});

/** Jefe: restaurant operational status (rush mode, printer watchdog, unprinted alerts, fiscal config). */
staff.get("/staff/restaurant/status", requireRole("JEFE"), async (req, res) => {
  const r = await prisma.restaurant.findUniqueOrThrow({
    where: { id: rid(req) },
    include: { hours: true, printers: { where: { active: true } } },
  });
  const { weekday, minutes } = localParts(new Date(), r.timezone);
  const open = r.hours.some((h) => h.weekday === weekday && minutes >= h.openMin && minutes < h.closeMin);
  const lastPoll = r.lastPrinterPollAt ?? r.printers[0]?.lastSeenAt ?? null;
  const printerOffline = open && (!lastPoll || Date.now() - lastPoll.getTime() > 45_000);
  const unprintedCutoff = new Date(Date.now() - 60_000);
  const unprintedAlerts = await prisma.order.findMany({
    where: {
      restaurantId: rid(req),
      status: "IN_KITCHEN",
      printedAt: null,
      createdAt: { lt: unprintedCutoff },
    },
    select: { id: true, number: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    extraPrepMinutes: r.extraPrepMinutes,
    open,
    lastPrinterPollAt: lastPoll,
    printerOffline,
    unprintedAlerts,
    legalName: r.legalName,
    nifCif: r.nifCif,
    fiscalAddress: r.fiscalAddress,
    defaultVatRate: Number(r.defaultVatRate),
    printCustomerReceipt: r.printCustomerReceipt,
  });
});

/** Jefe: toggle dynamic rush mode delay (+0 / +15 / +30 min). */
staff.patch("/staff/restaurant/prep-delay", requireRole("JEFE"), async (req, res) => {
  const { extraPrepMinutes } = z
    .object({ extraPrepMinutes: z.number().int().min(0).max(120) })
    .parse(req.body);
  const updated = await prisma.restaurant.update({
    where: { id: rid(req) },
    data: { extraPrepMinutes },
    select: { extraPrepMinutes: true },
  });
  res.json(updated);
});

/** Jefe: update Spanish fiscal configuration (legalName, nifCif, fiscalAddress, defaultVatRate, printCustomerReceipt). */
staff.patch("/staff/restaurant/fiscal", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      legalName: z.string().min(1).optional(),
      nifCif: z.string().min(1).optional(),
      fiscalAddress: z.string().min(1).optional(),
      defaultVatRate: z.number().min(0).max(100).optional(),
      printCustomerReceipt: z.boolean().optional(),
    })
    .parse(req.body);
  const updated = await prisma.restaurant.update({
    where: { id: rid(req) },
    data: {
      ...(body.legalName !== undefined ? { legalName: body.legalName.trim() } : {}),
      ...(body.nifCif !== undefined ? { nifCif: body.nifCif.trim().toUpperCase() } : {}),
      ...(body.fiscalAddress !== undefined ? { fiscalAddress: body.fiscalAddress.trim() } : {}),
      ...(body.defaultVatRate !== undefined ? { defaultVatRate: body.defaultVatRate } : {}),
      ...(body.printCustomerReceipt !== undefined ? { printCustomerReceipt: body.printCustomerReceipt } : {}),
    },
    select: {
      legalName: true,
      nifCif: true,
      fiscalAddress: true,
      defaultVatRate: true,
      printCustomerReceipt: true,
    },
  });
  res.json(updated);
});

/** Jefe: menu for manual orders and menu editor (available products only, or all when ?all=1). */
staff.post("/restaurant/hours", requireRole("JEFE"), async (req, res) => {
  const { openMin, closeMin } = z
    .object({ openMin: z.number().int().min(0).max(1440), closeMin: z.number().int().min(0).max(1440) })
    .parse(req.body);
  await prisma.openingHour.updateMany({
    where: { restaurantId: rid(req) },
    data: { openMin, closeMin },
  });
  res.json({ ok: true, openMin, closeMin });
});

staff.get("/menu", requireRole("JEFE"), async (req, res) => {
  const all = req.query.all === "1" || req.query.all === "true";
  res.json(
    await prisma.category.findMany({
      where: { restaurantId: rid(req) },
      orderBy: { position: "asc" },
      include: {
        products: {
          ...(all ? {} : { where: { available: true } }),
          orderBy: { name: "asc" },
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
        },
      },
    })
  );
});

/** Jefe: modifier groups & options management. */
staff.get("/menu/modifier-groups", requireRole("JEFE"), async (req, res) => {
  res.json(
    await prisma.modifierGroup.findMany({
      where: { restaurantId: rid(req) },
      orderBy: { sortOrder: "asc" },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    })
  );
});

staff.post("/menu/modifier-groups", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1),
      minSelections: z.number().int().min(0).default(0),
      maxSelections: z.number().int().min(1).default(1),
      sortOrder: z.number().int().optional(),
    })
    .parse(req.body);
  const count = await prisma.modifierGroup.count({ where: { restaurantId: rid(req) } });
  res.status(201).json(
    await prisma.modifierGroup.create({
      data: {
        restaurantId: rid(req),
        name: body.name.trim(),
        minSelections: body.minSelections,
        maxSelections: Math.max(body.minSelections, body.maxSelections),
        sortOrder: body.sortOrder ?? count,
      },
      include: { options: true },
    })
  );
});

staff.patch("/menu/modifier-groups/:id", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).optional(),
      minSelections: z.number().int().min(0).optional(),
      maxSelections: z.number().int().min(1).optional(),
      sortOrder: z.number().int().optional(),
    })
    .parse(req.body);
  const g = await prisma.modifierGroup.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!g) throw new OrderError("NOT_FOUND", 404);
  res.json(
    await prisma.modifierGroup.update({
      where: { id: g.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.minSelections !== undefined ? { minSelections: body.minSelections } : {}),
        ...(body.maxSelections !== undefined ? { maxSelections: body.maxSelections } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    })
  );
});

staff.delete("/menu/modifier-groups/:id", requireRole("JEFE"), async (req, res) => {
  const g = await prisma.modifierGroup.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!g) throw new OrderError("NOT_FOUND", 404);
  await prisma.modifierGroup.delete({ where: { id: g.id } });
  res.json({ ok: true });
});

staff.post("/menu/modifier-options", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      modifierGroupId: z.string().uuid(),
      name: z.string().min(1),
      priceDelta: z.number().default(0),
      isAvailable: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    })
    .parse(req.body);
  const g = await prisma.modifierGroup.findFirst({
    where: { id: body.modifierGroupId, restaurantId: rid(req) },
  });
  if (!g) throw new OrderError("NOT_FOUND", 404);
  const count = await prisma.modifierOption.count({ where: { modifierGroupId: g.id } });
  res.status(201).json(
    await prisma.modifierOption.create({
      data: {
        modifierGroupId: g.id,
        name: body.name.trim(),
        priceDelta: body.priceDelta,
        isAvailable: body.isAvailable ?? true,
        sortOrder: body.sortOrder ?? count,
      },
    })
  );
});

staff.patch("/menu/modifier-options/:id", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).optional(),
      priceDelta: z.number().optional(),
      isAvailable: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    })
    .parse(req.body);
  const opt = await prisma.modifierOption.findFirst({
    where: { id: param(req, "id"), modifierGroup: { restaurantId: rid(req) } },
  });
  if (!opt) throw new OrderError("NOT_FOUND", 404);
  res.json(
    await prisma.modifierOption.update({
      where: { id: opt.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.priceDelta !== undefined ? { priceDelta: body.priceDelta } : {}),
        ...(body.isAvailable !== undefined ? { isAvailable: body.isAvailable } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      },
    })
  );
});

staff.delete("/menu/modifier-options/:id", requireRole("JEFE"), async (req, res) => {
  const opt = await prisma.modifierOption.findFirst({
    where: { id: param(req, "id"), modifierGroup: { restaurantId: rid(req) } },
  });
  if (!opt) throw new OrderError("NOT_FOUND", 404);
  await prisma.modifierOption.delete({ where: { id: opt.id } });
  res.json({ ok: true });
});

/** Jefe: create a menu category. */
staff.post("/menu/categories", requireRole("JEFE"), async (req, res) => {
  const { name, position } = z
    .object({ name: z.string().min(1), position: z.number().int().optional() })
    .parse(req.body);
  const count = await prisma.category.count({ where: { restaurantId: rid(req) } });
  res.status(201).json(
    await prisma.category.create({
      data: { restaurantId: rid(req), name: name.trim(), position: position ?? count },
      include: { products: true },
    })
  );
});

/** Jefe: rename or reorder a menu category. */
staff.patch("/menu/categories/:id", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({ name: z.string().min(1).optional(), position: z.number().int().optional() })
    .parse(req.body);
  const cat = await prisma.category.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!cat) throw new OrderError("NOT_FOUND", 404);
  res.json(
    await prisma.category.update({
      where: { id: cat.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
      },
    })
  );
});

/** Jefe: delete a menu category (products inside are unlinked or deleted if unused). */
staff.delete("/menu/categories/:id", requireRole("JEFE"), async (req, res) => {
  const cat = await prisma.category.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!cat) throw new OrderError("NOT_FOUND", 404);
  await prisma.product.updateMany({
    where: { categoryId: cat.id, restaurantId: rid(req) },
    data: { categoryId: null, available: false },
  });
  await prisma.category.delete({ where: { id: cat.id } });
  res.json({ ok: true });
});

/** Jefe: create a product inside a category (with allergens, combo flag, VAT rate, modifier groups). */
staff.post("/menu/products", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      categoryId: z.string().uuid(),
      name: z.string().min(1),
      description: z.string().optional(),
      price: z.number().nonnegative(),
      available: z.boolean().optional(),
      allergens: z.array(z.string()).optional(),
      isCombo: z.boolean().optional(),
      vatRate: z.number().min(0).max(100).optional(),
      modifierGroupIds: z.array(z.string().uuid()).optional(),
    })
    .parse(req.body);
  const cat = await prisma.category.findFirst({
    where: { id: body.categoryId, restaurantId: rid(req) },
  });
  if (!cat) throw new OrderError("NOT_FOUND", 404);

  const validGroupIds = body.modifierGroupIds?.length
    ? (
        await prisma.modifierGroup.findMany({
          where: { id: { in: body.modifierGroupIds }, restaurantId: rid(req) },
          select: { id: true },
        })
      ).map((g) => g.id)
    : [];

  res.status(201).json(
    await prisma.product.create({
      data: {
        restaurantId: rid(req),
        categoryId: cat.id,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        price: body.price,
        available: body.available ?? true,
        allergens: body.allergens ?? [],
        isCombo: body.isCombo ?? false,
        vatRate: body.vatRate ?? 10.0,
        ...(validGroupIds.length
          ? {
              modifierGroups: {
                create: validGroupIds.map((modifierGroupId, sortOrder) => ({
                  modifierGroupId,
                  sortOrder,
                })),
              },
            }
          : {}),
      },
      include: {
        modifierGroups: { include: { modifierGroup: { include: { options: true } } } },
      },
    })
  );
});

/** Jefe: edit a product's name, description, price, category, availability, allergens, combo, VAT, modifiers. */
staff.patch("/menu/products/:id", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      categoryId: z.string().uuid().optional(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      price: z.number().nonnegative().optional(),
      available: z.boolean().optional(),
      allergens: z.array(z.string()).optional(),
      isCombo: z.boolean().optional(),
      vatRate: z.number().min(0).max(100).optional(),
      modifierGroupIds: z.array(z.string().uuid()).optional(),
    })
    .parse(req.body);
  const prod = await prisma.product.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!prod) throw new OrderError("NOT_FOUND", 404);

  if (body.modifierGroupIds !== undefined) {
    const validGroups = body.modifierGroupIds.length
      ? await prisma.modifierGroup.findMany({
          where: { id: { in: body.modifierGroupIds }, restaurantId: rid(req) },
          select: { id: true },
        })
      : [];
    const validSet = new Set(validGroups.map((g) => g.id));
    const orderedValid = body.modifierGroupIds.filter((id) => validSet.has(id));
    await prisma.productModifierGroup.deleteMany({ where: { productId: prod.id } });
    if (orderedValid.length > 0) {
      await prisma.productModifierGroup.createMany({
        data: orderedValid.map((modifierGroupId, sortOrder) => ({
          productId: prod.id,
          modifierGroupId,
          sortOrder,
        })),
      });
    }
  }

  res.json(
    await prisma.product.update({
      where: { id: prod.id },
      data: {
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description.trim() || null } : {}),
        ...(body.price !== undefined ? { price: body.price } : {}),
        ...(body.available !== undefined ? { available: body.available } : {}),
        ...(body.allergens !== undefined ? { allergens: body.allergens } : {}),
        ...(body.isCombo !== undefined ? { isCombo: body.isCombo } : {}),
        ...(body.vatRate !== undefined ? { vatRate: body.vatRate } : {}),
      },
      include: {
        modifierGroups: { include: { modifierGroup: { include: { options: true } } } },
      },
    })
  );
});

/** Jefe: delete a product (or hide it if referenced by past orders). */
staff.delete("/menu/products/:id", requireRole("JEFE"), async (req, res) => {
  const prod = await prisma.product.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!prod) throw new OrderError("NOT_FOUND", 404);
  const used = await prisma.orderItem.count({ where: { productId: prod.id } });
  if (used > 0) {
    await prisma.product.update({
      where: { id: prod.id },
      data: { available: false, categoryId: null },
    });
  } else {
    await prisma.product.delete({ where: { id: prod.id } });
  }
  res.json({ ok: true });
});

// ---------- Tiered Delivery Zones & Promo Codes ----------
staff.get("/staff/zones", requireRole("JEFE"), async (req, res) => {
  res.json(
    await prisma.deliveryZone.findMany({
      where: { restaurantId: rid(req) },
      orderBy: { minKm: "asc" },
    })
  );
});

staff.post("/staff/zones", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1),
      minKm: z.number().min(0).default(0),
      maxKm: z.number().positive(),
      deliveryFee: z.number().min(0).default(0),
      minOrderAmount: z.number().min(0).default(0),
      isActive: z.boolean().optional(),
    })
    .parse(req.body);
  res.status(201).json(
    await prisma.deliveryZone.create({
      data: {
        restaurantId: rid(req),
        name: body.name.trim(),
        minKm: body.minKm,
        maxKm: body.maxKm,
        deliveryFee: body.deliveryFee,
        minOrderAmount: body.minOrderAmount,
        isActive: body.isActive ?? true,
      },
    })
  );
});

staff.delete("/staff/zones/:id", requireRole("JEFE"), async (req, res) => {
  const zRow = await prisma.deliveryZone.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!zRow) throw new OrderError("NOT_FOUND", 404);
  await prisma.deliveryZone.delete({ where: { id: zRow.id } });
  res.json({ ok: true });
});

staff.get("/staff/promos", requireRole("JEFE"), async (req, res) => {
  res.json(
    await prisma.promoCode.findMany({
      where: { restaurantId: rid(req) },
      orderBy: { code: "asc" },
    })
  );
});

staff.post("/staff/promos", requireRole("JEFE"), async (req, res) => {
  const body = z
    .object({
      code: z.string().min(2).max(40),
      discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
      discountValue: z.number().positive(),
      minOrderAmount: z.number().min(0).default(0),
      maxUses: z.number().int().positive().nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .parse(req.body);
  const code = body.code.trim().toUpperCase();
  res.status(201).json(
    await prisma.promoCode.upsert({
      where: { restaurantId_code: { restaurantId: rid(req), code } },
      create: {
        restaurantId: rid(req),
        code,
        discountType: body.discountType,
        discountValue: body.discountValue,
        minOrderAmount: body.minOrderAmount,
        maxUses: body.maxUses ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        isActive: body.isActive ?? true,
      },
      update: {
        discountType: body.discountType,
        discountValue: body.discountValue,
        minOrderAmount: body.minOrderAmount,
        maxUses: body.maxUses ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        isActive: body.isActive ?? true,
      },
    })
  );
});

staff.delete("/staff/promos/:id", requireRole("JEFE"), async (req, res) => {
  const pRow = await prisma.promoCode.findFirst({
    where: { id: param(req, "id"), restaurantId: rid(req) },
  });
  if (!pRow) throw new OrderError("NOT_FOUND", 404);
  await prisma.promoCode.delete({ where: { id: pRow.id } });
  res.json({ ok: true });
});

// ---------- Jefe Sales & Operations Analytics (Resumen) ----------
staff.get("/staff/analytics", requireRole("JEFE"), async (req, res) => {
  const r = await prisma.restaurant.findUniqueOrThrow({
    where: { id: rid(req) },
    include: { settings: true },
  });
  const defaultFrom = workingDayStart(new Date(), r.timezone, r.settings?.dayResetHour ?? 2);
  const from = req.query.from ? new Date(String(req.query.from)) : defaultFrom;
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();

  const orders = await prisma.order.findMany({
    where: {
      restaurantId: rid(req),
      status: { not: "CANCELLED" },
      createdAt: { gte: from, lte: to },
    },
    include: {
      items: true,
      events: true,
      repartidor: { select: { id: true, name: true } },
    },
  });

  const grossRevenue = orders.reduce((s, o) => s + Number(o.total), 0);
  const netAmount = orders.reduce((s, o) => s + Number(o.netAmount), 0);
  const vatAmount = orders.reduce((s, o) => s + Number(o.vatAmount), 0);
  const orderCount = orders.length;
  const averageTicket = orderCount > 0 ? grossRevenue / orderCount : 0;

  const cashOrders = orders.filter((o) => o.paymentMethod === "CASH");
  const cardOrders = orders.filter((o) => o.paymentMethod === "CARD");
  const cashTotal = cashOrders.reduce((s, o) => s + Number(o.total), 0);
  const cardTotal = cardOrders.reduce((s, o) => s + Number(o.total), 0);

  const prepSamples: number[] = [];
  const deliverySamples: number[] = [];
  const productAgg = new Map<string, { name: string; quantity: number; revenue: number }>();
  const riderAgg = new Map<string, { name: string; deliveries: number }>();

  for (const o of orders) {
    const readyEv = o.events.find((e) => e.type === "READY");
    if (readyEv) {
      prepSamples.push((readyEv.createdAt.getTime() - o.createdAt.getTime()) / 60_000);
    }
    if (o.deliveredAt) {
      const refTime = readyEv ? readyEv.createdAt.getTime() : o.createdAt.getTime();
      deliverySamples.push((o.deliveredAt.getTime() - refTime) / 60_000);
      if (o.repartidor) {
        const cur = riderAgg.get(o.repartidor.id) ?? { name: o.repartidor.name, deliveries: 0 };
        cur.deliveries += 1;
        riderAgg.set(o.repartidor.id, cur);
      }
    }
    for (const item of o.items) {
      const cur = productAgg.get(item.name) ?? { name: item.name, quantity: 0, revenue: 0 };
      cur.quantity += item.quantity;
      cur.revenue += Number(item.unitPrice) * item.quantity;
      productAgg.set(item.name, cur);
    }
  }

  const avg = (arr: number[]) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : 0);

  res.json({
    from,
    to,
    grossRevenue: Number(grossRevenue.toFixed(2)),
    netAmount: Number(netAmount.toFixed(2)),
    vatAmount: Number(vatAmount.toFixed(2)),
    orderCount,
    averageTicket: Number(averageTicket.toFixed(2)),
    cashTotal: Number(cashTotal.toFixed(2)),
    cashCount: cashOrders.length,
    cardTotal: Number(cardTotal.toFixed(2)),
    cardCount: cardOrders.length,
    avgPrepMinutes: avg(prepSamples),
    avgDeliveryMinutes: avg(deliverySamples),
    topProducts: [...productAgg.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5),
    deliveriesByRider: [...riderAgg.values()].sort((a, b) => b.deliveries - a.deliveries),
  });
});

// ---------- Push: device registration and language ----------
/** The app registers its FCM token after login (the token moves to whoever is logged in). */
staff.post("/me/device", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const { token, platform } = z
    .object({ token: z.string().min(10), platform: z.enum(["android", "ios"]) })
    .parse(req.body);
  await prisma.deviceToken.upsert({
    where: { token },
    create: { token, platform, userId: req.user!.id, restaurantId: rid(req) },
    update: { userId: req.user!.id, restaurantId: rid(req), platform },
  });
  res.json({ ok: true });
});

/** Called on logout so the phone stops receiving the previous user's notifications. */
staff.post("/me/device/remove", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const { token } = z.object({ token: z.string() }).parse(req.body);
  await prisma.deviceToken.deleteMany({ where: { token, userId: req.user!.id } });
  res.json({ ok: true });
});

/** Keeps the notification language in sync with the app language. */
staff.post("/me/language", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const { language } = z.object({ language: z.enum(["es", "en"]) }).parse(req.body);
  await prisma.user.update({ where: { id: req.user!.id }, data: { language } });
  res.json({ ok: true });
});

// ---------- Ratings: visible to all staff (jefe and repartidores) ----------
staff.get("/ratings", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const where = { restaurantId: rid(req) };
  const [list, agg] = await Promise.all([
    prisma.rating.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { order: { select: { number: true } }, repartidor: { select: { name: true } } },
    }),
    prisma.rating.aggregate({ where, _avg: { score: true }, _count: true }),
  ]);
  res.json({
    average: agg._avg.score,
    count: agg._count,
    ratings: list.map((r) => ({
      id: r.id,
      orderNumber: r.order.number,
      score: r.score,
      comment: r.comment,
      repartidor: r.repartidor?.name ?? null,
      createdAt: r.createdAt,
    })),
  });
});

// ---------- Messaging: Private Channels (STAFF, JEFE_CLIENT, RIDER_CLIENT) ----------
/** Get 1-to-1 chat messages between Jefe and a specific Repartidor (channel = STAFF). */
staff.get("/chat/staff/:riderId", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const riderId = req.user!.role === "REPARTIDOR" ? req.user!.id : param(req, "riderId");
  res.json(
    await prisma.chatMessage.findMany({
      where: { restaurantId: rid(req), channel: "STAFF", repartidorId: riderId, orderId: null },
      orderBy: { createdAt: "asc" },
      take: 100,
    })
  );
});

/** Send a 1-to-1 chat message between Jefe and Repartidor (channel = STAFF). */
staff.post("/chat/staff/:riderId", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
  const riderId = req.user!.role === "REPARTIDOR" ? req.user!.id : param(req, "riderId");
  const sender = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  const msg = await prisma.chatMessage.create({
    data: {
      restaurantId: rid(req),
      channel: "STAFF",
      repartidorId: riderId,
      orderId: null,
      senderRole: req.user!.role,
      senderName: sender.name,
      text: text.trim(),
    },
  });
  if (req.user!.role === "JEFE") {
    pushToUsers([riderId], (lang) => ({
      title: lang === "en" ? "Message from Jefe" : "Mensaje del Jefe",
      body: text.trim(),
      data: { type: "STAFF_CHAT", riderId },
    })).catch(() => {});
  }
  res.status(201).json(msg);
});

/**
 * Get private order chat messages:
 * - JEFE only sees JEFE_CLIENT messages (private between Jefe and Client).
 * - REPARTIDOR only sees RIDER_CLIENT messages on their assigned order (private between Repartidor and Client).
 */
staff.get("/orders/:id/messages", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const o = await getOrder(req, param(req, "id"));
  if (req.user!.role === "REPARTIDOR" && o.repartidorId !== req.user!.id)
    throw new OrderError("NOT_YOUR_ORDER", 403);
  const channel = req.user!.role === "JEFE" ? "JEFE_CLIENT" : "RIDER_CLIENT";
  res.json(
    await prisma.chatMessage.findMany({
      where: { orderId: o.id, channel },
      orderBy: { createdAt: "asc" },
    })
  );
});

/**
 * Send a private order chat message:
 * - JEFE posts to JEFE_CLIENT (Repartidor cannot see it).
 * - REPARTIDOR posts to RIDER_CLIENT (Jefe cannot see it).
 */
staff.post("/orders/:id/messages", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
  const o = await getOrder(req, param(req, "id"));
  if (req.user!.role === "REPARTIDOR" && o.repartidorId !== req.user!.id)
    throw new OrderError("NOT_YOUR_ORDER", 403);
  const channel = req.user!.role === "JEFE" ? "JEFE_CLIENT" : "RIDER_CLIENT";
  const sender = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  const msg = await prisma.chatMessage.create({
    data: {
      restaurantId: rid(req),
      channel,
      orderId: o.id,
      senderRole: req.user!.role,
      senderName: sender.name,
      text: text.trim(),
    },
  });
  res.status(201).json(msg);
});

/**
 * Returns recent incoming messages strictly visible to the current user (for notification sounds):
 * - JEFE receives incoming STAFF messages from riders + incoming JEFE_CLIENT messages from clients.
 * - REPARTIDOR receives incoming STAFF messages for their riderId + incoming RIDER_CLIENT messages on their active orders.
 */
staff.get("/chat/inbox", requireRole("JEFE", "REPARTIDOR"), async (req, res) => {
  const u = req.user!;
  if (u.role === "JEFE") {
    res.json(
      await prisma.chatMessage.findMany({
        where: {
          restaurantId: u.restaurantId,
          senderRole: { not: "JEFE" },
          channel: { in: ["STAFF", "JEFE_CLIENT"] },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    );
  } else {
    const myOrders = await prisma.order.findMany({
      where: { restaurantId: u.restaurantId, repartidorId: u.id, status: "ON_THE_WAY" },
      select: { id: true },
    });
    const orderIds = myOrders.map((o) => o.id);
    res.json(
      await prisma.chatMessage.findMany({
        where: {
          restaurantId: u.restaurantId,
          senderRole: { not: "REPARTIDOR" },
          OR: [
            { channel: "STAFF", repartidorId: u.id },
            ...(orderIds.length ? [{ channel: "RIDER_CLIENT", orderId: { in: orderIds } }] : []),
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    );
  }
});
