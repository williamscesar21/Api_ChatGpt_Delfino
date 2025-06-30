//services/openaiService.js
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function askOpenAI(messages) {
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages,
    temperature: 0.2
  });
  // Solo devolvemos la respuesta del modelo
  return completion.choices[0].message.content.trim();
}
