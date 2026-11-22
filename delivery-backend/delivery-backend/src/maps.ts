export interface Route {
  km: number;
  minutes: number;
}

/** Road distance and travel time from the restaurant to an address. */
export async function roadRoute(
  origin: { lat: number; lng: number },
  destinationAddress: string
): Promise<Route> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    // Development mode: fixed values
    return {
      km: Number(process.env.MOCK_KM ?? 4),
      minutes: Number(process.env.MOCK_MINUTES ?? 12),
    };
  }
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { address: destinationAddress },
      travelMode: "DRIVE",
    }),
  });
  if (!res.ok) throw new Error(`routes api ${res.status}`);
  const data = (await res.json()) as {
    routes?: { distanceMeters: number; duration: string }[];
  };
  const r = data.routes?.[0];
  if (!r) throw new Error("ADDRESS_NOT_FOUND");
  return {
    km: r.distanceMeters / 1000,
    minutes: Math.ceil(parseInt(r.duration, 10) / 60), // "725s"
  };
}
