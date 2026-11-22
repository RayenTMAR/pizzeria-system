export interface Route {
  km: number;
  minutes: number;
  lat?: number;
  lng?: number;
}

function mockCoordsForAddress(origin: { lat: number; lng: number }, address: string) {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = (hash * 31 + address.charCodeAt(i)) | 0;
  }
  const latOffset = (((Math.abs(hash) % 100) / 100) * 0.016 - 0.008) || 0.008;
  const lngOffset = (((Math.abs(hash >> 4) % 100) / 100) * 0.016 - 0.008) || -0.006;
  return {
    lat: Number((origin.lat + latOffset).toFixed(6)),
    lng: Number((origin.lng + lngOffset).toFixed(6)),
  };
}

/** Road distance and travel time from the restaurant to an address. */
export async function roadRoute(
  origin: { lat: number; lng: number },
  destinationAddress: string
): Promise<Route> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    // Development mode: fixed distance/time with deterministic coords
    const coords = mockCoordsForAddress(origin, destinationAddress);
    return {
      km: Number(process.env.MOCK_KM ?? 4),
      minutes: Number(process.env.MOCK_MINUTES ?? 12),
      lat: coords.lat,
      lng: coords.lng,
    };
  }
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.legs.endLocation",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { address: destinationAddress },
      travelMode: "DRIVE",
    }),
  });
  if (!res.ok) throw new Error(`routes api ${res.status}`);
  const data = (await res.json()) as {
    routes?: {
      distanceMeters: number;
      duration: string;
      legs?: { endLocation?: { latLng?: { latitude: number; longitude: number } } }[];
    }[];
  };
  const r = data.routes?.[0];
  if (!r) throw new Error("ADDRESS_NOT_FOUND");
  const endLatLng = r.legs?.[r.legs.length - 1]?.endLocation?.latLng;
  return {
    km: r.distanceMeters / 1000,
    minutes: Math.ceil(parseInt(r.duration, 10) / 60), // "725s"
    lat: endLatLng?.latitude,
    lng: endLatLng?.longitude,
  };
}

export interface RouteStop {
  id: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Optimizes stop order for 2-4 active orders starting from the restaurant.
 * Uses Google Routes API (optimizeWaypointOrder) when key is configured,
 * falling back to nearest-neighbor Euclidean ordering in dev/offline mode.
 */
export async function optimizeMultiStopRoute(
  origin: { lat: number; lng: number },
  stops: RouteStop[]
): Promise<string[]> {
  if (stops.length < 2) return stops.map((s) => s.id);
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key) {
    try {
      const toWaypoint = (s: RouteStop) =>
        s.lat != null && s.lng != null
          ? { location: { latLng: { latitude: s.lat, longitude: s.lng } } }
          : { address: s.address };

      const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "routes.optimizedIntermediateWaypointIndex",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
          destination: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
          intermediates: stops.map(toWaypoint),
          travelMode: "DRIVE",
          optimizeWaypointOrder: true,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          routes?: { optimizedIntermediateWaypointIndex?: number[] }[];
        };
        const order = data.routes?.[0]?.optimizedIntermediateWaypointIndex;
        if (order && order.length === stops.length) {
          return order.map((idx) => stops[idx].id);
        }
      }
    } catch {
      /* fallback to local nearest-neighbor sort */
    }
  }

  // Nearest-neighbor greedy ordering from restaurant origin
  const remaining = stops.map((s) => {
    const c = s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : mockCoordsForAddress(origin, s.address);
    return { id: s.id, lat: c.lat, lng: c.lng };
  });
  const ordered: string[] = [];
  let cur = { lat: origin.lat, lng: origin.lng };
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const dx = remaining[i].lat - cur.lat;
      const dy = remaining[i].lng - cur.lng;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push(picked.id);
    cur = { lat: picked.lat, lng: picked.lng };
  }
  return ordered;
}
