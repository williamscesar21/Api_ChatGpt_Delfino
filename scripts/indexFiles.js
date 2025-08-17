import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model, get_encoding } from "tiktoken";
import { listAllFiles, readFileContent, getFileText } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

const gc = global.gc ? () => global.gc() : () => {};
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";

/**
 * Modelo por defecto orientado a GPT-5 para embeddings.
 * (Si prefieres otro, define EMBEDDING_MODEL en .env)
 */
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-large";

/** Tamaño máximo de tokens por chunk de embedding */
const MAX_TOKENS_EMB = Number(process.env.MAX_TOKENS_EMB) > 0 ? Number(process.env.MAX_TOKENS_EMB) : 8192;
/** Filas por bloque al convertir Excel a TSV (también configurable en fileService) */
const XLSX_ROWS_PER_BLOCK = Number(process.env.XLSX_ROWS_PER_BLOCK) > 0 ? Number(process.env.XLSX_ROWS_PER_BLOCK) : 500;

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

(async () => {
  if (!global.gc) {
    console.error("⚠️ Ejecuta Node con --expose-gc para habilitar la recolección manual de basura");
    process.exit(1);
  }

  await fsPromises.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });
  const writer = fs.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let first = true;

  const files = await listAllFiles();
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
        // Excel → múltiples bloques (TSV) para evitar strings gigantes
        texts = await getFileText(file, { rowsPerBlock: XLSX_ROWS_PER_BLOCK });
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

      // Filtrar vacíos
      const nonEmpty = texts.map(t => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
      if (nonEmpty.length === 0) {
        console.error(`   ❌ ${file.name}: No se obtuvo texto útil para ${file.path}`);
        continue;
      }

      // Procesar cada bloque/bucket de texto
      for (let j = 0; j < nonEmpty.length; j++) {
        const raw = nonEmpty[j];

        const chunks = chunkText(raw);
        for (let i = 0; i < chunks.length; i++) {
          const text = chunks[i];
          try {
            const embedding = await createEmbedding(text); // createEmbedding debe respetar EMBEDDING_MODEL del .env
            if (!Array.isArray(embedding) || embedding.length === 0) {
              console.error(`   ❌ ${file.name} [block ${j}] [chunk ${i}]: Embedding inválido`, embedding);
              continue;
            }
            console.log(`   ✅ ${file.name} [block ${j}] [chunk ${i}] - Embedding length: ${embedding.length}`);
            const record = {
              fileId: file.id,
              path: file.path,
              block: j,           // nuevo: índice del bloque (especialmente útil para XLSX)
              chunk: i,
              text,
              embedding,
              model: EMBEDDING_MODEL
            };
            const json = JSON.stringify(record, null, 2);
            writer.write(first ? json : ",\n" + json);
            first = false;
            if (global.gc) gc();
          } catch (err) {
            console.error(`   ❌ ${file.name} [block ${j}] [chunk ${i}]: ${err.message}`);
          }
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
  console.log(`🗂 Vectorstore guardado en ${VECTORSTORE_PATH}`);
  logMemory();
})();
