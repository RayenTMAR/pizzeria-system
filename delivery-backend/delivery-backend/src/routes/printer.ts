import { Router, Request } from "express";
import { prisma } from "../db";
import { logEvent } from "../orders";

/**
 * Star CloudPRNT-style endpoints: the printer polls the server by itself.
 *   POST   /printer/:token/poll   -> is there a job?
 *   GET    /printer/:token/job    -> the ticket text (Kitchen + Fiscal Customer Receipt)
 *   DELETE /printer/:token/job    -> printed OK
 */
export const printerRoutes = Router();

async function printerFor(req: Request) {
  const p = await prisma.printer.findUnique({ where: { token: String(req.params.token) } });
  if (p && p.active) {
    const now = new Date();
    await Promise.all([
      prisma.printer.update({ where: { id: p.id }, data: { lastSeenAt: now } }),
      prisma.restaurant.update({ where: { id: p.restaurantId }, data: { lastPrinterPollAt: now } }),
    ]);
    return p;
  }
  return null;
}

const nextJob = (restaurantId: string, id?: string) =>
  prisma.order.findFirst({
    where: { restaurantId, printedAt: null, status: { not: "CANCELLED" }, ...(id ? { id } : {}) },
    orderBy: { createdAt: "asc" },
    include: {
      items: { include: { modifiers: true } },
      restaurant: true,
    },
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
  const cutLine = "=".repeat(42);
  const time = job.createdAt.toLocaleTimeString("es-ES", {
    timeZone: job.restaurant.timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = job.createdAt.toLocaleDateString("es-ES", {
    timeZone: job.restaurant.timezone,
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

  // Section 1: Kitchen Ticket (COMANDA DE COCINA)
  const kitchenItems = job.items.flatMap((i) => [
    `${i.quantity} x ${i.name}`,
    ...i.modifiers.map((m) => `  + ${m.optionName}`),
    ...(i.note ? [`    (${i.note})`] : []),
  ]);

  const sections: string[] = [
    job.restaurant.name,
    "COMANDA DE COCINA",
    `PEDIDO #${job.number}   ${dateStr} ${time}`,
    line,
    ...kitchenItems,
    line,
    pay,
    job.clientName,
    `Tel: ${job.clientPhone}`,
    addr,
    ...(job.notes ? [`NOTAS: ${job.notes}`] : []),
    line,
  ];

  // Section 2: Customer Simplified Fiscal Invoice (FACTURA SIMPLIFICADA)
  if (job.restaurant.printCustomerReceipt) {
    const fiscalItems = job.items.flatMap((i) => {
      const lineTotal = money(Number(i.unitPrice) * i.quantity);
      return [
        `${i.quantity}x ${i.name}  ${lineTotal}`,
        ...i.modifiers.map(
          (m) => `  + ${m.optionName}${Number(m.priceDelta) > 0 ? ` (+${money(m.priceDelta)})` : ""}`
        ),
      ];
    });

    const vatRows = Array.isArray(job.vatBreakdown)
      ? (job.vatBreakdown as { rate: number; base: number; quota: number }[])
      : [{ rate: Number(job.restaurant.defaultVatRate), base: Number(job.netAmount), quota: Number(job.vatAmount) }];

    sections.push(
      "",
      cutLine,
      "FACTURA SIMPLIFICADA (TICKET CLIENTE)",
      job.restaurant.legalName,
      `NIF/CIF: ${job.restaurant.nifCif}`,
      job.restaurant.fiscalAddress,
      `FACTURA: ${job.invoiceNumber ?? job.number}`,
      `FECHA: ${dateStr} ${time}`,
      line,
      ...fiscalItems,
      ...(Number(job.deliveryFee) > 0 ? [`Envio a domicilio  ${money(job.deliveryFee)}`] : []),
      ...(Number(job.discountAmount) > 0 ? [`Dto. ${job.promoCode ?? "PROMO"}  -${money(job.discountAmount)}`] : []),
      line,
      "DESGLOSE DE IVA:",
      ...vatRows.map(
        (v) => `IVA ${Number(v.rate).toFixed(0)}%  Base ${money(v.base)}  Cuota ${money(v.quota)}`
      ),
      `BASE IMPONIBLE: ${money(job.netAmount)}`,
      `TOTAL IVA: ${money(job.vatAmount)}`,
      `TOTAL (IVA INCL.): ${money(job.total)}`,
      line,
      pay,
      `${job.clientName} · ${job.streetType} ${job.streetName} ${job.streetNumber}`,
      `Veri*factu SHA-256: ${(job.fiscalHash ?? "").slice(0, 16).toUpperCase()}`,
      line,
      ""
    );
  }

  res.type("text/plain").send(sections.join("\n") + "\n\n");
});

printerRoutes.delete("/printer/:token/job", async (req, res) => {
  const p = await printerFor(req);
  if (!p) return res.sendStatus(404);
  const id = req.query.token ? String(req.query.token) : undefined;
  const job = await nextJob(p.restaurantId, id);
  if (job) {
    await prisma.order.update({ where: { id: job.id }, data: { printedAt: new Date(), printFailed: false } });
    await logEvent(job.id, "PRINTED");
  }
  res.sendStatus(200);
});
