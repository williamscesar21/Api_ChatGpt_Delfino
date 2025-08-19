// indexFiles.js - Optimizado con control estricto de tokens por batch
// Cambios clave:
// - MAX_TOKENS_PER_REQUEST reducido a 150k para evitar overhead que dispara el conteo real en OpenAI.
// - embedInSafeBatches divide recursivamente hasta que cada batch esté <150k tokens.
// - Se añade contador global de tokens procesados y log al final.

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model, get_encoding } from "tiktoken";
import { listAllFiles, readFileContent, getFileText } from "../services/fileService.js";
import { createEmbeddings } from "../services/embeddingsService.js";

const gc = global.gc ? () => global.gc() : () => {};
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";

const EMBEDDING_MODEL = "text-embedding-3-large";

// Límites
const MAX_TOKENS_EMB = Number(process.env.MAX_TOKENS_EMB) > 0 ? Number(process.env.MAX_TOKENS_EMB) : 8192;
const MAX_ROWS_PER_BLOCK = Number(process.env.MAX_ROWS_PER_BLOCK) > 0 ? Number(process.env.MAX_ROWS_PER_BLOCK) : 200;
const MAX_BLOCK_SIZE_BYTES = 1024 * 1024;
const BATCH_SIZE = 2048; // límite superior de inputs
const MAX_TOKENS_PER_REQUEST = 150000; // margen seguro bajo 300k (con overhead)

// Contador global de tokens procesados
let globalTokenCount = 0;

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
  if (gc) gc();
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

// 🔥 Embedding con control estricto de tokens
async function embedInSafeBatches(chunks, model = EMBEDDING_MODEL) {
  const results = [];

  // función recursiva para dividir si se pasa de tokens
  async function processBatch(batch) {
    const totalTokens = batch.reduce((sum, txt) => sum + countTokens(txt), 0);

    if (batch.length === 0) return;

    if (totalTokens > MAX_TOKENS_PER_REQUEST) {
      if (batch.length === 1) {
        // Si un solo chunk se pasa, lo dividimos en partes más pequeñas
        const chunk = batch[0];
        const half = Math.floor(chunk.length / 2);
        await processBatch([chunk.slice(0, half)]);
        await processBatch([chunk.slice(half)]);
      } else {
        // dividir lote en 2
        const mid = Math.floor(batch.length / 2);
        await processBatch(batch.slice(0, mid));
        await processBatch(batch.slice(mid));
      }
    } else {
      console.log(`🚀 Enviando batch con ${batch.length} chunks (tokens reales=${totalTokens})`);
      const resp = await createEmbeddings(batch, { model });
      results.push(...resp);
      globalTokenCount += totalTokens;
      if (gc) gc();
    }
  }

  // procesar en grupos de hasta BATCH_SIZE
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const group = chunks.slice(i, i + BATCH_SIZE);
    await processBatch(group);
  }

  return results;
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
    if (err.code !== "ENOENT") throw err;
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

      const nonEmpty = texts
        .flatMap((t) => splitBlockIfLarge(typeof t === "string" ? t.trim() : ""))
        .filter(Boolean);
      if (nonEmpty.length === 0) {
        console.error(`   ❌ ${file.name}: No texto útil`);
        continue;
      }

      // Recolectar chunks
      let allChunks = [];
      let chunkMetadata = [];
      let globalChunkIndex = 0;
      for (let j = 0; j < nonEmpty.length; j++) {
        const raw = nonEmpty[j];
        const chunks = chunkText(raw);
        for (let i = 0; i < chunks.length; i++) {
          allChunks.push(chunks[i]);
          chunkMetadata.push({ block: j, chunkIndex: globalChunkIndex });
          globalChunkIndex++;
        }
      }

      // 🔥 Embeddings con control estricto de tokens
      const embeddings = await embedInSafeBatches(allChunks, EMBEDDING_MODEL);

      for (let idx = 0; idx < embeddings.length; idx++) {
        const embedding = embeddings[idx];
        const text = allChunks[idx];
        const { block, chunkIndex } = chunkMetadata[idx];

        if (!Array.isArray(embedding) || embedding.length === 0) continue;

        const key = `${file.path}-${block}-${chunkIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const record = {
          fileId: file.id,
          path: file.path,
          block,
          chunk: chunkIndex,
          text,
          embedding,
          model: EMBEDDING_MODEL,
        };
        const json = JSON.stringify(record);
        writer.write(first ? json : ",\n" + json);
        first = false;
        totalEmbeddings++;
      }
    } catch (err) {
      console.error(`   ❌ ${file.name}: ${err.message}`);
    }
    if (gc) gc();
    logMemory();
  }

  writer.write("\n]\n");
  await new Promise((resolve) => writer.end(resolve));
  console.log(`🗂 Vectorstore guardado en ${VECTORSTORE_PATH} con ${totalEmbeddings} embeddings generados.`);
  console.log(`📊 Tokens totales procesados: ${globalTokenCount}`);
  logMemory();
})();
