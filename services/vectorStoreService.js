/* ----------------------------------------------------------------------
   services/vectorStoreService.js
   ----------------------------------------------------------------------
   • Mantiene el vector-store en disco como JSON
   • Reindexa en streaming: solo mantiene en memoria el lote actual
---------------------------------------------------------------------- */

import fs   from "fs";
import fsp  from "fs/promises";
import path from "path";
import { listAllFiles, getFileText } from "./fileService.js";
import { createEmbedding }           from "./embeddingsService.js";

/* ───────── configuración ───────── */
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const EMBEDDING_MODEL  = process.env.EMBEDDING_MODEL  || "text-embedding-3-large";
const MAX_CHARS_CHUNK  = 16_000;                       // ≈ 8 k tokens “a ojo”
const BATCH_SIZE       = +process.env.BATCH_ROWS_PER_CHUNK || 200;

/* ───────── estado en memoria ───────── */
let rows = [];                 // se carga después del reindex
export const getRows = () => rows;

/* ───────── carga inicial ───────── */
export async function loadVectorStore(file = VECTORSTORE_PATH) {
  try {
    const abs = path.resolve(file);
    rows = JSON.parse(await fsp.readFile(abs, "utf8"));
    console.log(`🔎 Vector-store cargado (${rows.length} chunks)`);
  } catch {
    console.warn("⚠️  No se encontró index.json; se generará cuando reindexes");
    rows = [];
  }
}

/* ───────── guarda (sobrescribe) ─────────
   ─ ya no se usa salvo casos extraordinarios ─ */
async function saveVectorStore(obj = rows, file = VECTORSTORE_PATH) {
  const abs = path.resolve(file);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, JSON.stringify(obj, null, 2), "utf8");
  console.log("💾 Vector-store guardado en", abs);
}

/* ───────── troceo rápido sin tiktoken ───────── */
function simpleSplit(text, max = MAX_CHARS_CHUNK) {
  const paras  = text.split(/\n+/);
  const out    = [];
  let buffer   = "";

  for (const p of paras) {
    if (buffer.length + p.length + 1 <= max) {
      buffer += (buffer ? "\n" : "") + p;
      continue;
    }
    if (buffer) { out.push(buffer); buffer = ""; }

    if (p.length > max) {
      for (let i = 0; i < p.length; i += max)
        out.push(p.slice(i, i + max));
    } else buffer = p;
  }
  if (buffer) out.push(buffer);
  return out;
}

/* ───────── reindexación streaming ───────── */
export async function reindexVectorStore() {
  console.time("⏱  Reindex");
  const files = await listAllFiles();
  console.log(`📁 ${files.length} archivos encontrados`);

  /* ---- crea flujo de escritura JSON ---- */
  const abs   = path.resolve(VECTORSTORE_PATH);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const ws    = fs.createWriteStream(abs, { encoding: "utf8" });
  ws.write("[\n");
  let firstRow = true;

  const writeRow = (rowObj) => {
    if (!firstRow) ws.write(",\n");
    ws.write(JSON.stringify(rowObj));
    firstRow = false;
  };

  /* ---- procesa archivo por archivo ---- */
  for (const f of files) {
    const text = await getFileText(f);
    if (!text?.trim()) continue;

    const chunks = simpleSplit(text);

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const slice = chunks.slice(i, i + BATCH_SIZE);
      const embeds = await createEmbedding(slice.map((t) => t));

      embeds.forEach((emb, idx) => {
        writeRow({
          file:  f.name,
          chunk: i + idx,
          text:  slice[idx],
          embedding: emb,          // suponemos emb = array<number>
        });
      });

      process.stdout.write(
        `\r   · ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}  (${f.name})`
      );
    }
    process.stdout.write("\n");
  }

  ws.write("\n]\n");
  await new Promise((res) => ws.end(res));
  console.log("✅ Reindex completado");

  /* ---- recarga en memoria para consultas ---- */
  await loadVectorStore();
  console.timeEnd("⏱  Reindex");
}
