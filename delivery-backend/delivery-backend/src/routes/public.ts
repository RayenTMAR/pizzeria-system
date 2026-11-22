import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { signClientToken, verifyClientToken } from "../auth";
import { addressFields, createOrder, orderInput, OrderError, quoteAddress } from "../orders";
import { localParts } from "../rules";

export const publicRoutes = Router();

/** Menu + whether the restaurant is open right now (website uses this for the "closed" message). */
publicRoutes.get("/public/:slug/menu", async (req, res) => {
  const r = await prisma.restaurant.findUnique({
    where: { slug: req.params.slug },
    include: {
      hours: true,
      deliveryZones: { where: { isActive: true }, orderBy: { minKm: "asc" } },
      categories: {
        orderBy: { position: "asc" },
        include: {
          products: {
            where: { available: true },
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
      },
    },
  });
  if (!r || !r.active) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const { weekday, minutes } = localParts(new Date(), r.timezone);
  const open = r.hours.some(
    (h) => h.weekday === weekday && minutes >= h.openMin && minutes < h.closeMin
  );
  res.json({
    name: r.name,
    open,
    extraPrepMinutes: r.extraPrepMinutes,
    deliveryZones: r.deliveryZones,
    hours: r.hours,
    categories: r.categories,
  });
});

/** Estimated time + zone/hours/promo check for an address, before the client places the order. */
publicRoutes.post("/public/:slug/quote", async (req, res) => {
  const r = await prisma.restaurant.findUnique({ where: { slug: req.params.slug } });
  if (!r) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const body = z
    .object({
      ...addressFields,
      subtotal: z.number().nonnegative().optional(),
      promoCode: z.string().max(40).optional(),
    })
    .pick({
      streetType: true,
      streetName: true,
      streetNumber: true,
      postalCode: true,
      subtotal: true,
      promoCode: true,
    })
    .parse(req.body);
  res.json(
    await quoteAddress(
      r.id,
      {
        streetType: body.streetType,
        streetName: body.streetName,
        streetNumber: body.streetNumber,
        postalCode: body.postalCode,
      },
      { subtotal: body.subtotal, promoCode: body.promoCode }
    )
  );
});

/** Guest or logged-in client checkout. Auto-accepted: the ticket prints in the kitchen. */
publicRoutes.post("/public/:slug/orders", async (req, res) => {
  const r = await prisma.restaurant.findUnique({ where: { slug: req.params.slug } });
  if (!r) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const input = orderInput.parse(req.body);
  const clientAuth = verifyClientToken(req.headers.authorization);
  const clientId = clientAuth && clientAuth.restaurantId === r.id ? clientAuth.id : undefined;
  const order = await createOrder(r.id, input, "WEB", true, undefined, clientId);
  if (clientId) {
    await prisma.client
      .update({
        where: { id: clientId },
        data: {
          name: input.clientName,
          phone: input.clientPhone,
          streetType: input.streetType,
          streetName: input.streetName,
          streetNumber: input.streetNumber,
          postalCode: input.postalCode,
          floor: input.floor ?? null,
          door: input.door ?? null,
          notes: input.notes ?? null,
        },
      })
      .catch(() => {});
  }
  res.status(201).json({
    trackingToken: order.trackingToken,
    number: order.number,
    etaMinutes: order.etaMinutes,
    total: order.total,
  });
});

// ---------- Client Accounts (Register, Login, Profile & Order History) ----------
const clientSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  streetType: true,
  streetName: true,
  streetNumber: true,
  postalCode: true,
  floor: true,
  door: true,
  notes: true,
};

publicRoutes.post("/public/:slug/clients/register", async (req, res) => {
  const r = await prisma.restaurant.findUnique({ where: { slug: req.params.slug } });
  if (!r) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const body = z
    .object({
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().min(6),
      password: z.string().min(4),
      streetType: z.string().optional(),
      streetName: z.string().optional(),
      streetNumber: z.string().optional(),
      postalCode: z.string().optional(),
      floor: z.string().optional(),
      door: z.string().optional(),
      notes: z.string().optional(),
    })
    .parse(req.body);
  const email = body.email.trim().toLowerCase();
  const exists = await prisma.client.findUnique({
    where: { restaurantId_email: { restaurantId: r.id, email } },
  });
  if (exists) throw new OrderError("EMAIL_TAKEN", 409);
  const passwordHash = await bcrypt.hash(body.password, 10);
  const client = await prisma.client.create({
    data: {
      restaurantId: r.id,
      name: body.name.trim(),
      email,
      phone: body.phone.trim(),
      passwordHash,
      streetType: body.streetType || "calle",
      streetName: body.streetName?.trim() || "",
      streetNumber: body.streetNumber?.trim() || "",
      postalCode: body.postalCode?.trim() || "",
      floor: body.floor?.trim() || null,
      door: body.door?.trim() || null,
      notes: body.notes?.trim() || null,
    },
    select: clientSelect,
  });
  res.status(201).json({
    token: signClientToken({ id: client.id, restaurantId: r.id }),
    client,
  });
});

publicRoutes.post("/public/:slug/clients/login", async (req, res) => {
  const r = await prisma.restaurant.findUnique({ where: { slug: req.params.slug } });
  if (!r) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const { email, password } = z
    .object({ email: z.string().email(), password: z.string() })
    .parse(req.body);
  const c = await prisma.client.findUnique({
    where: { restaurantId_email: { restaurantId: r.id, email: email.trim().toLowerCase() } },
  });
  if (!c || !(await bcrypt.compare(password, c.passwordHash))) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }
  const { passwordHash: _, restaurantId: __, createdAt: ___, ...client } = c;
  res.json({
    token: signClientToken({ id: c.id, restaurantId: r.id }),
    client,
  });
});

publicRoutes.get("/public/:slug/clients/me", async (req, res) => {
  const r = await prisma.restaurant.findUnique({ where: { slug: req.params.slug } });
  if (!r) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const auth = verifyClientToken(req.headers.authorization);
  if (!auth || auth.restaurantId !== r.id) return res.status(401).json({ error: "unauthorized" });
  const client = await prisma.client.findUnique({
    where: { id: auth.id },
    select: {
      ...clientSelect,
      orders: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          number: true,
          status: true,
          trackingToken: true,
          total: true,
          paymentMethod: true,
          createdAt: true,
          items: { select: { productId: true, name: true, quantity: true, unitPrice: true } },
        },
      },
    },
  });
  if (!client) return res.status(401).json({ error: "unauthorized" });
  res.json(client);
});

publicRoutes.patch("/public/:slug/clients/me", async (req, res) => {
  const r = await prisma.restaurant.findUnique({ where: { slug: req.params.slug } });
  if (!r) throw new OrderError("RESTAURANT_UNAVAILABLE", 404);
  const auth = verifyClientToken(req.headers.authorization);
  if (!auth || auth.restaurantId !== r.id) return res.status(401).json({ error: "unauthorized" });
  const body = z
    .object({
      name: z.string().min(1).optional(),
      phone: z.string().min(6).optional(),
      streetType: z.string().optional(),
      streetName: z.string().optional(),
      streetNumber: z.string().optional(),
      postalCode: z.string().optional(),
      floor: z.string().optional(),
      door: z.string().optional(),
      notes: z.string().optional(),
    })
    .parse(req.body);
  const client = await prisma.client.update({
    where: { id: auth.id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.phone !== undefined ? { phone: body.phone.trim() } : {}),
      ...(body.streetType !== undefined ? { streetType: body.streetType } : {}),
      ...(body.streetName !== undefined ? { streetName: body.streetName.trim() } : {}),
      ...(body.streetNumber !== undefined ? { streetNumber: body.streetNumber.trim() } : {}),
      ...(body.postalCode !== undefined ? { postalCode: body.postalCode.trim() } : {}),
      ...(body.floor !== undefined ? { floor: body.floor.trim() || null } : {}),
      ...(body.door !== undefined ? { door: body.door.trim() || null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes.trim() || null } : {}),
    },
    select: clientSelect,
  });
  res.json(client);
});

/** Tracking page data, identified by the private token. */
publicRoutes.get("/public/orders/:token", async (req, res) => {
  const o = await prisma.order.findUnique({
    where: { trackingToken: req.params.token },
    include: {
      restaurant: { include: { settings: { select: { lat: true, lng: true } } } },
      repartidor: { select: { name: true, lastLat: true, lastLng: true, lastLocationAt: true } },
      rating: { select: { score: true } },
      items: { include: { modifiers: true } },
    },
  });
  if (!o) throw new OrderError("NOT_FOUND", 404);

  const twoMinAgo = Date.now() - 2 * 60 * 1000;
  const freshRiderLoc =
    o.status === "ON_THE_WAY" &&
    o.repartidor?.lastLat != null &&
    o.repartidor?.lastLng != null &&
    o.repartidor?.lastLocationAt != null &&
    o.repartidor.lastLocationAt.getTime() >= twoMinAgo
      ? {
          lat: o.repartidor.lastLat,
          lng: o.repartidor.lastLng,
          updatedAt: o.repartidor.lastLocationAt,
        }
      : null;

  res.json({
    number: o.number,
    invoiceNumber: o.invoiceNumber,
    status: o.status,
    rated: !!o.rating,
    etaMinutes: o.etaMinutes,
    total: o.total,
    unreachableStartedAt: o.unreachableStartedAt,
    items: o.items,
    cancelReason: o.status === "CANCELLED" ? o.cancelReason : null,
    repartidorName:
      o.status === "ON_THE_WAY" || o.status === "DELIVERED"
        ? o.repartidor?.name.split(" ")[0]
        : null,
    ...(o.status === "ON_THE_WAY"
      ? {
          restaurantLocation: o.restaurant.settings
            ? { lat: o.restaurant.settings.lat, lng: o.restaurant.settings.lng }
            : null,
          destinationLocation:
            o.destLat != null && o.destLng != null ? { lat: o.destLat, lng: o.destLng } : null,
          riderLocation: freshRiderLoc,
        }
      : {}),
  });
});

/** One rating per delivered order (score 1-5 + optional comment), sent from the tracking page. */
publicRoutes.post("/public/orders/:token/rating", async (req, res) => {
  const { score, comment } = z
    .object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })
    .parse(req.body);
  const o = await prisma.order.findUnique({
    where: { trackingToken: req.params.token },
    include: { rating: true },
  });
  if (!o) throw new OrderError("NOT_FOUND", 404);
  if (o.status !== "DELIVERED") throw new OrderError("NOT_DELIVERED");
  if (o.rating) throw new OrderError("ALREADY_RATED", 409);
  try {
    await prisma.rating.create({
      data: { restaurantId: o.restaurantId, orderId: o.id, repartidorId: o.repartidorId, score, comment },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new OrderError("ALREADY_RATED", 409);
    throw e;
  }
  res.status(201).json({ ok: true });
});

/**
 * Private chats on the client tracking page:
 *   channel = "JEFE_CLIENT"  (private between Jefe and Client)
 *   channel = "RIDER_CLIENT" (private between Repartidor and Client)
 */
publicRoutes.get("/public/orders/:token/messages", async (req, res) => {
  const o = await prisma.order.findUnique({ where: { trackingToken: req.params.token } });
  if (!o) throw new OrderError("NOT_FOUND", 404);
  const channel = req.query.channel === "JEFE_CLIENT" ? "JEFE_CLIENT" : "RIDER_CLIENT";
  res.json(
    await prisma.chatMessage.findMany({
      where: { orderId: o.id, channel },
      orderBy: { createdAt: "asc" },
    })
  );
});

publicRoutes.post("/public/orders/:token/messages", async (req, res) => {
  const { text, channel } = z
    .object({
      text: z.string().min(1).max(500),
      channel: z.enum(["JEFE_CLIENT", "RIDER_CLIENT"]).default("RIDER_CLIENT"),
    })
    .parse(req.body);
  const o = await prisma.order.findUnique({ where: { trackingToken: req.params.token } });
  if (!o) throw new OrderError("NOT_FOUND", 404);
  if (o.status === "CANCELLED") throw new OrderError("INVALID_STATUS");
  const msg = await prisma.chatMessage.create({
    data: {
      restaurantId: o.restaurantId,
      orderId: o.id,
      channel,
      senderRole: "CLIENT",
      senderName: o.clientName,
      text: text.trim(),
    },
  });
  res.status(201).json(msg);
});
