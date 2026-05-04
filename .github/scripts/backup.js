const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function fetchAll(tabla, filtros = {}) {
  let query = sb.from(tabla).select('*');
  for (const [col, val] of Object.entries(filtros)) {
    query = query.eq(col, val);
  }
  const { data, error } = await query;
  if (error) {
    console.warn(`⚠️  Error en tabla ${tabla}:`, error.message);
    return [];
  }
  return data || [];
}

// Quita campos sensibles de un usuario antes de guardarlo en el backup
function sanitizeUsuario(u) {
  const { password_hash, ...resto } = u;
  return resto;
}

async function main() {
  const fecha = new Date().toISOString().split('T')[0];
  console.log(`\n🗄  Iniciando backup: ${fecha}\n`);

  // ── 1. Tablas globales ────────────────────────────────────────
  const colegios       = await fetchAll('colegios');
  const usuariosRaw    = await fetchAll('usuarios');
  // ⚠ NUNCA incluir password_hash en backup público
  const usuarios       = usuariosRaw.map(sanitizeUsuario);
  console.log(`✅  Colegios: ${colegios.length} | Usuarios: ${usuarios.length} (sin password_hash)`);

  // ── 2. Datos por colegio ──────────────────────────────────────
  const porColegio = {};

  for (const colegio of colegios) {
    console.log(`\n📚  Colegio: ${colegio.nombre} (RBD ${colegio.rbd})`);
    const cid = colegio.id;

    // Estructura del plan
    const areas        = await fetchAll('areas',        { colegio_id: cid });
    const cargos       = await fetchAll('cargos',       { colegio_id: cid });
    const responsables = await fetchAll('responsables', { colegio_id: cid });

    const objetivos = [];
    for (const area of areas) {
      const obs = await fetchAll('objetivos', { area_id: area.id });
      objetivos.push(...obs);
    }

    const acciones = [];
    for (const obj of objetivos) {
      const acs = await fetchAll('acciones', { objetivo_id: obj.id });
      acciones.push(...acs);
    }

    // Seguimiento, responsables asignados y evidencias
    const seguimiento = [];
    const accionResp  = [];
    const evidencias  = [];
    for (const ac of acciones) {
      const segs = await fetchAll('seguimiento', { accion_id: ac.id });
      seguimiento.push(...segs);
      const ars = await fetchAll('accion_responsable', { accion_id: ac.id });
      accionResp.push(...ars);
      const evs = await fetchAll('evidencias', { accion_id: ac.id });
      evidencias.push(...evs);
    }

    // Reuniones y participantes
    const reuniones = await fetchAll('reuniones', { colegio_id: cid });
    const participantes = [];
    for (const r of reuniones) {
      const parts = await fetchAll('reunion_participantes', { reunion_id: r.id });
      participantes.push(...parts);
    }

    // Módulo Denuncias
    const denuncias          = await fetchAll('denuncias', { colegio_id: cid });
    const accionesDenuncia   = [];
    const logDenuncia        = [];
    const mensajesCaso       = [];
    const evidenciasDenuncia = [];
    for (const d of denuncias) {
      accionesDenuncia.push(   ...(await fetchAll('acciones_denuncia',   { denuncia_id: d.id })));
      logDenuncia.push(        ...(await fetchAll('log_denuncia',         { denuncia_id: d.id })));
      mensajesCaso.push(       ...(await fetchAll('mensajes_caso',        { denuncia_id: d.id })));
      evidenciasDenuncia.push( ...(await fetchAll('evidencias_denuncia', { denuncia_id: d.id })));
    }

    console.log(`   Áreas: ${areas.length} | Objetivos: ${objetivos.length} | Acciones: ${acciones.length}`);
    console.log(`   Seguimiento: ${seguimiento.length} | Evidencias: ${evidencias.length} | Reuniones: ${reuniones.length}`);
    console.log(`   Denuncias: ${denuncias.length}`);

    porColegio[cid] = {
      colegio,
      cargos,
      responsables,
      areas,
      objetivos,
      acciones,
      accion_responsable:  accionResp,
      seguimiento,
      evidencias,
      reuniones,
      reunion_participantes: participantes,
      denuncias,
      acciones_denuncia:   accionesDenuncia,
      log_denuncia:        logDenuncia,
      mensajes_caso:       mensajesCaso,
      evidencias_denuncia: evidenciasDenuncia,
    };
  }

  // ── 3. Construir backup completo ──────────────────────────────
  const backup = {
    meta: {
      fecha_backup:    new Date().toISOString(),
      version:         '2.1',
      plataforma:      'Gestión Estratégica',
      total_colegios:  colegios.length,
      supabase_project: 'tykbytaymysxgvyvlgah',
      nota_seguridad:  'Este backup NO incluye password_hash ni password_resets por seguridad.',
    },
    usuarios,
    colegios: porColegio,
  };

  // ── 4. Guardar archivo ────────────────────────────────────────
  const dir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = `backup_${fecha}.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2), 'utf8');

  const sizeKB = Math.round(fs.statSync(filepath).size / 1024);
  console.log(`\n💾  Backup guardado: backups/${filename} (${sizeKB} KB)`);

  // ── 5. Enviar email ───────────────────────────────────────────
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      const resumen = colegios.map(c => {
        const d = porColegio[c.id];
        return `• ${c.nombre} (RBD ${c.rbd}): ${d.acciones.length} acciones, ${d.seguimiento.length} seguimientos, ${d.reuniones.length} reuniones, ${d.denuncias.length} denuncias`;
      }).join('\n');

      await transporter.sendMail({
        from: `"Gestión Estratégica Backup" <${process.env.EMAIL_USER}>`,
        to:   process.env.EMAIL_TO,
        subject: `✅ Backup Gestión Estratégica — ${fecha}`,
        text: `Backup completado exitosamente.\n\nFecha: ${new Date().toLocaleString('es-CL')}\nArchivo: backups/${filename}\nTamaño: ${sizeKB} KB\n\nResumen por colegio:\n${resumen}\n\nEl archivo está disponible en:\nhttps://github.com/jcorrea647/gestion-estrategica/tree/main/backups\n\nNota: el backup excluye contraseñas y tokens por seguridad.`,
      });

      console.log(`📧  Email enviado a ${process.env.EMAIL_TO}`);
    } catch (e) {
      console.warn('⚠️  Error enviando email:', e.message);
    }
  }

  console.log('\n✅  Backup completado exitosamente.\n');
}

main().catch(e => {
  console.error('❌  Error en backup:', e);
  process.exit(1);
});
