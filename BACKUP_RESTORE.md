# Backup & Restore — Gestión Estratégica

Sistema de respaldo automático y procedimiento de recuperación de datos.

---

## 📦 Sistema de backup

### Frecuencia

**Cada 6 horas** (00:00, 06:00, 12:00, 18:00 UTC) — automático vía GitHub Actions.

En horario Chile (GMT-4): 20:00, 02:00, 08:00, 14:00.

### Qué se respalda

Todas las tablas críticas de Gestión Estratégica:

**Globales:**
- `colegios`
- `usuarios` (sin `password_hash`, por seguridad)

**Por cada colegio:**
- Estructura del plan: `cargos`, `responsables`, `areas`, `objetivos`, `acciones`
- Ejecución: `accion_responsable`, `seguimiento`, `evidencias`
- Reuniones: `reuniones`, `reunion_participantes`
- Denuncias: `denuncias`, `acciones_denuncia`, `log_denuncia`, `mensajes_caso`, `evidencias_denuncia`
- Plan microacciones: `microacciones`, `microacciones_pasos`
- Documentos institucionales: `colegio_documentos`, `colegio_pei`, `colegio_pme_oficial`
- IA: `planes_cache`, `planes_director`

### Lo que NO se respalda (deliberado)

- `password_hash` — passwords están en `auth.users` de Supabase (bcrypt). No se respaldan por seguridad.
- `password_resets` — tabla deprecada, sin uso desde la migración a Supabase Auth.
- Tablas de Liax-piloto — sistema de respaldo separado (pendiente).

### Dónde quedan los backups

En este mismo repo, carpeta `backups/`. Cada archivo es un JSON con nombre `backup_YYYY-MM-DD_HHh.json`.

### Email de notificación

Cada ejecución envía un email a `jcorrea@estrategica.cl` con:
- ✅ "Backup OK" si todo fue bien
- ⚠ "Backup CON ADVERTENCIAS" si detectó anomalías (ej. una tabla cae a 0 registros cuando antes tenía datos)

Si llega un email con advertencias, **investigar** antes de confiar en ese backup.

### Validaciones automáticas

El script compara cada ejecución contra el backup anterior:
- Si una tabla cae a 0 cuando antes tenía datos → advertencia
- Si una tabla pierde >50% de sus registros → advertencia
- Si 0 colegios o 0 usuarios → error CRÍTICO (workflow falla)

---

## 🔧 Procedimiento de restore

### Cuándo restaurar

- Borrado masivo accidental
- Corrupción de datos
- Restaurar a un estado específico previo
- Migrar a otro proyecto Supabase

### Pre-requisitos

1. **Node.js 18+** instalado
2. **Service role key** de Supabase (Dashboard → Settings → API → `service_role`)
3. **Hacer un backup actual** ANTES de restaurar (el restore puede sobreescribir datos nuevos)

### Pasos

#### 1. Bajar el backup deseado

```bash
git clone https://github.com/jcorrea647/gestion-estrategica.git
cd gestion-estrategica
# Ver lista de backups disponibles
ls backups/
```

#### 2. Configurar variables de entorno

```bash
export SUPABASE_URL="https://tykbytaymysxgvyvlgah.supabase.co"
export SUPABASE_SERVICE_KEY="<service_role_key_aquí>"
```

> ⚠ **Nunca commitear el service_role_key**. Es la llave maestra que saltea RLS.

#### 3. Instalar dependencias

```bash
npm install @supabase/supabase-js
```

#### 4. Probar con `--dry-run` primero

```bash
node .github/scripts/restore.js backups/backup_2026-05-18_05h.json --dry-run
```

Esto simula el restore sin tocar la DB. Verifica que cuente correctamente y no haya errores.

#### 5. Ejecutar restore real

```bash
node .github/scripts/restore.js backups/backup_2026-05-18_05h.json
```

#### 6. Verificar

Andá a `gestion-estrategica.vercel.app`, logueate, y verifica que los datos restaurados aparezcan correctamente.

### Opciones avanzadas

**Restaurar solo un colegio:**
```bash
node .github/scripts/restore.js backups/backup_2026-05-18_05h.json --colegio d83ed01e-6580-41e4-a557-f6aaaaf67a15
```

**Restaurar sin tabla usuarios** (útil si conflicta con `auth.users` actual):
```bash
node .github/scripts/restore.js backups/backup_2026-05-18_05h.json --skip-usuarios
```

**Combinado (dry-run + colegio específico):**
```bash
node .github/scripts/restore.js backups/backup_2026-05-15_05h.json --dry-run --colegio <uuid>
```

---

## ⚠ Limitaciones conocidas

1. **No restaura `auth.users`** — passwords y sesiones de Supabase Auth no están en el backup. Si se perdieron, los usuarios deben usar "¿Olvidaste tu contraseña?" para crear una nueva.

2. **Conflictos de FK** — si el orden de inserción del script no respeta alguna FK, ese batch puede fallar. El script informa errores; revisar logs.

3. **No es atómico** — si el restore falla a la mitad, la DB queda en estado intermedio. Para evitar esto, usar un proyecto Supabase de staging primero.

4. **Modo `upsert` con `onConflict: 'id'`** — actualiza registros existentes con datos del backup. Si el registro actual fue modificado después del backup, se pierde.

---

## 🧪 Test de restore (recomendado anualmente)

Para asegurar que el sistema realmente funciona en caso de emergencia:

1. Crear un proyecto Supabase **de staging** (no prod) — Supabase free permite múltiples proyectos.
2. Aplicar las mismas migraciones / schema que prod.
3. Hacer un dry-run con el último backup.
4. Hacer un restore completo a staging.
5. Verificar que los datos hayan quedado consistentes (queries de spot-check).
6. Documentar tiempo total que tomó.

Esto se hace **antes** de necesitarlo. Si nunca se probó, no se puede asumir que funciona.

---

## 📞 Contacto

Si necesitas ayuda con restore o detectaste problema con el sistema de backup:
- Email: `jcorrea@estrategica.cl`

Sistema mantenido por [@jcorrea647](https://github.com/jcorrea647).
