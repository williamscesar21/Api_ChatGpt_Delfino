// services/vectorStoreService.js
import fs   from "fs/promises";
import path from "path";
import { listAllFiles, getFileText } from "./fileService.js";
import { createEmbedding } from "./embeddingsService.js";

/* ───────── configuración ───────── */
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const EMBEDDING_MODEL  = process.env.EMBEDDING_MODEL  || "text-embedding-3-large";
const MAX_CHARS_CHUNK  = 16_000;                       // ≈ 8 k tokens “a ojo”
const BATCH_SIZE       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

/* ───────── estado en memoria ───────── */
let rows = [];   // [{ file, chunk, text, embedding }]
export function getRows() { return rows; }

/* ───────── carga inicial ───────── */
export async function loadVectorStore(file = VECTORSTORE_PATH) {
  try {
    const abs = path.resolve(file);
    rows = JSON.parse(await fs.readFile(abs, "utf8"));
    console.log(`🔎 Vector-store cargado (${rows.length} chunks)`);
  } catch {
    console.warn("⚠️  No se encontró index.json; se generará cuando reindexes");
    rows = [];
  }
}

/* ───────── guarda en disco ───────── */
async function saveVectorStore(file = VECTORSTORE_PATH) {
  const abs = path.resolve(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(rows, null, 2), "utf8");
  console.log("💾 Vector-store guardado en", abs);
}

/* ------------------------------------------------------------------ */
/*  Troceo sencillo SIN tiktoken:                                     */
/*  - Agrupa párrafos hasta alcanzar ~MAX_CHARS_CHUNK caracteres.     */
/*  - Si un párrafo excede el límite, se corta a trozos de tamaño fijo.*/
function simpleSplit(text, maxChars = MAX_CHARS_CHUNK) {
  const paragraphs = text.split(/\n+/);
  const chunks = [];
  let buffer = "";

  for (const p of paragraphs) {
    // Si cabe el párrafo actual en el buffer…
    if (buffer.length + p.length + 1 <= maxChars) {
      buffer += (buffer ? "\n" : "") + p;
      continue;
    }

    // Guarda el buffer lleno
    if (buffer) {
      chunks.push(buffer);
      buffer = "";
    }

    // Si el párrafo es más grande que el límite, córtalo en rebanadas
    if (p.length > maxChars) {
      for (let i = 0; i < p.length; i += maxChars) {
        chunks.push(p.slice(i, i + maxChars));
      }
    } else {
      buffer = p;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}
/* ------------------------------------------------------------------ */

/* ───────── reconstrucción (POST /files/reindex) ───────── */
export async function reindexVectorStore() {
  console.time("⏱  Reindex");
  const files = await listAllFiles();
  console.log(`📁 ${files.length} archivos encontrados`);

  const newRows = [];
  for (const f of files) {
    const text = await getFileText(f);
    if (!text?.trim()) continue;

    const chunks = simpleSplit(text);           // ← sin tiktoken
    for (let i = 0; i < chunks.length; i++) {
      newRows.push({
        file: f.name,
        chunk: i,
        text: chunks[i],
        embedding: null,
      });
    }
  }

  /* ----- embeddings por lotes ----- */
  console.log(`🧩 Generando embeddings (${newRows.length} chunks)…`);
  for (let i = 0; i < newRows.length; i += BATCH_SIZE) {
    const slice = newRows.slice(i, i + BATCH_SIZE);
    const emb = await createEmbedding(slice.map((r) => r.text));
    slice.forEach((r, idx) => (r.embedding = emb[idx]));
    process.stdout.write(`\r   · ${Math.min(i + BATCH_SIZE, newRows.length)}/${newRows.length}`);
  }
  console.log("\n✅ Embeddings completados");

  rows = newRows;
  await saveVectorStore();
  console.timeEnd("⏱  Reindex");
}
