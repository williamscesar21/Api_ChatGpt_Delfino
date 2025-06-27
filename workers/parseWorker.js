// workers/parseWorker.js
import { parentPort } from 'worker_threads';
import fs from 'fs/promises';
import mammoth from 'mammoth';
import xlsx from 'xlsx';

parentPort.on('message', async ({ filePath, ext }) => {
  try {
    let content;
    if (ext === '.docx') {
      const { value } = await mammoth.extractRawText({ path: filePath });
      content = value.trim();
    } else if (ext === '.xlsx') {
      const workbook = xlsx.readFile(filePath);
      const sheets = {};
      workbook.SheetNames.forEach(name => {
        sheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
      });
      content = sheets;
    } else {
      throw new Error('Tipo no soportado');
    }
    parentPort.postMessage({ ok: true, content });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
});
