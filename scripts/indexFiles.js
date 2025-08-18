// indexFiles.js - Versión actualizada
// Cambios basados en información actual (agosto 2025):
// - EMBEDDING_MODEL: Usando 'text-embedding-3-large' como el modelo de embeddings más reciente y disponible de OpenAI (dimensión 3072, no existe 'gpt-5-embed-4096').
// - Mantenida deduplicación y batching para eficiencia.
// - Logs para progreso.

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model, get_encoding } from "tiktoken";
import { listAllFiles, readFileContent, getFileText } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

const gc = global.gc ? () => global.gc() : () => {};
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";

const EMBEDDING_MODEL = "text-embedding-3-large"; // Modelo válido de OpenAI para embeddings en 2025

const MAX_TOKENS_EMB = Number(process.env.MAX_TOKENS_EMB) > 0 ? Number(process.env.MAX_TOKENS_EMB) : 8192;
const MAX_ROWS_PER_BLOCK = Number(process.env.MAX_ROWS_PER_BLOCK) > 0 ? Number(process.env.MAX_ROWS_PER_BLOCK) : 200;
const MAX_BLOCK_SIZE_BYTES = 1024 * 1024;
const BATCH_SIZE = 20;

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
  if (global.gc) gc();
  return parts;
}

function chunkText(str) {
  return splitToFit(str);
}

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

  const seen = new Set();

  const files = await listAllFiles();
  let totalEmbeddings = 0;
  for (const file of files) {
    if (!file.path.match(/\.(docx?|xlsx)$/i)) {
      console.log(`⏭ Saltando: ${file.path} (formato no compatible)`);
      continue;
    }

    console.log(`🗄 Procesando: ${file.path}`);
    logMemory();
    try {
      let texts;
      if (/\.xlsx$/i.test(file.name)) {
        texts = await getFileText(file, { rowsPerBlock: MAX_ROWS_PER_BLOCK });
      } else {
        const raw = await readFileContent(file);
        texts = [raw];
      }

      if (!Array.isArray(texts) || texts.length === 0) {
        console.error(`   ❌ ${file.name}: No se pudo extraer texto`);
        continue;
      }

      const nonEmpty = texts.flatMap(t => splitBlockIfLarge(typeof t === "string" ? t.trim() : "")).filter(Boolean);
      if (nonEmpty.length === 0) {
        console.error(`   ❌ ${file.name}: No texto útil`);
        continue;
      }

      console.log(`   📊 Bloques procesados: ${nonEmpty.length} para ${file.name}`);

      for (let j = 0; j < nonEmpty.length; j++) {
        const raw = nonEmpty[j];
        const chunks = chunkText(raw);
        for (let k = 0; k < chunks.length; k += BATCH_SIZE) {
          const batch = chunks.slice(k, k + BATCH_SIZE);
          const embeddings = await Promise.all(
            batch.map(async (text, idx) => {
              try {
                const embedding = await createEmbedding(text, { model: EMBEDDING_MODEL });
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
            const key = `${file.path}-${j}-${chunkIndex}`;
            if (seen.has(key)) {
              console.warn(`   ⚠️ Duplicado detectado y saltado: ${key}`);
              continue;
            }
            seen.add(key);
            const record = {
              fileId: file.id,
              path: file.path,
              block: j,
              chunk: chunkIndex,
              text,
              embedding,
              model: EMBEDDING_MODEL
            };
            const json = JSON.stringify(record, null, 2);
            writer.write(first ? json : ",\n" + json);
            first = false;
          }

          if (global.gc) gc();
          logMemory();
        }
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