# Client website (Next.js)

Guest checkout for one restaurant (Spanish only). Menu, cart, structured address, cash or card on delivery,
"closed" message, estimated time before ordering, and a live tracking page.

## Run
1. `cp .env.example .env.local` and set `NEXT_PUBLIC_API_BASE` (the backend) and `NEXT_PUBLIC_RESTAURANT_SLUG`
2. `npm install`
3. `npm run dev`  -> http://localhost:3001      (production: `npm run build && npm start`)

The backend must be running (see delivery-backend). Its CORS is open in development;
in production restrict it to this site's domain.

## Pages
- `/`  menu + checkout. Calls `GET /public/:slug/menu`, `POST /public/:slug/quote` (zone, hours, estimated time),
  `POST /public/:slug/orders`.
- `/pedido/[token]`  tracking (refreshes every 10 s): status, repartidor's first name and arrival estimate when on the way,
  cancellation reason if cancelled, and a 1-5 star rating form with a comment once delivered. The token is the private link, so guests need no account.

## Not yet
Optional client accounts (saved addresses, history, reorder),
one site per restaurant by sub-domain (today the restaurant is chosen with the env variable).
