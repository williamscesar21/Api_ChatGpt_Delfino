// indexFiles.js - Versión actualizada
// Cambios principales:
// - Cambiado EMBEDDING_MODEL a "gpt-5-embed-4096" para usar GPT-5 embeddings.
// - Procesamiento de Excel en bloques de máximo 200 filas (configurable via env o constante).
// - Agregado check para limitar bloques a 1MB de texto crudo; si excede, dividir el bloque.
// - Implementado batching de embeddings: máximo 20 en paralelo usando Promise.all.
// - Forzado reindexación completa desde cero (ya era así, pero confirmado: sobrescribe el archivo).
// - Llamadas a global.gc() después de cada lote de embeddings.
// - Logs mejorados para progreso (bloques procesados, embeddings generados).
// - Constantes configurables: MAX_ROWS_PER_BLOCK, MAX_BLOCK_SIZE_BYTES, BATCH_SIZE, MAX_TOKENS_EMB.

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model, get_encoding } from "tiktoken";
import { listAllFiles, readFileContent, getFileText } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

const gc = global.gc ? () => global.gc() : () => {};
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";

// Modelo forzado a GPT-5 embeddings
const EMBEDDING_MODEL = "gpt-5-embed-4096"; // Cambiado a GPT-5 según requerimientos

// Constantes configurables
const MAX_TOKENS_EMB = Number(process.env.MAX_TOKENS_EMB) > 0 ? Number(process.env.MAX_TOKENS_EMB) : 8192;
const MAX_ROWS_PER_BLOCK = Number(process.env.MAX_ROWS_PER_BLOCK) > 0 ? Number(process.env.MAX_ROWS_PER_BLOCK) : 200; // Máximo 200 filas por bloque para Excel
const MAX_BLOCK_SIZE_BYTES = 1024 * 1024; // 1MB máximo por bloque de texto crudo
const BATCH_SIZE = 20; // Máximo 20 embeddings en paralelo

// Tiktoken encoder seguro con fallback
let enc;
try {
  enc = encoding_for_model(EMBEDDING_MODEL);
} catch {
  try {
    enc = get_encoding("cl100k_base");
  } catch {
    console.error("No se pudo inicializar el encoder de tokens.");
    process.exit(1);
  }
}

const countTokens = (str) => enc.encode(str).length;

function logMemory() {
  const mem = process.memoryUsage();
  const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
  console.log(
    "📊 Memory (MB):",
    `RSS=${toMB(mem.rss)}`,
    `HeapTotal=${toMB(mem.heapTotal)}`,
    `HeapUsed=${toMB(mem.heapUsed)}`,
    `External=${toMB(mem.external)}`
  );
}

/** Divide por tokens con estrategia de partición binaria para ajustar al límite */
function splitToFit(text) {
  const parts = [];
  const stack = [text];
  while (stack.length) {
    const chunk = stack.pop();
    if (countTokens(chunk) <= MAX_TOKENS_EMB) {
      parts.push(chunk);
    } else {
      const mid = Math.floor(chunk.length / 2);
      // dividir por caracteres (rápido) y seguir ajustando por tokens
      stack.push(chunk.slice(0, mid), chunk.slice(mid));
    }
  }
  if (global.gc) gc();
  return parts;
}

function chunkText(str) {
  return splitToFit(str);
}

/** Divide un bloque de texto si excede MAX_BLOCK_SIZE_BYTES */
function splitBlockIfLarge(block) {
  const encoder = new TextEncoder();
  const size = encoder.encode(block).length;
  if (size <= MAX_BLOCK_SIZE_BYTES) return [block];

  const parts = [];
  let current = "";
  const lines = block.split("\n");
  for (const line of lines) {
    const temp = current + (current ? "\n" : "") + line;
    if (encoder.encode(temp).length > MAX_BLOCK_SIZE_BYTES) {
      if (current) parts.push(current);
      current = line;
    } else {
      current = temp;
    }
  }
  if (current) parts.push(current);
  return parts;
}

(async () => {
  if (!global.gc) {
    console.error("⚠️ Ejecuta Node con --expose-gc para habilitar la recolección manual de basura");
    process.exit(1);
  }

  // Forzar reindexación completa: eliminar archivo existente si existe
  try {
    await fsPromises.unlink(VECTORSTORE_PATH);
    console.log(`🗑️ Vectorstore anterior eliminado para reindexación completa.`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fsPromises.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });
  const writer = fs.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let first = true;

  const files = await listAllFiles();
  let totalEmbeddings = 0;
  for (const file of files) {
    // Alineado con fileService: doc, docx, xlsx
    if (!file.path.match(/\.(docx?|xlsx)$/i)) {
      console.log(`⏭ Saltando: ${file.path} (formato no compatible)`);
      continue;
    }

    console.log(`🗄 Procesando: ${file.path}`);
    logMemory();
    try {
      let texts;

      if (/\.xlsx$/i.test(file.name)) {
        // Excel → múltiples bloques (TSV) con límite de filas
        texts = await getFileText(file, { rowsPerBlock: MAX_ROWS_PER_BLOCK });
      } else {
        // Word (docx, doc) → un único bloque de texto
        const raw = await readFileContent(file);
        texts = [raw];
      }

      // Validación de bloques de texto
      if (!Array.isArray(texts) || texts.length === 0) {
        console.error(`   ❌ ${file.name}: No se pudo extraer texto para ${file.path}`);
        continue;
      }

      // Filtrar vacíos y aplicar split si >1MB
      const nonEmpty = texts.flatMap(t => splitBlockIfLarge(typeof t === "string" ? t.trim() : "")).filter(Boolean);
      if (nonEmpty.length === 0) {
        console.error(`   ❌ ${file.name}: No se obtuvo texto útil para ${file.path}`);
        continue;
      }

      console.log(`   📊 Bloques procesados: ${nonEmpty.length} para ${file.name}`);

      // Procesar cada bloque/bucket de texto
      for (let j = 0; j < nonEmpty.length; j++) {
        const raw = nonEmpty[j];

        const chunks = chunkText(raw);
        // Batching: procesar chunks en lotes de BATCH_SIZE
        for (let k = 0; k < chunks.length; k += BATCH_SIZE) {
          const batch = chunks.slice(k, k + BATCH_SIZE);
          const embeddings = await Promise.all(
            batch.map(async (text, idx) => {
              try {
                const embedding = await createEmbedding(text, { model: EMBEDDING_MODEL }); // Pasar modelo explícitamente
                if (!Array.isArray(embedding) || embedding.length === 0) {
                  console.error(`   ❌ ${file.name} [block ${j}] [chunk ${k + idx}]: Embedding inválido`);
                  return null;
                }
                return { text, embedding, chunkIndex: k + idx };
              } catch (err) {
                console.error(`   ❌ ${file.name} [block ${j}] [chunk ${k + idx}]: ${err.message}`);
                return null;
              }
            })
          );

          const valid = embeddings.filter(Boolean);
          totalEmbeddings += valid.length;
          console.log(`   ✅ Lote procesado: ${valid.length} embeddings generados para [block ${j}]`);

          for (const { text, embedding, chunkIndex } of valid) {
            const record = {
              fileId: file.id,
              path: file.path,
              block: j,           // índice del bloque (especialmente útil para XLSX)
              chunk: chunkIndex,
              text,
              embedding,
              model: EMBEDDING_MODEL
            };
            const json = JSON.stringify(record, null, 2);
            writer.write(first ? json : ",\n" + json);
            first = false;
          }

          // GC después de cada lote
          if (global.gc) gc();
          logMemory();
        }

        // GC inter-bloques para Excels grandes
        if (global.gc) gc();
        logMemory();
      }
    } catch (err) {
      console.error(`   ❌ ${file.name}: ${err.message}`);
    }

    logMemory();
    if (global.gc) gc();
  }

  writer.write("\n]\n");
  await new Promise((resolve) => writer.end(resolve));
  console.log(`🗂 Vectorstore guardado en ${VECTORSTORE_PATH} con ${totalEmbeddings} embeddings generados.`);
  logMemory();
})();