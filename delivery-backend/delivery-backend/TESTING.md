# End-to-end test (about 15 minutes)

You need: PostgreSQL running, `jq` installed, and the backend started (`npm run dev`, see README).
Without a Google Maps key, distance/time are mocked (4 km, 12 min).

> The website only accepts orders between 13:00 and 00:00 (and not too close to closing).
> Outside those hours step 3 returns `CLOSED`: either test during opening hours, or place the order
> with the jefe's manual order (step 3b), which skips the timing rules.

```bash
API=http://localhost:3000

# 0. Seed prints the printer token. Copy it:   npm run db:seed
PRINTER=<token printed by the seed>
PRODUCT=$(curl -s $API/public/demo/menu | jq -r '.categories[0].products[0].id')

# 1. Menu + open/closed flag
curl -s $API/public/demo/menu | jq '{open, categories: [.categories[].name]}'

# 2. Quote: zone + hours + estimated time
curl -s -X POST $API/public/demo/quote -H 'Content-Type: application/json' \
  -d '{"streetType":"avenida","streetName":"de Mariano Andrés","streetNumber":"143","postalCode":"24008"}'

# 3. Website order (cash, pays with 20 EUR)
curl -s -X POST $API/public/demo/orders -H 'Content-Type: application/json' -d "{
  \"clientName\":\"Cliente Prueba\",\"clientPhone\":\"600000000\",
  \"streetType\":\"avenida\",\"streetName\":\"de Mariano Andrés\",\"streetNumber\":\"143\",\"postalCode\":\"24008\",
  \"floor\":\"5\",\"door\":\"B\",\"notes\":\"Llámame al llegar\",
  \"paymentMethod\":\"CASH\",\"cashAmount\":20,
  \"items\":[{\"productId\":\"$PRODUCT\",\"quantity\":2}]}" | tee /tmp/order.json
TOKEN=$(jq -r .trackingToken /tmp/order.json)

# 3b. (alternative) manual order by the jefe: see step 5 for JEFE, then POST $API/orders with the same body

# 4. Kitchen printer: poll -> job -> printed
curl -s -X POST $API/printer/$PRINTER/poll
curl -s $API/printer/$PRINTER/job
curl -s -X DELETE $API/printer/$PRINTER/job -o /dev/null -w '%{http_code}\n'
curl -s -X POST $API/printer/$PRINTER/poll        # jobReady must now be false

# 5. Jefe logs in (password = SEED_JEFE_PASSWORD) and sees the order
JEFE=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"jefe@demo.test","password":"<SEED_JEFE_PASSWORD>"}' | jq -r .token)
curl -s $API/orders -H "Authorization: Bearer $JEFE" | jq '.[] | {number,status,total}'
ORDER=$(curl -s $API/orders -H "Authorization: Bearer $JEFE" | jq -r '.[0].id')

# 6. Kitchen done -> ready
curl -s -X POST $API/orders/$ORDER/ready -H "Authorization: Bearer $JEFE"

# 7. Open a shift for rider 1 (change given: 30 EUR). Rider joins the queue as available
RIDER=$(curl -s $API/staff/riders -H "Authorization: Bearer $JEFE" | jq -r '.[0].id')
curl -s -X POST $API/shifts/open -H "Authorization: Bearer $JEFE" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$RIDER\",\"changeGiven\":30}"
curl -s $API/riders -H "Authorization: Bearer $JEFE" | jq        # suggestedRiderId = $RIDER

# 8. Assign
curl -s -X POST $API/orders/$ORDER/assign -H "Authorization: Bearer $JEFE" -H 'Content-Type: application/json' \
  -d "{\"repartidorId\":\"$RIDER\"}"

# 9. Rider logs in, sees his trip and the status
REP=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"rep1@demo.test","password":"<SEED_JEFE_PASSWORD>"}' | jq -r .token)
curl -s $API/orders -H "Authorization: Bearer $REP" | jq '.[] | {number,stopNumber,clientName}'
curl -s $API/me/shift -H "Authorization: Bearer $REP"            # status DELIVERING
curl -s $API/public/orders/$TOKEN                                  # ON_THE_WAY + repartidorName

# 10. Delivered -> status becomes COMING_BACK -> "ready to deliver"
curl -s -X POST $API/orders/$ORDER/delivered -H "Authorization: Bearer $REP"
curl -s $API/me/shift -H "Authorization: Bearer $REP"            # COMING_BACK
curl -s -X POST $API/me/ready -H "Authorization: Bearer $REP"    # back in the queue
curl -s -X POST $API/me/ready -H "Authorization: Bearer $REP"    # must fail: NOT_COMING_BACK

# 11. Rating from the tracking link, then visible to staff
curl -s -X POST $API/public/orders/$TOKEN/rating -H 'Content-Type: application/json' -d '{"score":5,"comment":"Todo perfecto"}'
curl -s -X POST $API/public/orders/$TOKEN/rating -H 'Content-Type: application/json' -d '{"score":1}'   # ALREADY_RATED
curl -s $API/ratings -H "Authorization: Bearer $REP" | jq

# 12. Close the shift and look at the cash summary (cash 2 x price + 30 change)
SHIFT=$(curl -s $API/riders -H "Authorization: Bearer $JEFE" | jq -r '.riders[0].shiftId')
curl -s -X POST $API/shifts/$SHIFT/close -H "Authorization: Bearer $JEFE" -o /dev/null
curl -s $API/shifts/$SHIFT/summary -H "Authorization: Bearer $JEFE" | jq
curl -s -X POST $API/shifts/$SHIFT/settle -H "Authorization: Bearer $JEFE" -H 'Content-Type: application/json' -d '{"settlement":"BALANCED"}'
```

Things that must fail (each returns an `error` code): an address too far (set `MOCK_KM=50`) -> `OUT_OF_ZONE`;
assigning a 5th order to one rider -> `RIDER_FULL`; closing a shift with orders on the way -> `RIDER_HAS_ORDERS`;
cash amount below the total -> `CASH_AMOUNT_TOO_LOW`; a repartidor calling a jefe endpoint -> 403.
