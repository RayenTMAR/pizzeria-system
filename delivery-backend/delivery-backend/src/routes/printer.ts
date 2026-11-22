import { Router, Request } from "express";
import { prisma } from "../db";
import { logEvent } from "../orders";

/**
 * Star CloudPRNT-style endpoints: the printer polls the server by itself.
 *   POST   /printer/:token/poll   -> is there a job?
 *   GET    /printer/:token/job    -> the ticket text
 *   DELETE /printer/:token/job    -> printed OK
 */
export const printerRoutes = Router();

async function printerFor(req: Request) {
  const p = await prisma.printer.findUnique({ where: { token: String(req.params.token) } });
  if (p && p.active) {
    await prisma.printer.update({ where: { id: p.id }, data: { lastSeenAt: new Date() } });
    return p;
  }
  return null;
}

const nextJob = (restaurantId: string, id?: string) =>
  prisma.order.findFirst({
    where: { restaurantId, printedAt: null, status: { not: "CANCELLED" }, ...(id ? { id } : {}) },
    orderBy: { createdAt: "asc" },
    include: { items: true, restaurant: { select: { name: true, timezone: true } } },
  });

printerRoutes.post("/printer/:token/poll", async (req, res) => {
  const p = await printerFor(req);
  if (!p) return res.sendStatus(404);
  const job = await nextJob(p.restaurantId);
  res.json({ jobReady: !!job, mediaTypes: ["text/plain"], jobToken: job?.id });
});

printerRoutes.get("/printer/:token/job", async (req, res) => {
  const p = await printerFor(req);
  if (!p) return res.sendStatus(404);
  const job = await nextJob(p.restaurantId, req.query.token ? String(req.query.token) : undefined);
  if (!job) return res.sendStatus(204);

  const line = "-".repeat(42);
  const time = job.createdAt.toLocaleTimeString("es-ES", {
    timeZone: job.restaurant.timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const money = (n: unknown) => `${Number(n).toFixed(2)} EUR`;
  const addr = [
    `${job.streetType} ${job.streetName} ${job.streetNumber}`,
    [job.floor && `Planta ${job.floor}`, job.door && `Puerta ${job.door}`].filter(Boolean).join(" "),
    job.postalCode,
  ]
    .filter(Boolean)
    .join("\n");
  const pay =
    job.paymentMethod === "CASH"
      ? `EFECTIVO${job.cashAmount ? ` - paga con ${money(job.cashAmount)} (cambio ${money(Number(job.cashAmount) - Number(job.total))})` : ""}`
      : "TARJETA";

  const text = [
    job.restaurant.name,
    `PEDIDO #${job.number}   ${time}`,
    line,
    ...job.items.map((i) => `${i.quantity} x ${i.name}${i.note ? `\n    (${i.note})` : ""}`),
    line,
    `TOTAL: ${money(job.total)}`,
    pay,
    line,
    job.clientName,
    `Tel: ${job.clientPhone}`,
    addr,
    job.notes ? `NOTAS: ${job.notes}` : "",
    line,
    "",
    "",
  ].join("\n");
  res.type("text/plain").send(text);
});

printerRoutes.delete("/printer/:token/job", async (req, res) => {
  const p = await printerFor(req);
  if (!p) return res.sendStatus(404);
  const id = req.query.token ? String(req.query.token) : undefined;
  const job = await nextJob(p.restaurantId, id);
  if (job) {
    await prisma.order.update({ where: { id: job.id }, data: { printedAt: new Date() } });
    await logEvent(job.id, "PRINTED");
  }
  res.sendStatus(200);
});
