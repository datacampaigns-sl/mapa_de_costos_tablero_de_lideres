// ============================================================================
//  finops-data.js — Sirve dashboard_data.json (salida diaria del ETL en Drive)
//  ----------------------------------------------------------------------------
//  POR QUÉ EXISTE
//    El ETL de Apps Script (main → _guardarJSON_) deja `dashboard_data.json` en
//    Google Drive y lo regenera a diario. Esta función lo lee desde el servidor
//    de Netlify y lo entrega al dashboard en el MISMO origen (/api/data):
//      · sin CORS (el navegador no toca Drive directamente)
//      · el dashboard siempre obtiene la última corrida SIN re-desplegar
//
//  CONFIGURACIÓN (Netlify → Site settings → Environment variables)
//    DRIVE_FILE_ID   = ID del archivo dashboard_data.json en Drive  (recomendado)
//      — o —
//    DRIVE_JSON_URL  = URL directa/publicada del JSON (tiene prioridad si existe)
//
//  REQUISITO: el archivo en Drive debe estar compartido como
//             "Cualquier persona con el enlace · Lector".
//
//  CONTRATO: GET /api/data  →  devuelve el JSON tal cual (o { error }).
//
//  NUEVO v2.3.3 (2026-09-18) — COMPRESIÓN GZIP
//    El payload de respuesta de una Netlify Function síncrona tiene un tope
//    DURO de 6 MB (6.291.556 bytes) — no es configurable ni depende del plan.
//    `dashboard_data.json` ya superó ese límite (crece cada día con el ETL),
//    lo que hacía crashear la función con `Function.ResponseSizeTooLarge`
//    ANTES de que el dashboard llegara a verlo, cayendo siempre al JSON de
//    respaldo embebido ("⚠ Data local (no Drive)"). JSON con muchas claves
//    repetidas (como este) comprime típicamente 70-90% con gzip — suficiente
//    para volver a caber bajo el límite sin quitar ni un dato del ETL.
//
//  CORRECCIÓN v2.3.4 (2026-09-18) — comprimir SIEMPRE, sin depender de
//    "Accept-Encoding" del request. La v2.3.3 solo comprimía si detectaba
//    ese header en `event.headers`, pero en el camino real (`/api/data` →
//    redirect interno de netlify.toml → función) ese header no llegó como
//    se esperaba, así que siempre caía a la rama SIN comprimir — mismo
//    crash de siempre, bytes idénticos. Casi cualquier cliente HTTP moderno
//    decodifica gzip sin pedirlo explícitamente, así que ya no se verifica
//    nada: se comprime incondicionalmente.
// ============================================================================

const zlib = require('zlib');

exports.handler = async () => {
  const url = process.env.DRIVE_JSON_URL ||
    (process.env.DRIVE_FILE_ID
      ? 'https://drive.google.com/uc?export=download&id=' + process.env.DRIVE_FILE_ID
      : null);

  if (!url) {
    return json(500, {
      error: 'Configura DRIVE_FILE_ID (o DRIVE_JSON_URL) en las variables de Netlify.',
    });
  }

  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return json(r.status, { error: 'Drive respondió ' + r.status });

    const text = await r.text();

    // Drive a veces devuelve una página HTML (archivo no compartido o muy grande).
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return json(502, {
        error: 'La respuesta de Drive no es JSON. Verifica que dashboard_data.json ' +
               'esté compartido como "Cualquiera con el enlace · Lector".',
      });
    }

    const jsonStr = JSON.stringify(data);

    // v2.3.4: comprimir SIEMPRE (ver nota arriba) — nunca condicionado a un
    // header que no podemos garantizar que llegue por el camino del redirect.
    const comprimido = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'));
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        // El ETL corre 1 vez/día: 5 min de caché evita golpear Drive en cada visita.
        'Cache-Control': 'public, max-age=300, must-revalidate',
      },
      isBase64Encoded: true,
      body: comprimido.toString('base64'),
    };
  } catch (e) {
    return json(502, { error: 'No se pudo leer el JSON desde Drive: ' + e.message });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}
