// server.js  (ESM)
import "dotenv/config";
import express  from "express";
import cors     from "cors";
import helmet   from "helmet";
import morgan   from "morgan";               // ← registro en consola

import { basicAuth }       from "./middleware/basicAuth.js";
import chatRoutes          from "./routes/chatRoutes.js";
import fileRoutes          from "./routes/fileRoutes.js";
import { loadVectorStore } from "./services/vectorStoreService.js";

/* ───────── preload vector-store ───────── */
await loadVectorStore();                     // lee ./vectorstore/index.json

/* ───────── app + middlewares ───────── */
const app = express();
app.use(helmet());
app.use(morgan("dev"));                      // GET /api/files 200 42 ms
app.use(express.json({ limit: "4mb" }));

/* ───────── CORS (refleja cualquier origen) ───────── */
const corsOptions = {
  origin: (_origin, cb) => cb(null, true),   // permite todos los orígenes
  credentials: true,                         // deja pasar Authorization
  methods: "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  allowedHeaders: "Origin,Content-Type,Authorization,Accept",
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));         // pre-flight

/* ───────── Basic-Auth después de CORS ───────── */
app.use(basicAuth);

/* ───────── rutas protegidas ───────── */
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

/* ───────── listen ───────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 API corriendo en http://localhost:${PORT}`)
);
