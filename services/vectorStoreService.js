// services/vectorStoreService.js
import fs   from "fs/promises";
import path from "path";
import { listAllFiles, getFileText } from "./fileService.js";
import { createEmbedding } from "./embeddingsService.js";
import { splitToFit } from "../utils/textChunker.js"; // tu helper para trocear
import { encoding_for_model } from "tiktoken";        // opcional, para countTokens

/* ──────────────────────────────────────────────
   Configuración
───────────────────────────────────────────────*/
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const EMBEDDING_MODEL  = process.env.EMBEDDING_MODEL  || "text-embedding-3-large";
const MAX_TOKENS_EMB   = 8192;                    // límite del modelo
const BATCH_SIZE       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

const enc = encoding_for_model(EMBEDDING_MODEL);

/* ──────────────────────────────────────────────
   Estado en memoria
───────────────────────────────────────────────*/
let rows = [];   // [{ file, chunk, text, embedding }]
export function getRows() { return rows; }

/* ──────────────────────────────────────────────
   Cargar vector-store desde disco (inicio)
───────────────────────────────────────────────*/
export async function loadVectorStore(file = VECTORSTORE_PATH) {
  try {
    const abs = path.resolve(file);
    rows = JSON.parse(await fs.readFile(abs, "utf8"));
    console.log(`🔎 Vector-store cargado (${rows.length} chunks)`);
  } catch (err) {
    console.warn("⚠️  No se encontró vectorstore; se generará al vuelo");
    rows = [];
  }
}

/* ──────────────────────────────────────────────
   Persistir en disco
───────────────────────────────────────────────*/
async function saveVectorStore(file = VECTORSTORE_PATH) {
  const abs = path.resolve(file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(rows, null, 2), "utf8");
  console.log("💾 Vector-store guardado en", abs);
}

/* ──────────────────────────────────────────────
   Reconstruir índice (POST /files/reindex)
───────────────────────────────────────────────*/
export async function reindexVectorStore() {
  console.time("⏱  Reindex");
  const files = await listAllFiles();        // [{ id, name, path, webUrl }]
  console.log(`📁 ${files.length} archivos encontrados`);

  const newRows = [];
  for (const f of files) {
    const text = await getFileText(f);       // convierte Word/Excel/PDF a texto
    if (!text?.trim()) continue;

    /* ---------- chunking ---------- */
    const chunks = splitToFit(text, MAX_TOKENS_EMB, enc);
    for (let i = 0; i < chunks.length; i++) {
      newRows.push({
        file: f.name,
        chunk: i,
        text: chunks[i],
        embedding: null,                     // se rellenará más abajo
      });
    }
  }

  /* ---------- embeddings por lotes ---------- */
  console.log(`🧩 Generando embeddings (${newRows.length} chunks)…`);
  for (let i = 0; i < newRows.length; i += BATCH_SIZE) {
    const slice = newRows.slice(i, i + BATCH_SIZE);
    const emb = await createEmbedding(slice.map((r) => r.text));
    slice.forEach((r, idx) => (r.embedding = emb[idx]));
    process.stdout.write(`\r   · ${(i + BATCH_SIZE)}/${newRows.length}`);
  }
  console.log("\n✅ Embeddings completados");

  rows = newRows;                 // reemplaza en memoria
  await saveVectorStore();        // persiste en disco
  console.timeEnd("⏱  Reindex");
}
