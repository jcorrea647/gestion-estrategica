const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Registro de advertencias para alertar en el email
const advertencias = [];

// Límite duro por consulta. PostgREST tiene un default de 1000 — si no
// pasamos range, Supabase trunca silenciosamente. Subimos a 50.000 (margen
// holgado: hoy la tabla más grande es planes_cache con ~2k filas).
const ROW_LIMIT = 50000;

async function fetchAll(tabla, filtros = {}) {
  let query = sb.from(tabla).select('*').range(0, ROW_LIMIT - 1);
  for (const [col, val] of Object.entries(filtros)) {
    query = query.eq(col, val);
  }
  const { data, error } = await query;
  if (error) {
    const msg = `Error en tabla ${tabla}: ${error.message}`;
    console.warn(`⚠️  ${msg}`);
    advertencias.push(msg);
    return [];
  }
  const filas = data || [];
  // Si llegamos al techo, casi seguro hay truncamiento. Advertir fuerte.
  if (filas.length === ROW_LIMIT) {
    const msg = `Tabla "${tabla}" alcanzó el límite de ${ROW_LIMIT} filas. POSIBLE TRUNCAMIENTO — subir ROW_LIMIT o paginar.`;
    console.warn(`⚠️  ${msg}`);
    advertencias.push(msg);
  }
  return filas;
}

// Quita campos sensibles de un usuario antes de guardarlo en el backup
function sanitizeUsuario(u) {
  const { password_hash, ...resto } = u;
  return resto;
}

// Compara el conteo actual de una tabla con el último backup conocido.
// Si el conteo cae bruscamente (>50% menos), agrega advertencia.
function chequearConteo(nombreTabla, conteoActual, conteoHistorico) {
  if (conteoHistorico == null) return;
  if (conteoActual === 0 && conteoHistorico > 0) {
    advertencias.push(`Tabla "${nombreTabla}" vacía (antes tenía ${conteoHistorico} registros)`);
    return;
  }
  if (conteoHistorico >= 10 && conteoActual < conteoHistorico * 0.5) {
    advertencias.push(`Tabla "${nombreTabla}" tiene ${conteoActual} registros (antes: ${conteoHistorico}, caída >50%)`);
  }
}

// Lee el backup más reciente para tener referencias de conteos
function leerBackupAnterior() {
  try {
    const dir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(dir)) return null;
    const archivos = fs.readdirSync(dir)
      .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (archivos.length === 0) return null;
    const ultimo = path.join(dir, archivos[0]);
    return JSON.parse(fs.readFileSync(ultimo, 'utf8'));
  } catch (e) {
    console.warn('No se pudo leer backup anterior:', e.message);
    return null;
  }
}

async function main() {
  const fecha = new Date().toISOString().split('T')[0];
  const horaCompleta = new Date().toISOString();
  console.log(`\n🗄  Iniciando backup: ${horaCompleta}\n`);

  const backupAnterior = leerBackupAnterior();

  // ── 1. Tablas globales ────────────────────────────────────────
  const colegios       = await fetchAll('colegios');
  const usuariosRaw    = await fetchAll('usuarios');
  const usuarios       = usuariosRaw.map(sanitizeUsuario);
  console.log(`✅  Colegios: ${colegios.length} | Usuarios: ${usuarios.length} (sin password_hash)`);

  // ── v2.4: planes_cache es GLOBAL, no por colegio ──────────────
  // Es la biblioteca compartida de planes generados por IA (con curación
  // humana). No tiene colegio_id porque el punto del cache es reusarse
  // entre colegios cuando el cache_key matchea. Si se pierde, se regenera
  // pero perdemos los tokens de IA gastados + las notas del curador.
  const planesCache = await fetchAll('planes_cache');
  console.log(`✅  Planes cache (global): ${planesCache.length}`);

  if (backupAnterior) {
    chequearConteo('colegios', colegios.length, backupAnterior.colegios ? Object.keys(backupAnterior.colegios).length : null);
    chequearConteo('usuarios', usuarios.length, backupAnterior.usuarios?.length);
    // Conteo histórico de planes_cache: puede venir del nivel raíz (v2.4+)
    // o estar disperso entre colegios (v2.3, en cuyo caso la comparación
    // no es exacta, pero al menos detectamos colapsos a 0)
    const conteoCacheAnterior = backupAnterior.planes_cache?.length ?? null;
    chequearConteo('planes_cache', planesCache.length, conteoCacheAnterior);
  }

  // Alerta dura: 0 colegios o 0 usuarios = backup inservible
  if (colegios.length === 0) {
    advertencias.push('CRÍTICO: 0 colegios en backup. Revisar SERVICE_KEY y conectividad.');
  }
  if (usuarios.length === 0) {
    advertencias.push('CRÍTICO: 0 usuarios en backup. Revisar SERVICE_KEY y conectividad.');
  }

  // ── 2. Datos por colegio ──────────────────────────────────────
  const porColegio = {};

  for (const colegio of colegios) {
    console.log(`\n📚  Colegio: ${colegio.nombre} (RBD ${colegio.rbd})`);
    const cid = colegio.id;
    const datosAnteriores = backupAnterior?.colegios?.[cid] || null;

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

    // ── Módulo Plan (microacciones) ─────────────────────────────
    const microacciones = await fetchAll('microacciones', { colegio_id: cid });
    const microaccionesPasos = [];
    for (const ma of microacciones) {
      const pasos = await fetchAll('microacciones_pasos', { microaccion_id: ma.id });
      microaccionesPasos.push(...pasos);
    }

    // ── v2.3: Documentos institucionales del colegio ───────────
    // Si un colegio carga PEI/PME/FASE y se borra accidentalmente,
    // sin esto era imposible recuperarlo.
    const colegioDocumentos = await fetchAll('colegio_documentos', { colegio_id: cid });
    const colegioPei        = await fetchAll('colegio_pei',        { colegio_id: cid });
    const colegioPmeOficial = await fetchAll('colegio_pme_oficial', { colegio_id: cid });

    // ── v2.4: planes_director SÍ es por colegio (sí tiene colegio_id) ──
    const planesDirector = await fetchAll('planes_director', { colegio_id: cid });

    console.log(`   Áreas: ${areas.length} | Objetivos: ${objetivos.length} | Acciones: ${acciones.length}`);
    console.log(`   Seguimiento: ${seguimiento.length} | Evidencias: ${evidencias.length} | Reuniones: ${reuniones.length}`);
    console.log(`   Denuncias: ${denuncias.length}`);
    console.log(`   Microacciones: ${microacciones.length} | Pasos: ${microaccionesPasos.length}`);
    console.log(`   Documentos: ${colegioDocumentos.length} | PEI: ${colegioPei.length} | PME oficial: ${colegioPmeOficial.length}`);
    console.log(`   Planes director: ${planesDirector.length}`);

    // Validar conteos contra backup anterior
    if (datosAnteriores) {
      chequearConteo(`${colegio.nombre}: acciones`, acciones.length, datosAnteriores.acciones?.length);
      chequearConteo(`${colegio.nombre}: seguimiento`, seguimiento.length, datosAnteriores.seguimiento?.length);
      chequearConteo(`${colegio.nombre}: evidencias`, evidencias.length, datosAnteriores.evidencias?.length);
      chequearConteo(`${colegio.nombre}: reuniones`, reuniones.length, datosAnteriores.reuniones?.length);
      chequearConteo(`${colegio.nombre}: denuncias`, denuncias.length, datosAnteriores.denuncias?.length);
      chequearConteo(`${colegio.nombre}: microacciones`, microacciones.length, datosAnteriores.microacciones?.length);
    }

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
      microacciones,
      microacciones_pasos: microaccionesPasos,
      // v2.3
      colegio_documentos:  colegioDocumentos,
      colegio_pei:         colegioPei,
      colegio_pme_oficial: colegioPmeOficial,
      // v2.4: planes_cache YA NO va por colegio (es global, ver arriba)
      planes_director:     planesDirector,
    };
  }

  // ── 3. Construir backup completo ──────────────────────────────
  const backup = {
    meta: {
      fecha_backup:    horaCompleta,
      version:         '2.4.1',
      plataforma:      'Gestión Estratégica',
      total_colegios:  colegios.length,
      supabase_project: 'tykbytaymysxgvyvlgah',
      nota_seguridad:  'Este backup NO incluye password_hash ni password_resets por seguridad.',
      modulos:         ['estructura_plan','seguimiento','evidencias','reuniones','denuncias','plan_microacciones','documentos_institucionales','planes_cache_global','planes_director'],
      advertencias_count: advertencias.length,
      advertencias:    advertencias.length > 0 ? advertencias : null,
    },
    usuarios,
    planes_cache: planesCache,
    colegios: porColegio,
  };

  // ── 4. Guardar archivo ────────────────────────────────────────
  const dir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Nombre incluye hora para no sobreescribir si corre cada 6h
  const horaArchivo = new Date().toISOString().slice(11, 13);
  const filename = `backup_${fecha}_${horaArchivo}h.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2), 'utf8');

  const sizeKB = Math.round(fs.statSync(filepath).size / 1024);
  console.log(`\n💾  Backup guardado: backups/${filename} (${sizeKB} KB)`);
  if (advertencias.length > 0) {
    console.log(`\n⚠️  ${advertencias.length} advertencia(s):`);
    advertencias.forEach(a => console.log(`   - ${a}`));
  }

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
        return `• ${c.nombre} (RBD ${c.rbd}): ${d.acciones.length} acciones, ${d.seguimiento.length} seguimientos, ${d.reuniones.length} reuniones, ${d.denuncias.length} denuncias, ${d.microacciones.length} microacciones, ${d.colegio_documentos.length} docs institucionales`;
      }).join('\n');

      const tieneAlerta = advertencias.length > 0;
      const subject = tieneAlerta
        ? `⚠ Backup Gestión Estratégica con ADVERTENCIAS — ${fecha}`
        : `✅ Backup Gestión Estratégica — ${fecha}`;

      let bodyAdvertencias = '';
      if (tieneAlerta) {
        bodyAdvertencias = `\n⚠️  ADVERTENCIAS DETECTADAS (${advertencias.length}):\n${advertencias.map(a => `  - ${a}`).join('\n')}\n\nREVISAR ESTE BACKUP. Algunas tablas pueden no haberse respaldado correctamente.\n`;
      }

      await transporter.sendMail({
        from: `"Gestión Estratégica Backup" <${process.env.EMAIL_USER}>`,
        to:   process.env.EMAIL_TO,
        subject: subject,
        text: `${tieneAlerta ? '⚠ BACKUP CON ADVERTENCIAS' : '✅ Backup completado exitosamente'}.\n\nFecha: ${new Date().toLocaleString('es-CL')}\nArchivo: backups/${filename}\nTamaño: ${sizeKB} KB\nVersión: 2.4.1\nPlanes cache (global): ${planesCache.length} registros\n${bodyAdvertencias}\nResumen por colegio:\n${resumen}\n\nEl archivo está disponible en:\nhttps://github.com/jcorrea647/gestion-estrategica/tree/main/backups\n\nNota: el backup excluye contraseñas y tokens por seguridad.`,
      });

      console.log(`📧  Email enviado a ${process.env.EMAIL_TO}`);
    } catch (e) {
      console.warn('⚠️  Error enviando email:', e.message);
    }
  }

  // Exit code 2 si hay errores críticos (GitHub Actions lo marca como falla)
  if (advertencias.some(a => a.startsWith('CRÍTICO:'))) {
    console.error('\n❌  Backup completado pero con errores CRÍTICOS. Revisar email.\n');
    process.exit(2);
  }

  console.log('\n✅  Backup completado exitosamente.\n');
}

main().catch(e => {
  console.error('❌  Error fatal en backup:', e);
  process.exit(1);
});
