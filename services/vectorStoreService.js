// services/vectorStoreService.js
import fs   from 'fs/promises';
import path from 'path';

let rows = [];                            // [{ file, chunk, text, embedding }]
export function getRows() { return rows; }

export async function loadVectorStore(
  file = process.env.VECTORSTORE_PATH || './vectorstore/index.json'
) {
  const abs = path.resolve(file);
  rows = JSON.parse(await fs.readFile(abs, 'utf8'));
  console.log(`🔎 Vectorstore cargado (${rows.length} chunks)`);
}
