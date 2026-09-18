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
//    Ver decisiones-arquitectura.md para el detalle de por qué se eligió
//    gzip aquí en vez de recortar la ventana de datos o redirigir a Drive.
// ============================================================================

const zlib = require('zlib');

exports.handler = async (event) => {
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

    // Casi todo navegador/cliente manda "Accept-Encoding: gzip" — comprimimos
    // siempre que lo acepte para no volver a chocar con el tope de 6MB.
    // Si por algo viniera sin ese header, se sirve sin comprimir como respaldo
    // (mismo riesgo de tamaño que antes, pero nunca peor que el comportamiento
    // previo a este cambio).
    const headers = (event && event.headers) || {};
    const acceptEnc = String(headers['accept-encoding'] || headers['Accept-Encoding'] || '');
    const puedeGzip = acceptEnc.toLowerCase().indexOf('gzip') >= 0;

    if (puedeGzip) {
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
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300, must-revalidate',
      },
      body: jsonStr,
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
