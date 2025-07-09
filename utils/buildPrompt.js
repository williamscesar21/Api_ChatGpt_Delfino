// src/utils/buildPrompt.js
// -----------------------------------------------
/**
 * @typedef {import("openai").ChatCompletionMessageParam} ChatCompletionMessageParam
 */

/** Prompt por defecto, en caso de que el front no envíe uno */
const DEFAULT_SYSTEM_PROMPT = `
Eres **DelfinoBot**, asistente virtual de *Delfino Tours II*.

• Usa únicamente los fragmentos entre «<<<Archivo|chunk:n>>> … <<<FIN>>>».
• Cuando cites, indica (Archivo.ext · chunk:n).
• Si no está en los documentos, responde exactamente:
  Lo siento, no dispongo de esa información.
• Responde SIEMPRE en Markdown claro y conciso y con la referencia al archivo.
Recuerda siempre revisar todos los archivos si no se especifica uno
Y cada vez que te pregunten por algun precio revisar el Tarifario.
`.trim();

/**
 * Genera el array `messages` para la API Chat completions.
 *
 * @param {string} userQuestion
 * @param {Record<string, string|object>} fileContents          ← chunk-map (path → texto)
 * @param {ChatCompletionMessageParam[]} [history=[]]           ← historial previo
 * @param {{
 *   maxCharsPerFile?: number;
 *   maxHistory?: number;
 *   systemPrompt?: string;
 * }} [options={}]
 * @returns {ChatCompletionMessageParam[]}
 */
export function buildMessages(
  userQuestion,
  fileContents,
  history = [],
  {
    maxCharsPerFile = 8_000,
    maxHistory = 8,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
  } = {},
) {
  /* ── 1. Troceo de documentos ───────────────────────────────── */
  let idx = 1;
  /** @type {ChatCompletionMessageParam[]} */
  const docs = [];

  for (const [name, raw] of Object.entries(fileContents)) {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    for (let i = 0; i < text.length; i += maxCharsPerFile) {
      docs.push({
        role: "system",
        content: `<<<${name}|chunk:${idx}>>>\n${text.slice(
          i,
          i + maxCharsPerFile,
        )}\n<<<FIN>>>`,
      });
      idx += 1;
    }
  }

  /* ── 2. Ensamblado final ───────────────────────────────────── */
  return [
    { role: "system", content: systemPrompt },
    ...docs,
    ...history.slice(-maxHistory),
    { role: "user", content: userQuestion },
  ];
}
