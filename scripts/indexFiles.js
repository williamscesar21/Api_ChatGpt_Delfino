/* ----------------------------------------------------------------------
   Indexador – Genera embeddings a partir de Word/Excel en SharePoint
   -------------------------------------------------------------------- */

import fs   from "fs/promises";
import path from "path";
import { encoding_for_model } from "tiktoken";
import {
  listAllFiles,
  readFileContent,
} from "../services/fileService.js";
import { createEmbedding }    from "../services/embeddingsService.js";

/* =========  CONFIG  =================================================== */
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const MAX_TOKENS_EMB   = 8192;
const BATCH_ROWS       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

/* =========  TOKENS  =================================================== */
const enc          = encoding_for_model(process.env.EMBEDDING_MODEL || "text-embedding-3-large");
const countTokens  = (s) => enc.encode(s).length;

/* =========  SPLIT HELPERS  =========================================== */
function splitToFit(text) {
  const parts = [];
  const stack = [text];

  while (stack.length) {
    const chunk = stack.pop();
    if (countTokens(chunk) <= MAX_TOKENS_EMB) parts.push(chunk);
    else {
      const mid = Math.floor(chunk.length / 2);
      stack.push(chunk.slice(0, mid), chunk.slice(mid));
    }
  }
  return parts;
}

const chunkText = (s) => splitToFit(s);

/* -------- Excel → abajo-arriba | celda-a-celda ----------------------- */
function chunkExcel(book) {
  const chunks = [];
  const fits   = (t) => countTokens(t) <= MAX_TOKENS_EMB;

  for (const [sheet, rows] of Object.entries(book)) {
    let chunk = `Hoja: ${sheet}\n`;
    let added = 0;

    for (let r = rows.length - 1; r >= 0; r--) {
      const row = rows[r];

      for (const [col, raw] of Object.entries(row)) {
        const val = String(raw).trim();
        if (!val || val.length > 200) continue;

        const line = `Fila ${r + 1} Col ${col}: ${val}`;

        if (!fits(chunk + line + "\n")) {
          chunks.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
        chunk += line + "\n";

        if (++added % BATCH_ROWS === 0 && chunk.trim()) {
          chunks.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
      }
    }
    if (chunk.trim()) chunks.push(chunk);
  }
  return chunks.flatMap(splitToFit);
}

/* =========  MAIN  ===================================================== */
(async () => {
  await fs.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });
  const rowsOut = [];

  for (const file of await listAllFiles()) {
    console.log(`🗄  Procesando: ${file.path}`);

    try {
      const raw    = await readFileContent(file);
      const pieces = typeof raw === "string" ? chunkText(raw) : chunkExcel(raw);

      for (const [idx, text] of pieces.entries()) {
        const embedding = await createEmbedding(text);
        rowsOut.push({
          fileId:  file.id,
          path:    file.path,
          chunk:   idx,
          text,
          embedding,
        });
        console.log(`   ✅  ${file.name} [${idx}]`);
      }
    } catch (err) {
      console.error(`   ❌  ${file.name}: ${err.message}`);
    }
  }

  await fs.writeFile(VECTORSTORE_PATH, JSON.stringify(rowsOut, null, 2));
  console.log(`🗂  Vectorstore guardado (${rowsOut.length} chunks)`);
})();
