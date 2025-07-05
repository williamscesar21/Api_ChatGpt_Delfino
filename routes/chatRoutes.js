import { Router } from "express";

import {
  createEmbedding,
  similaritySearch,
} from "../services/embeddingsService.js";
import { getRows }               from "../services/vectorStoreService.js";
import { buildMessages }         from "../utils/buildPrompt.js";
import {
  askOpenAI,            // respuesta clásica
  askOpenAIStream,      // respuesta por streaming
} from "../services/openaiService.js";
import { buildCacheKey, cache }  from "../services/cacheService.js";
import {
  newChat,
  appendMessage,
  appendAssistant,
  getTail,
} from "../services/conversationService.js";

/*  Autocorrección desactivada
// import { fixSpelling } from "../services/spellService.js";
*/

const router   = Router();
const TOP_K    = Number(process.env.TOP_K    || 6);
const MAX_TAIL = Number(process.env.MAX_TAIL || 8);

/* ──────────────────────────────────────────────
   POST /api/chat/start   →  { chatId }
───────────────────────────────────────────────*/
router.post("/chat/start", (_req, res) => {
  const chatId = newChat();          // crea conversación en memoria
  res.json({ chatId });
});

/* ──────────────────────────────────────────────
   POST /api/chat   body:
   {
     chatId: string,
     message: string,
     selectedIds?: string[],
     stream?: boolean        // ← true = Server-Sent Events
   }
───────────────────────────────────────────────*/
router.post("/chat", async (req, res) => {
  try {
    const {
      chatId,
      message,
      selectedIds = [],
      stream = false,
    } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: "Empty message" });
    }

    /* 1️⃣  (opcional) autocorrección ligera */
    // const fixed = await fixSpelling(message);
    const fixed = message;

    /* 2️⃣  cache lookup */
    const key = buildCacheKey(fixed, selectedIds);
    if (cache.has(key) && !stream) {
      const cached = cache.get(key);
      appendAssistant(chatId, cached);
      return res.json({ answer: cached, cached: true });
    }

    /* 3️⃣  embedding + búsqueda vectorial */
    const qEmb = await createEmbedding(fixed);
    const pool = getRows().filter(
      (r) => !selectedIds.length || selectedIds.includes(r.fileId)
    );
    const hits = similaritySearch(qEmb, pool, TOP_K);

    /* 4️⃣  mapa archivo → fragmentos */
    const ctxMap = {};
    hits.forEach((h) => {
      ctxMap[h.path] = (ctxMap[h.path] || "") + "\n" + h.text;
    });

    /* 5️⃣  historial reciente */
    const history = getTail(chatId, MAX_TAIL);

    /* 6️⃣  construir prompt */
    const messages = buildMessages(fixed, ctxMap, history);

    /* ───────────  Streaming (SSE) ─────────── */
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.flushHeaders();

      let full = "";
      for await (const delta of askOpenAIStream(messages)) {
        const chunk = delta.choices?.[0]?.delta?.content;
        if (chunk) {
          full += chunk;
          res.write(`data:${chunk}\n\n`);      // envía trozos al front
        }
      }

      appendMessage(chatId, { role: "user", content: fixed });
      appendAssistant(chatId, full);
      cache.set(key, full);
      return res.end();
    }

    /* ───────────  Respuesta clásica ─────────── */
    const answer = await askOpenAI(messages);

    appendMessage(chatId, { role: "user", content: fixed });
    appendAssistant(chatId, answer);
    cache.set(key, answer);

    res.json({ answer });
  } catch (err) {
    console.error("POST /chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
