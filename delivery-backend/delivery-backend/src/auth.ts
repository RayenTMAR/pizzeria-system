import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";

export interface AuthUser {
  id: string;
  role: Role;
  restaurantId: string;
}

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
};

export const signToken = (u: AuthUser) =>
  jwt.sign({ sub: u.id, role: u.role, rid: u.restaurantId }, secret(), { expiresIn: "30d" });

export const signClientToken = (c: { id: string; restaurantId: string }) =>
  jwt.sign({ sub: c.id, kind: "CLIENT", rid: c.restaurantId }, secret(), { expiresIn: "90d" });

export const verifyClientToken = (header?: string): { id: string; restaurantId: string } | null => {
  if (!header || !header.startsWith("Bearer ")) return null;
  try {
    const p = jwt.verify(header.slice(7), secret()) as { sub: string; kind?: string; rid: string };
    if (p.kind !== "CLIENT") return null;
    return { id: p.sub, restaurantId: p.rid };
  } catch {
    return null;
  }
};

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

/** Requires a valid token and one of the given roles. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      const p = jwt.verify(token, secret()) as { sub: string; role: Role; rid: string };
      if (!roles.includes(p.role)) return res.status(403).json({ error: "forbidden" });
      req.user = { id: p.sub, role: p.role, restaurantId: p.rid };
      next();
    } catch {
      res.status(401).json({ error: "unauthorized" });
    }
  };
