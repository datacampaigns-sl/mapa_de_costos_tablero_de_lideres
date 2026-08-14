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
// ============================================================================

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

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // El ETL corre 1 vez/día: 5 min de caché evita golpear Drive en cada visita.
        'Cache-Control': 'public, max-age=300, must-revalidate',
      },
      body: JSON.stringify(data),
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
