// services/openaiService.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ─────────────────────────────────────────────
   Respuesta completa (no-stream) — usada cuando
   el body no incluye   { stream:true }
────────────────────────────────────────────── */
export async function askOpenAI(messages, opts = {}) {
  const completion = await openai.chat.completions.create({
    model       : process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature : opts.temperature ?? 0.2,
    messages
  });
  return completion.choices[0].message.content.trim();
}

/* ─────────────────────────────────────────────
   Respuesta por _stream_  →  AsyncIterator<Chunk>
   Cada `chunk` ya es el objeto que devuelve el SDK
────────────────────────────────────────────── */
export async function* askOpenAIStream(messages, opts = {}) {
  const stream = await openai.chat.completions.create({
    model       : process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature : opts.temperature ?? 0.2,
    stream      : true,
    messages
  });

  for await (const chunk of stream) {
    yield chunk;            // el router se encarga de extraer delta.content
  }
}
