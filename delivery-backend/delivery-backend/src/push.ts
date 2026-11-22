import admin from "firebase-admin";
import { prisma } from "./db";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

let ready = false;
function init(): boolean {
  if (ready) return true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return false;
  try {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    ready = true;
  } catch (e) {
    console.error("Firebase init failed", e);
  }
  return ready;
}

async function sendGroup(tokens: string[], msg: PushMessage) {
  if (!init()) {
    console.log(`[push disabled] "${msg.title}" -> ${tokens.length} device(s)`);
    return;
  }
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    data: msg.data,
    // "orders" is the high-importance channel the app creates on Android
    android: { priority: "high", notification: { channelId: "orders", sound: "default" } },
    apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
  });
  // forget tokens that no longer exist (app uninstalled, token rotated)
  const dead: string[] = [];
  res.responses.forEach((r, i) => {
    const code = r.error?.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      dead.push(tokens[i]);
    }
  });
  if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
}

/** Sends to every device of the given users, in each user's language. */
export async function pushToUsers(userIds: string[], build: (lang: string) => PushMessage) {
  if (userIds.length === 0) return;
  const devices = await prisma.deviceToken.findMany({
    where: { userId: { in: userIds } },
    include: { user: { select: { language: true } } },
  });
  const byLang = new Map<string, string[]>();
  for (const d of devices) {
    const lang = d.user.language === "en" ? "en" : "es";
    byLang.set(lang, [...(byLang.get(lang) ?? []), d.token]);
  }
  for (const [lang, tokens] of byLang) await sendGroup(tokens, build(lang));
}

export async function pushToJefes(restaurantId: string, build: (lang: string) => PushMessage) {
  const jefes = await prisma.user.findMany({
    where: { restaurantId, role: "JEFE", active: true },
    select: { id: true },
  });
  await pushToUsers(jefes.map((j) => j.id), build);
}
