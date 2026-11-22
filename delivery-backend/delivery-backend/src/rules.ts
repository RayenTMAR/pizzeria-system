import { OpeningHour } from "@prisma/client";

/** Weekday (0 = Sunday) and minutes since local midnight in a timezone. */
export function localParts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  const minutes = (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10);
  return { weekday, minutes };
}

export type TimingResult =
  | { ok: true }
  | { ok: false; reason: "CLOSED" | "TOO_LATE" };

/**
 * Website rule: the restaurant must be open now, and
 * now + preparation + delivery time must not pass closing time + grace.
 * (Example: close 00:00 + 20 min grace = 00:20 limit.)
 */
export function checkOrderTiming(opts: {
  now: Date;
  timezone: string;
  hours: OpeningHour[];
  prepMinutes: number;
  etaMinutes: number;
  graceMinutesAfterClose: number;
}): TimingResult {
  const { weekday, minutes } = localParts(opts.now, opts.timezone);
  const slot = opts.hours.find(
    (h) => h.weekday === weekday && minutes >= h.openMin && minutes < h.closeMin
  );
  if (!slot) return { ok: false, reason: "CLOSED" };
  const arrival = minutes + opts.prepMinutes + opts.etaMinutes;
  if (arrival > slot.closeMin + opts.graceMinutesAfterClose) {
    return { ok: false, reason: "TOO_LATE" };
  }
  return { ok: true };
}

/** Start of the current working day (resets at dayResetHour, e.g. 02:00). */
export function workingDayStart(now: Date, tz: string, resetHour: number): Date {
  const { minutes } = localParts(now, tz);
  const since = (minutes - resetHour * 60 + 1440) % 1440;
  const d = new Date(now.getTime() - since * 60_000);
  d.setSeconds(0, 0);
  return d;
}
