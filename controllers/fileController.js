import { listAllFiles, readFileContent } from '../services/fileService.js';

// GET /files
export async function listFiles(req, res, next) {
  try {
    const files = await listAllFiles();
    res.json({ files });
  } catch (err) {
    next(err);
  }
}

// GET /files/:name/content
export async function getFileContent(req, res, next) {
  try {
    const { name } = req.params;
    const filesAvailable = await listAllFiles();
    if (!filesAvailable.includes(name))
      return res.status(404).json({ error: 'Archivo no encontrado' });

    const content = await readFileContent(name);
    res.json({ name, content });
  } catch (err) {
    next(err);
  }
}
