// services/cacheService.js
import { LRUCache } from 'lru-cache';          // ← named export

const ttl = Number(process.env.CACHE_TTL_SEC || 1800) * 1_000; // ms
const max = Number(process.env.CACHE_MAX || 500);

export const cache = new LRUCache({
  max,
  ttl,
  allowStale: false
});

/**
 * Devuelve una clave única basada en pregunta + archivos (ordenados)
 */
export function buildCacheKey(question, files) {
  const q = question.trim().replace(/\s+/g, ' ');
  const f = [...files].sort().join('|');
  return `${q}::${f}`;
}
