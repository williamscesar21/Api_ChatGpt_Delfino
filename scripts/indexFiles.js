import fs from 'fs/promises';
import path from 'path';
import { listAllFiles, readFileContent } from '../services/fileService.js';
import { createEmbedding } from '../services/embeddingsService.js';

/* parámetros */
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || './vectorstore/index.json';
const MAX_TOKENS   = +process.env.MAX_TOKENS_PER_CHUNK  || 6000;
const CHAR_PER_TOK = +process.env.CHARS_PER_TOKEN       || 4;
const MAX_CHARS    = MAX_TOKENS * CHAR_PER_TOK;              // ≈ 24 000
const BATCH_ROWS   = +process.env.BATCH_ROWS_PER_CHUNK  || 200;

await fs.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });

const rowsOut = [];

for (const file of await listAllFiles()) {
  const raw = await readFileContent(file);
  const chunks = typeof raw === 'string' ? chunkText(raw) : chunkExcel(raw);

  for (const [i, text] of chunks.entries()) {
    const safe = text.slice(0, MAX_CHARS);        // recorte defensivo
    try {
      const embedding = await createEmbedding(safe);
      rowsOut.push({ file, chunk: i, text: safe, embedding });
      console.log(`✅ ${file} [${i}]`);
    } catch (err) {
      console.error(`❌ ${file} [${i}] → ${err.message}`);
    }
  }
}

await fs.writeFile(VECTORSTORE_PATH, JSON.stringify(rowsOut));
console.log(`🗂  Vectorstore guardado (${rowsOut.length} chunks)`);

/* helpers */
function chunkText(str) {
  const out = [];
  for (let i = 0; i < str.length; i += MAX_CHARS) {
    out.push(str.slice(i, i + MAX_CHARS));
  }
  return out;
}

function chunkExcel(book) {
  const out = [];
  for (const [sheet, rows] of Object.entries(book)) {
    let chunk = `Hoja: ${sheet}\n`;
    let added = 0;

    for (const row of rows) {
      const line = Object.values(row)
        .map(String)
        .map(v => v.trim())
        .filter(v => v && v.length < 200)
        .join(' | ');

      if (!line) continue;

      if (chunk.length + line.length + 1 > MAX_CHARS) {
        out.push(chunk);
        chunk = `Hoja: ${sheet} (cont.)\n`;
      }

      chunk += line + '\n';
      added++;

      if (added % BATCH_ROWS === 0 && chunk.trim()) {
        out.push(chunk);
        chunk = `Hoja: ${sheet} (cont.)\n`;
      }
    }
    if (chunk.trim()) out.push(chunk);
  }
  return out;
}
