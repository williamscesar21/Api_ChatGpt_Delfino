import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model } from "tiktoken";
import { listAllFiles, readFileContent } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

const gc = global.gc ? () => global.gc() : () => {};
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
const MAX_TOKENS_EMB = 8192;
const BATCH_ROWS = +process.env.BATCH_ROWS_PER_CHUNK || 20;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-ada-002";

const enc = encoding_for_model(EMBEDDING_MODEL);
const countTokens = (str) => enc.encode(str).length;

function logMemory() {
  const mem = process.memoryUsage();
  const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
  console.log("📊 Memory (MB):",
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
  gc();
  return parts;
}

function chunkText(str) {
  return splitToFit(str);
}

(async () => {
  if (!global.gc) {
    console.error("⚠️ Run node with --expose-gc to enable manual garbage collection");
    process.exit(1);
  }

  await fsPromises.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });
  const writer = fs.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let first = true;

  const files = await listAllFiles();
  for (const file of files) {
    if (!file.path.endsWith(".docx")) {
      console.log(`⏭ Saltando: ${file.path} (no es .docx)`);
      continue;
    }

    console.log(`🗄 Procesando: ${file.path}`);
    logMemory();
    try {
      const raw = await readFileContent(file);
      if (typeof raw !== "string") {
        console.error(`   ❌ ${file.name}: Se esperaba texto plano para .docx`);
        continue;
      }
      const chunks = chunkText(raw);

      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        try {
          const embedding = await createEmbedding(text); // Cambiado: sin destructuring
          if (!Array.isArray(embedding) || embedding.length === 0) {
            console.error(`   ❌ ${file.name} [chunk ${i}]: Embedding inválido`, embedding);
            continue;
          }
          console.log(`   ✅ ${file.name} [chunk ${i}] - Embedding length: ${embedding.length}`);
          const record = {
            fileId: file.id,
            path: file.path,
            chunk: i,
            text,
            embedding,
          };
          const json = JSON.stringify(record, null, 2);
          writer.write(first ? json : ",\n" + json);
          first = false;
          gc();
        } catch (err) {
          console.error(`   ❌ ${file.name} [chunk ${i}]: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`   ❌ ${file.name}: ${err.message}`);
      continue;
    }
    logMemory();
    gc();
  }

  writer.write("\n]\n");
  await new Promise((resolve) => writer.end(resolve));
  console.log(`🗂 Vectorstore guardado en ${VECTORSTORE_PATH}`);
  logMemory();
})();