// services/embeddingsService.js
import OpenAI from 'openai';
import cosine from 'compute-cosine-similarity';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-ada-002';
const MAX_TOKENS_INPUT = 8192;
const CHAR_PER_TOKEN = 4;
const MAX_CHARS_INPUT = MAX_TOKENS_INPUT * CHAR_PER_TOKEN;

function safeSlice(str) {
  return str.length > MAX_CHARS_INPUT ? str.slice(0, MAX_CHARS_INPUT) : str;
}

function sameLength(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length;
}

export async function createEmbedding(text) {
  const input = safeSlice(text);
  try {
    const { data } = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input
    });
    const embedding = data[0].embedding;
    console.log('📏 Embedding generado, longitud:', embedding.length);
    return embedding; // Devuelve el vector directamente
  } catch (err) {
    console.error('❌ Error en createEmbedding:', err.message);
    throw err;
  }
}

export function similaritySearch(queryVec, vectorstore, topK = 5, minSim = 0.3) {
  const qLen = queryVec.length;
  const scored = vectorstore.flatMap(row => {
    if (!sameLength(queryVec, row.embedding)) {
      console.warn(`[similaritySearch] longitudes distintas; descarto fila ${row.path || 'undefined'}·${row.chunk}`);
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
    .filter(row => row.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}