import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* llamada normal (ya la tienes) */
export async function askOpenAI(messages) {
  const { choices } = await openai.chat.completions.create({
    model:  process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.2,
  });
  return choices[0].message.content.trim();
}

/* llamada en streaming → async iterator */
export function askOpenAIStream(messages) {
  return openai.chat.completions.create({
    model:  process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.2,
    stream: true,
  });
}
