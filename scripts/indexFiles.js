import fs   from "fs/promises";
import path from "path";
import { encoding_for_model }   from "tiktoken";
import { listAllFiles, readFileContent } from "../services/fileService.js";
import { createEmbedding }      from "../services/embeddingsService.js";

/* =========  PARÁMETROS  =============================================== */
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const MAX_TOKENS_EMB   = 8192;                         // límite del modelo
const BATCH_ROWS       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

/* tiktoken encoder para el modelo de embeddings */
const enc = encoding_for_model(process.env.EMBEDDING_MODEL || "text-embedding-3-large");

/* =========  HELPERS  ================================================== */
const countTokens = (str) => enc.encode(str).length;

/* divide por la mitad hasta que quepa */
function splitToFit(text) {
  const parts = [];
  const stack = [text];

  while (stack.length) {
    const chunk = stack.pop();
    if (countTokens(chunk) <= MAX_TOKENS_EMB) {
      parts.push(chunk);
    } else {
      const mid = Math.floor(chunk.length / 2);
      stack.push(chunk.slice(0, mid), chunk.slice(mid));
    }
  }
  return parts;
}

function chunkText(str) { return splitToFit(str); }

function chunkExcel(book) {
  const out = [];
  const fits = (t) => countTokens(t) <= MAX_TOKENS_EMB;

  for (const [sheet, rows] of Object.entries(book)) {
    // Recorremos la hoja de abajo → arriba
    let chunk = `Hoja: ${sheet}\n`;
    let added = 0;

    for (let r = rows.length - 1; r >= 0; r--) {
      const row = rows[r];

      // Recorremos cada celda de la fila (izq → der)
      for (const [col, raw] of Object.entries(row)) {
        const value = String(raw).trim();
        if (!value || value.length > 200) continue;   // filtrado básico

        // Ejemplo: "Fila 42 Col B: Tornillo M6 x 20 mm"
        const line = `Fila ${r + 1} Col ${col}: ${value}`;

        // Si agregar la línea supera el límite, corta el chunk
        if (!fits(chunk + line + "\n")) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
        chunk += line + "\n";

        // Volcado por lotes para evitar chunks enormes
        if (++added % BATCH_ROWS === 0 && chunk.trim()) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
        }
      }
    }

    if (chunk.trim()) out.push(chunk);
  }

  // Re-verifica cada trozo por si quedó alguno muy grande
  return out.flatMap(splitToFit);
}


/* =========  EXEC  ===================================================== */
(async () => {
  await fs.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });
  const rowsOut = [];

  for (const file of await listAllFiles()) {
    console.log(`🗄  Procesando: ${file.path}`);
    try {
      const raw    = await readFileContent(file);
      const chunks = typeof raw === "string" ? chunkText(raw) : chunkExcel(raw);

      for (const [i, text] of chunks.entries()) {
        const embedding = await createEmbedding(text);
        rowsOut.push({ fileId: file.id, path: file.path, chunk: i, text, embedding });
        console.log(`   ✅  ${file.name} [${i}]`);
      }
    } catch (err) {
      console.error(`   ❌  ${file.name}: ${err.message}`);
    }
  }

  await fs.writeFile(VECTORSTORE_PATH, JSON.stringify(rowsOut, null, 2));
  console.log(`🗂  Vectorstore guardado (${rowsOut.length} chunks)`);
})();
