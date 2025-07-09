// src/routes/chatRoutes.js
// -----------------------------------------------
import { Router } from "express";

import { createEmbedding, similaritySearch } from "../services/embeddingsService.js";
import { getRows }            from "../services/vectorStoreService.js";
import { buildMessages }      from "../utils/buildPrompt.js";
import {
  askOpenAI,            // respuesta completa
  askOpenAIStream,      // respuesta mediante streaming
} from "../services/openaiService.js";
import { buildCacheKey, cache } from "../services/cacheService.js";
import {
  newChat,
  appendMessage,
  appendAssistant,
  getTail,
} from "../services/conversationService.js";

/*  Si vuelves a habilitar autocorrección, descomenta
// import { fixSpelling } from "../services/spellService.js";
*/

const router       = Router();
const TOP_K        = Number(process.env.TOP_K    || 6);   // chunks por vector-search
const MAX_TAIL     = Number(process.env.MAX_TAIL || 8);   // mensajes previos
const KEEPALIVE_MS = 15_000;                              // ping SSE

/* ──────────────────────────────────────────────
   POST /api/chat/start  → { chatId }
───────────────────────────────────────────────*/
router.post("/chat/start", (_req, res) => {
  res.json({ chatId: newChat() });
});

/* ──────────────────────────────────────────────
   POST /api/chat
   body: {
     chatId,
     message,
     selectedIds? : string[],
     stream?      : boolean,
     systemPrompt?: string,
     maxCharsPerFile?: number,
     maxHistory?: number
   }
───────────────────────────────────────────────*/
router.post("/chat", async (req, res) => {
  try {
    const {
      chatId,
      message,
      selectedIds = [],
      stream = false,

      // 🆕  parámetros enviados desde el front
      systemPrompt,
      maxCharsPerFile,
      maxHistory,
    } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: "Empty message" });
    }

    /* 1⃣ (opcional) autocorrección */
    // const fixed = await fixSpelling(message);
    const fixed = message;

    /* 2⃣ Cache (solo si NO es streaming) */
    const cacheKey = buildCacheKey(fixed, selectedIds);
    if (!stream && cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      appendAssistant(chatId, cached);
      return res.json({ answer: cached, cached: true });
    }

    /* 3⃣ Embedding + similarity search */
    const qEmb = await createEmbedding(fixed);
    const pool = getRows().filter(
      (r) => !selectedIds.length || selectedIds.includes(r.fileId),
    );
    const hits = similaritySearch(qEmb, pool, TOP_K);

    /* 4⃣ Reúne contexto por archivo */
    const ctxMap = {};
    hits.forEach((h) => {
      ctxMap[h.path] = (ctxMap[h.path] || "") + "\n" + h.text;
    });

    /* 5⃣ Historial corto */
    const history = getTail(chatId, MAX_TAIL);

    /* 6⃣ Prompt listo (usa los valores recibidos o defaults) */
    const messages = buildMessages(fixed, ctxMap, history, {
      systemPrompt,
      maxCharsPerFile,
      maxHistory,
    });

    /* ───────────── STREAM (SSE) ───────────── */
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (res.flushHeaders) res.flushHeaders();

      const ping = setInterval(() => res.write(":\n\n"), KEEPALIVE_MS);

      let fullAnswer = "";
      try {
        for await (const chunk of askOpenAIStream(messages)) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (!delta) continue; // ignora pings de OpenAI
          fullAnswer += delta;
          res.write(`data:${delta}\n\n`);
        }
      } finally {
        clearInterval(ping);
      }

      /* guarda conversación y cachea */
      appendMessage(chatId, { role: "user", content: fixed });
      appendAssistant(chatId, fullAnswer);
      cache.set(cacheKey, fullAnswer);

      return res.end();
    }

    /* ───────── RESPUESTA CLÁSICA ───────── */
    const answer = await askOpenAI(messages);

    appendMessage(chatId, { role: "user", content: fixed });
    appendAssistant(chatId, answer);
    cache.set(cacheKey, answer);

    res.json({ answer });
  } catch (err) {
    console.error("POST /chat error:", err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

export default router;
