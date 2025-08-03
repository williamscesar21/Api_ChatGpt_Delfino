import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { encoding_for_model } from "tiktoken";
import { listAllFiles, readFileContent } from "../services/fileService.js";
import { createEmbedding } from "../services/embeddingsService.js";

// Force garbage collection if available to manage memory usage during indexing
const gc = global.gc ? () => global.gc() : () => {};

// Define path for the output vector store file
const VECTORSTORE_PATH = process.env.VECTORSTORE_PATH || "./vectorstore/index.json";
// Maximum tokens for embedding to ensure chunks fit model limits
const MAX_TOKENS_EMB = 8192;
// Number of rows to process per chunk (used for Excel, but kept for reference)
const BATCH_ROWS = +process.env.BATCH_ROWS_PER_CHUNK || 20;

// Initialize token encoder for the specified embedding model
const enc = encoding_for_model(
  process.env.EMBEDDING_MODEL || "text-embedding-3-large"
);
// Function to count tokens in a string using the encoder
const countTokens = (str) => enc.encode(str).length;

/** Log memory usage to monitor heap during processing */
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

/** Split text into chunks that fit within the token limit */
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
  gc(); // Trigger garbage collection to free memory
  return parts;
}

/** Chunk plain text (used for .docx files) */
function chunkText(str) {
  return splitToFit(str);
}

/** 
 * Chunk Excel data (commented out as we are only indexing .docx files)
 * This function is kept for reference but not used in the current implementation
 */
/*
function chunkExcel(book) {
  const out = [];
  const fits = (t) => countTokens(t) <= MAX_TOKENS_EMB;

  for (const [sheet, rows] of Object.entries(book)) {
    let chunk = `Hoja: ${sheet}\n`;
    let added = 0;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (const [col, raw] of Object.entries(row)) {
        const value = String(raw ?? "").trim();
        if (!value || value.length > 200) continue;
        const line = `Fila ${r + 1} Col ${col}: ${value}\n`;

        if (!fits(chunk + line)) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
          added = 0;
          gc();
        }
        chunk += line;
        added++;

        if (added >= BATCH_ROWS) {
          out.push(chunk);
          chunk = `Hoja: ${sheet} (cont.)\n`;
          added = 0;
          gc();
        }
      }
    }
    if (chunk.trim()) out.push(chunk);
  }

  return out.flatMap(splitToFit);
}
*/

(async () => {
  // Check if garbage collection is enabled
  if (!global.gc) {
    console.error("⚠️  Run node with --expose-gc to enable manual garbage collection");
    process.exit(1); // Exit to enforce correct configuration
  }

  // Create output directory for vector store
  await fsPromises.mkdir(path.dirname(VECTORSTORE_PATH), { recursive: true });

  // Initialize JSON array in output file
  const writer = fs.createWriteStream(VECTORSTORE_PATH, { encoding: "utf8" });
  writer.write("[\n");
  let first = true;

  // Get list of all files
  const files = await listAllFiles();
  for (const file of files) {
    // Filter to process only .docx files
    if (!file.path.endsWith(".docx")) {
      console.log(`⏭  Saltando: ${file.path} (no es .docx)`);
      continue;
    }

    console.log(`🗄  Procesando: ${file.path}`);
    logMemory();
    try {
      const raw = await readFileContent(file);
      // Process only as plain text (for .docx files)
      if (typeof raw !== "string") {
        console.error(`   ❌  ${file.name}: Se esperaba texto plano para .docx`);
        continue;
      }
      const chunks = chunkText(raw);

      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        try {
          const [embedding] = await createEmbedding([text]);
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
          console.log(`   ✅  ${file.name} [${i}]`);
          gc();
        } catch (err) {
          console.error(`   ❌  ${file.name} [chunk ${i}]: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`   ❌  ${file.name}: ${err.message}`);
      continue; // Skip to next file
    }
    logMemory();
    gc();
  }

  // Close JSON array
  writer.write("\n]\n");
  await new Promise((resolve) => writer.end(resolve));
  console.log(`🗂  Vectorstore guardado en ${VECTORSTORE_PATH}`);
  logMemory();
})();