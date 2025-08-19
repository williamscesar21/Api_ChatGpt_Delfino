import { Router }     from "express";
import { spawn }      from "child_process";
import path           from "path";
import { listAllFiles } from "../services/fileService.js";

const router = Router();

/* ---------- GET /api/files   → lista los archivos -------------------- */
router.get("/files", async (_req, res) => {
  try {
    const files = await listAllFiles();
    res.json(files);
  } catch (err) {
    console.error("GET /files error:", err);
    res.status(500).json({ error: "Cannot list files" });
  }
});

/* ---------- POST /api/files/reindex   → dispara npm run index -------- */
router.post("/files/reindex", (_req, res) => {
  try {
    /* 1️⃣  lanza el comando */
    const cmd   = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(
      cmd,
      ["run", "index"],                       // = npm run index
      {
        cwd:      path.resolve("."),          // raíz del proyecto
        detached: true,                       // se independiza del proceso web
        stdio:    "ignore",                   // no ocupa stdout de Express
        env: {
          ...process.env,
          NODE_OPTIONS: "--max-old-space-size=12288", // heap extra solo al job
        },
      }
    );

    child.unref();        // deja correr al hijo aunque Express termine

    /* 2️⃣  responde de inmediato */
    res.status(202).json({ ok: true, msg: "Reindex started" });
  } catch (err) {
    console.error("POST /files/reindex spawn error:", err);
    res.status(500).json({ error: "Cannot start reindex job" });
  }
});

export default router;
