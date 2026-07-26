// Vercel Serverless Function — LIAX · Drive CSV
// Devuelve el contenido de una hoja de Google Sheets como texto CSV.
//
// POR QUÉ EN EL SERVIDOR: el navegador NO puede leer
// docs.google.com/.../export?format=csv por CORS (Google no envía
// Access-Control-Allow-Origin). Leyendo aquí el problema desaparece,
// la API key nunca llega al cliente y la URL de la hoja queda oculta.
//
// Uso:  GET /api/drive-csv?id=<sheetId>[&gid=<pestaña>]
// OK:   { ok:true, csv:"...", name:"...", modifiedTime:"..." }
// Error:{ ok:false, error:"<motivo>" }   ← siempre HTTP 200, nunca rompe la app

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  const id  = (req.query && req.query.id)  ? String(req.query.id).trim()  : '';
  const gid = (req.query && req.query.gid) ? String(req.query.gid).trim() : '';

  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
    res.status(200).json({ ok: false, error: 'id_invalido' });
    return;
  }

  // ── Intento 1: Drive API (requiere key; es el camino oficial) ──────────
  if (apiKey) {
    try {
      const meta = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}?fields=name,modifiedTime&key=${apiKey}`
      );
      let name = null, modifiedTime = null;
      if (meta.ok) {
        const m = await meta.json().catch(() => ({}));
        name = m.name || null;
        modifiedTime = m.modifiedTime || null;
      }

      const exp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/csv&key=${apiKey}`
      );
      if (exp.ok) {
        const csv = await exp.text();
        if (csv && csv.trim()) {
          res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
          res.status(200).json({ ok: true, csv, name, modifiedTime, via: 'drive_api' });
          return;
        }
      } else {
        const d = await exp.text().catch(() => '');
        console.error(`[drive-csv] Drive API ${id} → ${exp.status}: ${d.slice(0, 200)}`);
      }
    } catch (e) {
      console.error(`[drive-csv] Drive API ${id} error: ${e.message}`);
    }
  }

  // ── Intento 2: export público (funciona sin key si la hoja es pública) ──
  // Desde el servidor no hay CORS, así que este camino sí sirve como respaldo.
  try {
    let url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
    if (gid) url += `&gid=${encodeURIComponent(gid)}`;
    const r = await fetch(url, { redirect: 'follow' });
    if (r.ok) {
      const csv = await r.text();
      // Si la hoja NO es pública, Google devuelve el HTML del login.
      if (csv && csv.trim() && !/^\s*<(!doctype|html)/i.test(csv)) {
        res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
        res.status(200).json({ ok: true, csv, name: null, modifiedTime: null, via: 'export' });
        return;
      }
      res.status(200).json({ ok: false, error: 'no_publica' });
      return;
    }
    console.error(`[drive-csv] export ${id} → ${r.status}`);
    res.status(200).json({ ok: false, error: 'no_accesible_' + r.status });
  } catch (e) {
    console.error(`[drive-csv] export ${id} error: ${e.message}`);
    res.status(200).json({ ok: false, error: 'error_red' });
  }
};

module.exports = handler;
