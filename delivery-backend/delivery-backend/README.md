# Delivery backend (MVP)

Node.js + TypeScript + Express + Prisma + PostgreSQL. Multi-restaurant (every table is scoped by `restaurantId`).

## Run it
1. `cp .env.example .env` and set `DATABASE_URL`, `JWT_SECRET`, `SEED_JEFE_PASSWORD`
2. `npm install`
3. `npx prisma db push`   (creates the tables)
4. `npm run db:seed`      (demo restaurant, jefe, 2 riders, menu, printer token)
5. `npm run dev`          (http://localhost:3000)

Without `GOOGLE_MAPS_API_KEY`, distance/time are mocked (`MOCK_KM`, `MOCK_MINUTES`).

## Main endpoints
Website (no login): `GET /public/:slug/menu`, `POST /public/:slug/orders`, `GET /public/orders/:token`
Staff login: `POST /auth/login` -> JWT (role decides jefe / repartidor)
Jefe: `GET /orders`, `POST /orders` (manual), `POST /orders/:id/cancel|ready|assign|reprint`,
      `GET /riders`, `POST /shifts/open`, `POST /shifts/:id/close|settle`, `GET /shifts`, `GET /shifts/:id/summary`
Repartidor: `GET /orders` (own trip), `POST /orders/:id/delivered`, `PATCH /orders/:id/address`,
      `GET /me/shift`, `POST /me/ready`
Printer (CloudPRNT style): `POST|GET|DELETE /printer/:token/poll|job`

## Rules enforced on the server
Opening hours, closing cutoff (close + grace), delivery zone (road km), structured address,
cash amount required on the website, max 4 orders per trip, shift required to receive orders,
"ready to deliver" only while coming back, rider status derived from his orders,
day reset hour for today's lists, card payments listed one by one (never summed).

## Not in the MVP yet
Live push (WebSockets / FCM): apps poll `GET /orders` and `GET /riders` for now.
Client accounts, ratings, route optimization, owner (platform) login, row-level security.
Orders are isolated by `restaurantId` in every query; add Postgres RLS before selling to other restaurants.
