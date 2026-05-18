// restore.js — Restaurar un backup de Gestión Estratégica a Supabase
// ============================================================
// USO:
//   node restore.js <ruta-al-backup.json> [opciones]
//
// OPCIONES:
//   --dry-run               Solo simula, no inserta nada
//   --colegio <uuid>        Restaurar solo un colegio específico
//   --skip-usuarios         No restaurar tabla usuarios (útil si conflictan con auth.users)
//
// EJEMPLOS:
//   node restore.js backups/backup_2026-05-18_05h.json --dry-run
//   node restore.js backups/backup_2026-05-15_05h.json --colegio d83ed01e-6580-41e4-a557-f6aaaaf67a15
//
// VARIABLES DE ENTORNO REQUERIDAS:
//   SUPABASE_URL              URL del proyecto Supabase
//   SUPABASE_SERVICE_KEY      Service role key (NO la anon key — saltea RLS)
//
// SEGURIDAD:
//   - Solo ejecutar con autorización explícita del owner.
//   - Hacer un backup ANTES de restaurar, por si el restore destruye datos.
//   - En producción, idealmente restaurar primero a un proyecto Supabase de staging
//     para validar que el backup es consistente.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ── Parseo de argumentos ─────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--')) {
  console.error('Uso: node restore.js <ruta-al-backup.json> [--dry-run] [--colegio <uuid>] [--skip-usuarios]');
  process.exit(1);
}

const backupPath = args[0];
const dryRun = args.includes('--dry-run');
const skipUsuarios = args.includes('--skip-usuarios');
const colegioIdx = args.indexOf('--colegio');
const colegioFiltro = colegioIdx > -1 ? args[colegioIdx + 1] : null;

if (!fs.existsSync(backupPath)) {
  console.error(`❌ Archivo no encontrado: ${backupPath}`);
  process.exit(1);
}

// ── Cargar backup ────────────────────────────────────────────
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
console.log(`\n📂  Backup cargado: ${path.basename(backupPath)}`);
console.log(`    Versión:  ${backup.meta?.version || 'desconocida'}`);
console.log(`    Fecha:    ${backup.meta?.fecha_backup || 'desconocida'}`);
console.log(`    Colegios: ${backup.meta?.total_colegios || 0}`);
console.log(`    Usuarios: ${backup.usuarios?.length || 0}`);
if (backup.meta?.advertencias_count > 0) {
  console.warn(`\n⚠️  Este backup tiene ${backup.meta.advertencias_count} advertencia(s):`);
  backup.meta.advertencias.forEach(a => console.warn(`    - ${a}`));
  console.warn(`\n¿Seguro de restaurar desde un backup con advertencias?`);
}

if (dryRun) {
  console.log(`\n🟡  MODO DRY-RUN: no se insertará nada en la DB.\n`);
}

// ── Cliente Supabase ─────────────────────────────────────────
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('\n❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en variables de entorno.');
  process.exit(1);
}

// ── Helper: upsert en batches ────────────────────────────────
async function upsertTabla(tabla, registros) {
  if (!registros || registros.length === 0) {
    console.log(`   ↳ ${tabla}: 0 registros, omitido`);
    return { ok: 0, err: 0 };
  }
  if (dryRun) {
    console.log(`   ↳ ${tabla}: ${registros.length} registros (DRY-RUN, no insertado)`);
    return { ok: registros.length, err: 0 };
  }
  // Upsert en lotes de 500 para evitar errores de tamaño
  const BATCH_SIZE = 500;
  let ok = 0, err = 0;
  for (let i = 0; i < registros.length; i += BATCH_SIZE) {
    const lote = registros.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from(tabla).upsert(lote, { onConflict: 'id' });
    if (error) {
      console.warn(`     ⚠ Error en batch ${i / BATCH_SIZE + 1} de ${tabla}: ${error.message}`);
      err += lote.length;
    } else {
      ok += lote.length;
    }
  }
  console.log(`   ↳ ${tabla}: ${ok} ok, ${err} errores`);
  return { ok, err };
}

// ── Restore principal ────────────────────────────────────────
async function restaurar() {
  let totalOk = 0, totalErr = 0;

  // 1. Tablas globales (colegios, usuarios)
  console.log(`\n🌐  Restaurando tablas globales...`);

  // Recolectar todos los colegios del backup
  const colegiosArr = Object.values(backup.colegios || {})
    .map(c => c.colegio)
    .filter(c => !colegioFiltro || c.id === colegioFiltro);
  const r1 = await upsertTabla('colegios', colegiosArr);
  totalOk += r1.ok; totalErr += r1.err;

  // Usuarios (a menos que se skipee)
  if (!skipUsuarios) {
    const usuarios = (backup.usuarios || []).filter(u => {
      if (!colegioFiltro) return true;
      return u.colegio_id === colegioFiltro;
    });
    const r2 = await upsertTabla('usuarios', usuarios);
    totalOk += r2.ok; totalErr += r2.err;
  } else {
    console.log(`   ↳ usuarios: omitido (--skip-usuarios)`);
  }

  // 2. Datos por colegio
  for (const [cid, datos] of Object.entries(backup.colegios || {})) {
    if (colegioFiltro && cid !== colegioFiltro) continue;
    console.log(`\n📚  Colegio: ${datos.colegio?.nombre || cid}`);

    // Orden de inserción respeta FK:
    // cargos/responsables/areas primero (no dependen de otros)
    // objetivos depende de areas
    // acciones depende de objetivos
    // accion_responsable, seguimiento, evidencias dependen de acciones
    // reuniones primero, reunion_participantes después
    // denuncias primero, después acciones_denuncia/log/mensajes/evidencias_denuncia
    // microacciones primero, después microacciones_pasos
    // documentos_institucionales sin dependencias
    const orden = [
      'cargos', 'responsables', 'areas',
      'objetivos',
      'acciones',
      'accion_responsable', 'seguimiento', 'evidencias',
      'reuniones', 'reunion_participantes',
      'denuncias', 'acciones_denuncia', 'log_denuncia', 'mensajes_caso', 'evidencias_denuncia',
      'microacciones', 'microacciones_pasos',
      'colegio_documentos', 'colegio_pei', 'colegio_pme_oficial',
      'planes_cache', 'planes_director',
    ];

    for (const tabla of orden) {
      if (datos[tabla]) {
        const r = await upsertTabla(tabla, datos[tabla]);
        totalOk += r.ok; totalErr += r.err;
      }
    }
  }

  console.log(`\n${dryRun ? '🟡 DRY-RUN' : '✅'} Restore completado.`);
  console.log(`   Total OK:      ${totalOk}`);
  console.log(`   Total errores: ${totalErr}`);
  if (totalErr > 0) {
    console.warn(`\n⚠️  Hubo errores. Revisar los mensajes de arriba.`);
    process.exit(2);
  }
}

restaurar().catch(e => {
  console.error('\n❌ Error fatal en restore:', e);
  process.exit(1);
});
