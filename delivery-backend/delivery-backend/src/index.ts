import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { ZodError } from "zod";
import { OrderError } from "./orders";
import { publicRoutes } from "./routes/public";
import { staff } from "./routes/staff";
import { printerRoutes } from "./routes/printer";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(publicRoutes);
app.use(staff);
app.use(printerRoutes);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: "VALIDATION", issues: err.issues });
  if (err instanceof OrderError) return res.status(err.status).json({ error: err.code });
  console.error(err);
  res.status(500).json({ error: "INTERNAL" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API listening on :${port}`));
