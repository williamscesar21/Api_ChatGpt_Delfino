// routes/fileRoutes.js
import { Router } from 'express';
import { listAllFiles } from '../services/fileService.js';

const router = Router();

/* GET /api/files  →  lista completa [{ id, name, path, webUrl }] */
router.get('/files', async (_req, res) => {
  try {
    const files = await listAllFiles();
    res.json(files);
  } catch (err) {
    console.error('GET /files error:', err);
    res.status(500).json({ error: 'Cannot list files' });
  }
});

export default router;
