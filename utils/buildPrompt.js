/**
 * Genera el payload `messages` para la API Chat de OpenAI.
 *
 * • Los documentos se trocean en bloques de ≤ MAX_CHARS y se envuelven
 *   con marcas <<<Archivo|chunk:n>>> … <<<FIN>>> para que el modelo
 *   pueda citarlos (Archivo.ext · chunk:n).
 * • Siempre pedimos la respuesta en **Markdown** (sin indicar los
 *   fences ```), de modo que las listas, encabezados, etc. se
 *   formateen de forma legible en el front.
 */

import type { ChatCompletionMessageParam } from "openai";

interface Options {
  maxCharsPerFile?: number; // default 8 000  (≈ 2 k tokens)
  maxHistory?: number;      // default 8  turnos
}

export function buildMessages(
  userQuestion: string,
  fileContents: Record<string, string | object>,
  history: ChatCompletionMessageParam[] = [],
  options: Options = {}
): ChatCompletionMessageParam[] {
  const MAX_CHARS = options.maxCharsPerFile ?? 8_000;
  const MAX_HIST  = options.maxHistory     ?? 8;

  /* ───────────── 1. Prompt de sistema ───────────── */
  const systemPrompt = `
Eres **DelfinoBot**, asistente virtual de *Delfino Tours II*.

• Usa únicamente la información contenida entre las etiquetas
  «<<<Archivo|chunk:n>>> … <<<FIN>>>».
• Cada dato citado debe ir acompañado de su referencia:
  (Archivo.ext · chunk:n).
• Si no existe respuesta en los documentos, contesta exactamente:
  Lo siento, no dispongo de esa información.
• Responde SIEMPRE en **Markdown** claro y conciso
  (listas, tablas, negritas, etc.).
`.trim();

  /* ───────────── 2. Documentos troceados ───────────── */
  let chunkIdx = 1;
  const docMessages: ChatCompletionMessageParam[] = [];

  for (const [name, raw] of Object.entries(fileContents)) {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);

    for (let i = 0; i < text.length; i += MAX_CHARS) {
      const slice = text.slice(i, i + MAX_CHARS);
      docMessages.push({
        role: "system",
        content: `<<<${name}|chunk:${chunkIdx}>>>\n${slice}\n<<<FIN>>>`,
      });
      chunkIdx += 1;
    }
  }

  /* ───────────── 3. Historial (últimos N) ───────────── */
  const tail = history.slice(-MAX_HIST);

  /* ───────────── 4. Ensamble final ───────────── */
  return [
    { role: "system", content: systemPrompt },
    ...docMessages,
    ...tail,
    { role: "user", content: userQuestion },
  ];
}
