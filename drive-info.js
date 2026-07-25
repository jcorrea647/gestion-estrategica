// Vercel Serverless Function — LIAX · Drive info
// Devuelve la fecha de última modificación de una o varias hojas de Google
// Drive. La API key vive SOLO aquí (process.env.GOOGLE_DRIVE_API_KEY): nunca
// llega al navegador, por eso el repo puede seguir siendo público.
//
// Uso desde el frontend:
//   GET /api/drive-info?ids=1AbC...,9XyZ...
// Respuesta:
//   { ok:true, files:{ "1AbC...": { modifiedTime:"2026-07-25T18:04:11.000Z",
//                                   name:"ASISTENCIA 3A" }, ... } }
//
// Nunca falla de forma dura: si una hoja no se puede consultar, se devuelve
// null para ese id y las demás siguen. El módulo del frontend simplemente
// no muestra la fecha de esa fuente.

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey) {
    console.error('[drive-info] GOOGLE_DRIVE_API_KEY no configurada');
    res.status(200).json({ ok: false, error: 'no_configurado', files: {} });
    return;
  }

  // ids separados por coma; tope de 10 para no abusar de la cuota.
  const raw = (req.query && req.query.ids) ? String(req.query.ids) : '';
  const ids = raw.split(',')
    .map(s => s.trim())
    .filter(s => /^[a-zA-Z0-9_-]{10,}$/.test(s))   // formato de sheetId
    .slice(0, 10);

  if (!ids.length) {
    res.status(200).json({ ok: false, error: 'sin_ids', files: {} });
    return;
  }

  const files = {};

  await Promise.all(ids.map(async (id) => {
    try {
      const url = 'https://www.googleapis.com/drive/v3/files/' + id +
                  '?fields=name,modifiedTime&key=' + apiKey;
      const r = await fetch(url);
      if (!r.ok) {
        const detalle = await r.text().catch(() => '');
        console.error(`[drive-info] ${id} → ${r.status}: ${detalle.slice(0, 200)}`);
        files[id] = null;
        return;
      }
      const d = await r.json();
      files[id] = {
        name: d.name || null,
        modifiedTime: d.modifiedTime || null,
      };
    } catch (e) {
      console.error(`[drive-info] ${id} error: ${e.message}`);
      files[id] = null;
    }
  }));

  // Caché de 3 min en el edge: iguala el TTL del módulo y evita
  // consultar Drive una vez por cada docente del mismo curso.
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
  res.status(200).json({ ok: true, files });
};

module.exports = handler;
