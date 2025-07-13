/* ------------------------------------------------------------------
   server.js  (ESM) – API pública, sin Basic-Auth ni Firebase guard
------------------------------------------------------------------ */
import "dotenv/config";
import express  from "express";
import cors     from "cors";
import helmet   from "helmet";
import morgan   from "morgan";

import chatRoutes          from "./routes/chatRoutes.js";
import fileRoutes          from "./routes/fileRoutes.js";
import { loadVectorStore } from "./services/vectorStoreService.js";

/* --------- precarga vector-store --------- */
await loadVectorStore();                     // lee ./vectorstore/index.json

/* --------- app + middlewares --------- */
const app = express();
app.use(helmet());
app.use(morgan("dev"));                      // ejemplo: GET /api/files 200 42 ms
app.use(express.json({ limit: "4mb" }));

/* --------- CORS (permite cualquier origen) --------- */
const corsOptions = {
  origin: (_origin, cb) => cb(null, true),
  credentials: true,
  methods: "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  allowedHeaders: "Origin,Content-Type,Authorization,Accept",
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));         // pre-flight

/* --------- rutas públicas --------- */
app.use("/api", chatRoutes);   // /api/chat…
app.use("/api", fileRoutes);   // /api/files, /api/files/reindex…

/* healthcheck */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* 404 */
app.use((_req, res) =>
  res.status(404).json({ error: "Ruta no encontrada" })
);

/* error global */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Error interno"
        : err.message || "Error interno",
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
  });
});

/* --------- listen --------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 API corriendo en http://localhost:${PORT}`)
);
