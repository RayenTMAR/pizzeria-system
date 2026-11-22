import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

const prisma = new PrismaClient();

async function main() {
  const password = process.env.SEED_JEFE_PASSWORD;
  if (!password) throw new Error("Set SEED_JEFE_PASSWORD in .env first");
  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await prisma.restaurant.findUnique({ where: { slug: "demo" } });
  if (existing) {
    await prisma.$transaction([
      prisma.chatMessage.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.rating.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { restaurantId: existing.id } } } }),
      prisma.order.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.client.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.shift.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.deviceToken.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.productModifierGroup.deleteMany({ where: { product: { restaurantId: existing.id } } }),
      prisma.modifierOption.deleteMany({ where: { modifierGroup: { restaurantId: existing.id } } }),
      prisma.modifierGroup.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.deliveryZone.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.promoCode.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.product.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.category.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.user.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.printer.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.openingHour.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.restaurantSettings.deleteMany({ where: { restaurantId: existing.id } }),
      prisma.restaurant.delete({ where: { id: existing.id } }),
    ]);
  }

  const r = await prisma.restaurant.create({
    data: {
      name: "Pizzería Demo",
      slug: "demo",
      // Replace lat/lng with the real restaurant location (León centre as placeholder)
      settings: { create: { lat: 42.5987, lng: -5.5671, city: "León" } },
      // Every day 13:00 - 00:00 (continuous)
      hours: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, openMin: 13 * 60, closeMin: 1440 })),
      },
      printers: { create: { name: "Cocina", token: randomBytes(24).toString("hex") } },
      users: {
        create: [
          { role: "JEFE", name: "Jefe", email: "jefe@demo.test", passwordHash },
          { role: "REPARTIDOR", name: "Repartidor Uno", email: "rep1@demo.test", passwordHash, language: "en" },
          { role: "REPARTIDOR", name: "Repartidor Dos", email: "rep2@demo.test", passwordHash },
        ],
      },
    },
    include: { printers: true },
  });
  const pizzas = await prisma.category.create({ data: { restaurantId: r.id, name: "Pizzas" } });
  const kebab = await prisma.category.create({ data: { restaurantId: r.id, name: "Kebab", position: 1 } });

  const margarita = await prisma.product.create({
    data: {
      restaurantId: r.id,
      categoryId: pizzas.id,
      name: "Margarita",
      description: "Tomate, mozzarella y albahaca",
      price: 8.5,
      allergens: ["GLUTEN", "MILK"],
      vatRate: 10.0,
    },
  });
  const cuatroQuesos = await prisma.product.create({
    data: {
      restaurantId: r.id,
      categoryId: pizzas.id,
      name: "Cuatro quesos",
      description: "Mozzarella, gorgonzola, emmental y parmesano",
      price: 10,
      allergens: ["GLUTEN", "MILK"],
      vatRate: 10.0,
    },
  });
  await prisma.product.create({
    data: {
      restaurantId: r.id,
      categoryId: kebab.id,
      name: "Kebab de pollo",
      description: "Pollo asado, lechuga, tomate y salsa yogur",
      price: 6.5,
      allergens: ["GLUTEN", "MILK", "EGGS", "SESAME"],
      vatRate: 10.0,
    },
  });

  const sizeGroup = await prisma.modifierGroup.create({
    data: {
      restaurantId: r.id,
      name: "Tamaño",
      minSelections: 1,
      maxSelections: 1,
      sortOrder: 0,
      options: {
        create: [
          { name: "Mediana", priceDelta: 0, sortOrder: 0 },
          { name: "Familiar", priceDelta: 3.5, sortOrder: 1 },
        ],
      },
    },
  });

  const extrasGroup = await prisma.modifierGroup.create({
    data: {
      restaurantId: r.id,
      name: "Extras",
      minSelections: 0,
      maxSelections: 3,
      sortOrder: 1,
      options: {
        create: [
          { name: "Extra queso", priceDelta: 1.5, sortOrder: 0 },
          { name: "Bacon", priceDelta: 1.5, sortOrder: 1 },
        ],
      },
    },
  });

  await prisma.productModifierGroup.createMany({
    data: [
      { productId: margarita.id, modifierGroupId: sizeGroup.id, sortOrder: 0 },
      { productId: margarita.id, modifierGroupId: extrasGroup.id, sortOrder: 1 },
      { productId: cuatroQuesos.id, modifierGroupId: sizeGroup.id, sortOrder: 0 },
      { productId: cuatroQuesos.id, modifierGroupId: extrasGroup.id, sortOrder: 1 },
    ],
  });

  await prisma.promoCode.create({
    data: {
      restaurantId: r.id,
      code: "BIENVENIDA",
      discountType: "PERCENTAGE",
      discountValue: 10,
      minOrderAmount: 0,
      isActive: true,
    },
  });

  console.log("Seeded restaurant", r.slug, "- printer token:", r.printers[0].token);
}

main().finally(() => prisma.$disconnect());
