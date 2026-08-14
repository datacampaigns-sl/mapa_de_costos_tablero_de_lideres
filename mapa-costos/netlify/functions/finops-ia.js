// ============================================================================
//  finops-ia.js — Proxy serverless para el Asistente IA del dashboard
//  ----------------------------------------------------------------------------
//  Recibe la consulta del navegador (mismo origen → sin CORS), la reenvía a la
//  API de IA inyectando la API key desde variable de entorno, y devuelve la
//  respuesta. La API key NUNCA viaja al cliente.
//
//  CONFIGURACIÓN (Netlify → Site settings → Environment variables)
//    ANTHROPIC_API_KEY = sk-ant-...            (obligatoria)
//    IA_MODEL          = claude-sonnet-4-6     (opcional)
//
//  CONTRATO  (POST /api/ia)  — acepta cualquiera de los dos formatos:
//    { prompt: "...", system?: "..." }
//    { messages: [ {role,content}... ], system?: "...", model?: "..." }
//  Devuelve: { text: "..." }  |  { error: "..." }
// ============================================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Método no permitido. Usa POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Falta ANTHROPIC_API_KEY en las variables de Netlify.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Body JSON inválido.' });
  }

  // Acepta { messages } o { prompt }
  let messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) {
    const prompt = (body.prompt || '').toString().trim();
    if (!prompt) return json(400, { error: 'Falta "prompt" o "messages".' });
    messages = [{ role: 'user', content: prompt }];
  }

  const system = (body.system || '').toString();
  const model  = (body.model || process.env.IA_MODEL || DEFAULT_MODEL).toString();

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        ...(system ? { system } : {}),
        messages,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return json(resp.status, { error: data?.error?.message || ('Error ' + resp.status) });
    }

    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return json(200, { text: text || 'Sin respuesta del modelo.' });
  } catch (e) {
    return json(502, { error: 'No se pudo contactar con la API de IA: ' + e.message });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}
