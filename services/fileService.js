import fs from 'fs/promises';
import path from 'path';
import mammoth from 'mammoth';
import xlsx from 'xlsx';
import { runInWorker } from './workerPool.js';

const { FILES_DIR = './files' } = process.env;
const MAX_SYNC_SIZE = Number(process.env.MAX_SYNC_SIZE || 1_048_576); // 1 MB

// ---------- utilidades internas --------------------
function ext(file) {
  return path.extname(file).toLowerCase();
}
async function size(filePath) {
  return (await fs.stat(filePath)).size;
}

// ---------------- API pública -----------------------

export async function listAllFiles() {
  const files = await fs.readdir(FILES_DIR);
  return files.filter(f => ['.docx', '.xlsx'].includes(ext(f)));
}

/**
 * Lee y parsea un archivo. Si es grande (>MAX_SYNC_SIZE) se
 * delega a un Worker Thread para no bloquear el event-loop.
 */
export async function readFileContent(fileName) {
  const filePath = path.join(FILES_DIR, fileName);
  const filesize = await size(filePath);

  // --- Caso «grande» → Worker ------------------------------------------
  if (filesize > MAX_SYNC_SIZE) {
    return await runInWorker({ filePath, ext: ext(fileName) });
  }

  // --- Caso «pequeño» → hilo principal ---------------------------------
  if (fileName.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value.trim();
  }

  if (fileName.endsWith('.xlsx')) {
    const workbook = xlsx.readFile(filePath);
    const sheets = {};
    workbook.SheetNames.forEach(name => {
      sheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
    });
    return sheets;
  }

  throw new Error('Tipo de archivo no soportado');
}
