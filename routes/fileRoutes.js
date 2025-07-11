import { Router } from "express";
import { listAllFiles } from "../services/fileService.js";
import { reindexVectorStore } from "../services/vectorStoreService.js";

const router = Router();

/* GET /api/files → lista todos los archivos */
router.get("/files", async (_req, res) => {
  try {
    const files = await listAllFiles();
    res.json(files);
  } catch (err) {
    console.error("GET /files error:", err);
    res.status(500).json({ error: "Cannot list files" });
  }
});

/* POST /api/files/reindex → reconstruye el vector-store */
router.post("/files/reindex", async (_req, res) => {
  try {
    await reindexVectorStore();          // función mostrada más abajo
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /files/reindex error:", err);
    res.status(500).json({ error: "Cannot reindex files" });
  }
});

export default router;
