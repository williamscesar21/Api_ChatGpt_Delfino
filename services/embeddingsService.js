// services/embeddingsService.js
import OpenAI from 'openai';
import cosine from 'compute-cosine-similarity';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ───────── Config ───────── */
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-large';

const MAX_TOKENS_INPUT = 8192;         // límite oficial
const CHAR_PER_TOKEN   = 4;            // aprox. para corte defensivo
const MAX_CHARS_INPUT  = MAX_TOKENS_INPUT * CHAR_PER_TOKEN;

/* ───────── Utils ───────── */
function safeSlice(str) {
  return str.length > MAX_CHARS_INPUT ? str.slice(0, MAX_CHARS_INPUT) : str;
}

function sameLength(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length;
}

/* ───────── API wrappers ───────── */

/** Crea el embedding de `text` respetando el límite de tokens. */
export async function createEmbedding(text) {
  const input = safeSlice(text);

  const { data } = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input
  });

  return data[0].embedding; // array<number>
}

/**
 * Devuelve los `topK` documentos más similares a `queryVec`.
 * Ignora en silencio cualquier fila cuyo embedding no coincida en dimensión.
 */
export function similaritySearch(queryVec, vectorstore, topK = 5) {
  const qLen = queryVec.length;

  const scored = vectorstore.flatMap(row => {
    if (!sameLength(queryVec, row.embedding)) {
      // log para debug, pero no tiramos la petición
      console.warn(
        `[similaritySearch] longitudes distintas; descarto fila ${row.file}·${row.chunk}`
      );
      return [];
    }

    return [
      {
        ...row,
        similarity: cosine(queryVec, row.embedding)
      }
    ];
  });

  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}
