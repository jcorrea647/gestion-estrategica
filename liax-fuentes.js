/* ═══════════════════════════════════════════════════════════════
   LIAX — FUENTES DE DATOS DEL CURSO (módulo externo, patrón IIFE)

   Qué hace:
     · Panel (director/sostenedor/SA): registrar 1 hoja de Google Sheets
       por curso y tipo (academico | asistencia | convivencia).
     · Chips (profe): activar sus fuentes en el sidebar de contexto.
     · Lectura EN VIVO: al generar, descarga la hoja desde Drive en ese
       momento y la inyecta como adjunto de texto. NO guarda el contenido.

   Caché: 3 minutos en memoria (solo para no re-descargar dentro de la
   misma sesión de trabajo). El dato nunca tiene más de 3 min.

   Aislamiento: si algo falla, cae en silencio. Los chips solo aparecen
   si el colegio del docente tiene fuentes registradas para su curso —
   por lo tanto en colegios sin fuentes (p. ej. Perú/INDI) no cambia nada.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var TTL_MS = 3 * 60 * 1000;          // 3 minutos
  var _cache = {};                      // sheetId -> {t, texto}
  var _fuentes = [];                    // fuentes del curso del docente
  var _activas = {};                    // tipo -> bool (elección del profe)
  var _estado  = {};                    // tipo -> 'ok' | 'error'
  var _modif   = {};                    // sheetId -> fecha ISO de modificación

  var TIPOS = [
    { id:'academico',   icono:'\uD83D\uDCCA', label:'Académico'   },
    { id:'asistencia',  icono:'\u2705',       label:'Asistencia'  },
    { id:'convivencia', icono:'\uD83D\uDCCB', label:'Convivencia' }
  ];

  var C = { verde:'#1E3A2F', verde2:'#2D5A42', crema:'#FDFAF7',
            borde:'#e6e0d4', muted:'#8a8577' };

  // ── Utilidades ───────────────────────────────────────────────
  function _rol() {
    try { return (_supaPerfil && _supaPerfil.rol) || (typeof currentRole !== 'undefined' ? currentRole : ''); }
    catch (e) { return ''; }
  }
  function _colegioId() {
    try { return (_supaPerfil && _supaPerfil.colegio_id) || null; } catch (e) { return null; }
  }
  function _cursoDocente() {
    try {
      // 1) Curso del selector de CONTEXTO (es el que el docente ve arriba).
      if (typeof CTX !== 'undefined' && CTX && CTX.cursos && CTX.cursos.size) {
        return Array.from(CTX.cursos)[0];
      }
      // 2) Curso del perfil, si lo tiene.
      if (_supaPerfil && _supaPerfil.curso) return _supaPerfil.curso;
      if (typeof cursoActual !== 'undefined' && cursoActual) return cursoActual;
      return null;
    } catch (e) { return null; }
  }
  function _puedeAdministrar() {
    return ['director','sostenedor','superadmin'].indexOf(_rol()) >= 0;
  }
  function _sheetIdDe(url) {
    var m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  // ── Lectura EN VIVO de una hoja (con caché de 3 min) ─────────
  // Pasa por /api/drive-csv (servidor): el navegador NO puede leer
  // docs.google.com por CORS, y así la API key nunca sale del backend.
  function leerHoja(sheetId, gid) {
    var key = sheetId + '|' + (gid || '');
    var c = _cache[key];
    if (c && (Date.now() - c.t) < TTL_MS) return Promise.resolve(c.texto);

    var url = '/api/drive-csv?id=' + encodeURIComponent(sheetId);
    if (gid) url += '&gid=' + encodeURIComponent(gid);

    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('endpoint ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok || !d.csv || !d.csv.trim()) {
          throw new Error((d && d.error) || 'sin datos');
        }
        if (d.modifiedTime) _modif[sheetId] = d.modifiedTime;
        _cache[key] = { t: Date.now(), texto: d.csv };
        return d.csv;
      });
  }

  // ── Cargar las fuentes del curso del docente ─────────────────
  function cargarFuentes() {
    return new Promise(function (resolve) {
      try {
        var col = _colegioId(), cur = _cursoDocente();
        if (typeof _supa === 'undefined' || !_supa || !col || !cur) { resolve([]); return; }
        _supa.rpc('liax_fuentes_de_curso', { p_colegio_id: col, p_curso: cur })
          .then(function (r) {
            _fuentes = (r && Array.isArray(r.data)) ? r.data : [];
            resolve(_fuentes);
          })
          .catch(function () { _fuentes = []; resolve([]); });
      } catch (e) { _fuentes = []; resolve([]); }
    });
  }

  // ── Fecha de última modificación en Drive (vía /api/drive-info) ──
  // La API key vive en Vercel, no en el navegador. Si el endpoint no está
  // disponible, simplemente no se muestra la fecha: nada más se rompe.
  function _cargarModificados() {
    try {
      var ids = _fuentes.map(function (f) { return f.sheet_id; }).filter(Boolean);
      if (!ids.length) return Promise.resolve();
      return fetch('/api/drive-info?ids=' + encodeURIComponent(ids.join(',')))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.ok || !d.files) return;
          Object.keys(d.files).forEach(function (id) {
            if (d.files[id] && d.files[id].modifiedTime) {
              _modif[id] = d.files[id].modifiedTime;
            }
          });
        })
        .catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  // "hace 5 min" / "hace 3 h" / "ayer" / "12 jul"
  function _hace(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var min = Math.floor((Date.now() - d.getTime()) / 60000);
      if (min < 1)    return 'recién';
      if (min < 60)   return 'hace ' + min + ' min';
      var h = Math.floor(min / 60);
      if (h < 24)     return 'hace ' + h + ' h';
      var dias = Math.floor(h / 24);
      if (dias === 1) return 'ayer';
      if (dias < 7)   return 'hace ' + dias + ' días';
      return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
    } catch (e) { return ''; }
  }

  // ── Chips del profe ──────────────────────────────────────────
  function renderChips(host) {
    try {
      if (!host) host = document.getElementById('liaxFuentesChips');
      if (!host) return;
      if (!_fuentes.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
      host.style.display = 'block';

      var cur = _cursoDocente() || '';
      var html =
        '<div style="font-size:11px;font-weight:800;color:' + C.verde2 +
          ';letter-spacing:.04em;margin-bottom:3px">\uD83D\uDCCA DATOS DE MI CURSO' +
          (cur ? ' · ' + cur : '') + '</div>' +
        '<div style="font-size:11px;color:' + C.muted + ';margin-bottom:9px">' +
          'Se leen en vivo al generar. Activa los que necesites.</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px">';

      _fuentes.forEach(function (f) {
        var meta = TIPOS.filter(function (t) { return t.id === f.tipo; })[0] || { icono:'\uD83D\uDCC4', label:f.tipo };
        var on   = !!_activas[f.tipo];
        var err  = _estado[f.tipo] === 'error';
        var bg   = err ? '#fdeaea' : (on ? C.verde2 : '#fff');
        var col2 = err ? '#8a3a3a' : (on ? '#fff' : C.muted);
        var bd   = err ? '1.5px solid #f3c9c9' : (on ? '1.5px solid ' + C.verde2 : '1.5px solid ' + C.borde);
        var fecha = _modif[f.sheet_id] ? _hace(_modif[f.sheet_id]) : '';
        html +=
          '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">' +
            '<span data-tipo="' + f.tipo + '" class="liax-fuente-chip" ' +
              'style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:18px;' +
              'background:' + bg + ';border:' + bd + ';color:' + col2 + ';font-size:12px;' +
              'font-weight:' + (on ? '700' : '600') + ';cursor:pointer;user-select:none">' +
              meta.icono + ' ' + (f.etiqueta || meta.label) +
              (err ? ' \u26A0\uFE0F' : (on ? ' \u2713' : '')) +
            '</span>' +
            (fecha
              ? '<span style="font-size:10px;color:' + C.muted + '" title="Última edición en Google Drive">' +
                  'actualizado ' + fecha + '</span>'
              : '') +
          '</div>';
      });
      html += '</div>';
      host.innerHTML = html;

      Array.prototype.forEach.call(host.querySelectorAll('.liax-fuente-chip'), function (el) {
        el.onclick = function () {
          var t = el.getAttribute('data-tipo');
          _activas[t] = !_activas[t];
          delete _estado[t];
          renderChips(host);
        };
      });
    } catch (e) {}
  }

  // ── Inyección al generar: devuelve adjuntos de texto ─────────
  // app.html llama a esto y hace pendingAttachments.push(...) con el resultado.
  function adjuntosParaChat() {
    var pend = _fuentes.filter(function (f) { return _activas[f.tipo]; });
    if (!pend.length) return Promise.resolve([]);

    return Promise.all(pend.map(function (f) {
      return leerHoja(f.sheet_id, f.gid)
        .then(function (csv) {
          _estado[f.tipo] = 'ok';
          var meta = TIPOS.filter(function (t) { return t.id === f.tipo; })[0] || {};
          var nom  = (f.etiqueta || meta.label || f.tipo);
          return {
            name: 'Datos del curso — ' + nom,
            type: 'text',
            enabled: true,
            _fuenteCurso: true,
            content: '=== DATOS DE ' + nom.toUpperCase() + ' DEL CURSO (lectura en vivo) ===\n' +
                     csv + '\n=== FIN ' + nom.toUpperCase() + ' ==='
          };
        })
        .catch(function () { _estado[f.tipo] = 'error'; return null; });
    })).then(function (arr) {
      try { renderChips(); } catch (e) {}
      return arr.filter(Boolean);
    });
  }

  // ── Cursos REALES de un colegio (los que tienen alumnos) ─────
  // Vía RPC SECURITY DEFINER: la RLS de `alumnos` no deja consultarla
  // directamente desde el navegador, ni siquiera al superadmin.
  function _cursosDeColegio(colegioId) {
    return new Promise(function (resolve) {
      try {
        _supa.rpc('liax_cursos_de_colegio', { p_colegio_id: String(colegioId) })
          .then(function (r) {
            resolve((r && Array.isArray(r.data)) ? r.data : []);
          })
          .catch(function () { resolve([]); });
      } catch (e) { resolve([]); }
    });
  }

  // ── Panel del encargado ──────────────────────────────────────
  function abrirPanel() {
    if (!_puedeAdministrar()) return;
    var old = document.getElementById('liaxFuentesModal');
    if (old) old.remove();

    var esSA = _rol() === 'superadmin';
    var colegios = (typeof COLEGIOS !== 'undefined' && Array.isArray(COLEGIOS)) ? COLEGIOS : [];
    var colIni = _colegioId();

    var ov = document.createElement('div');
    ov.id = 'liaxFuentesModal';
    ov.style.cssText = 'position:fixed;inset:0;background:#00000099;z-index:9992;display:flex;' +
      'align-items:center;justify-content:center;padding:20px;font-family:DM Sans,sans-serif';
    ov.innerHTML =
      '<div style="background:' + C.crema + ';border:1px solid ' + C.borde + ';border-radius:14px;' +
        'width:100%;max-width:620px;max-height:85vh;overflow:auto;box-shadow:0 32px 80px #00000099">' +
        '<div style="padding:14px 18px;border-bottom:1px solid ' + C.borde + ';display:flex;align-items:center;gap:10px">' +
          '<span style="font-size:20px">\uD83D\uDCC1</span>' +
          '<div style="flex:1"><div style="font-weight:800;font-size:15px;color:' + C.verde + '">Fuentes de datos del curso</div>' +
          '<div style="font-size:11px;color:' + C.muted + '">Registra la hoja de cada curso. Los profesores la ven en vivo.</div></div>' +
          '<button id="liaxFuentesCerrar" style="background:' + C.borde + ';border:none;color:' + C.muted +
            ';width:26px;height:26px;border-radius:6px;cursor:pointer">\u2715</button>' +
        '</div>' +
        '<div style="padding:16px 18px">' +
          (esSA
            ? '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">' +
                '<span style="font-size:12px;font-weight:700;color:#5a5648;min-width:52px">Colegio:</span>' +
                '<select id="liaxFuentesColegio" style="flex:1;padding:7px 12px;border-radius:8px;border:1px solid ' +
                  C.borde + ';background:#fff;font-size:13px;font-family:inherit">' +
                  colegios.map(function (c) {
                    return '<option value="' + c.id + '"' + (String(c.id) === String(colIni) ? ' selected' : '') +
                           '>' + (c.nombre || c.id) + '</option>';
                  }).join('') +
                '</select>' +
              '</div>'
            : '') +
          '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">' +
            '<span style="font-size:12px;font-weight:700;color:#5a5648;min-width:52px">Curso:</span>' +
            '<select id="liaxFuentesCurso" style="flex:1;padding:7px 12px;border-radius:8px;border:1px solid ' +
              C.borde + ';background:#fff;font-size:13px;font-family:inherit">' +
              '<option>Cargando…</option></select>' +
          '</div>' +
          '<div id="liaxFuentesLista"></div>' +
          '<div style="margin-top:14px;padding:9px 12px;border-radius:8px;background:#FAEEDA;' +
            'border:1px solid #f0d9a8;font-size:11px;color:#854f0b">' +
            '\u26A0\uFE0F La hoja debe estar compartida como <b>«Cualquiera con el enlace → Lector»</b></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.onclick = function (e) { if (e.target === ov) ov.remove(); };
    document.getElementById('liaxFuentesCerrar').onclick = function () { ov.remove(); };

    var selCol = document.getElementById('liaxFuentesColegio');
    var selCur = document.getElementById('liaxFuentesCurso');

    function _recargarCursos() {
      var col = selCol ? selCol.value : colIni;
      var host = document.getElementById('liaxFuentesLista');
      if (host) host.innerHTML = '';
      selCur.innerHTML = '<option>Cargando…</option>';
      _cursosDeColegio(col).then(function (cursos) {
        if (!cursos.length) {
          selCur.innerHTML = '<option value="">— sin cursos con alumnos —</option>';
          if (host) host.innerHTML = '<div style="font-size:12px;color:' + C.muted +
            '">Este colegio no tiene cursos con alumnos cargados.</div>';
          return;
        }
        selCur.innerHTML = cursos.map(function (c) { return '<option>' + c + '</option>'; }).join('');
        _pintarLista(selCur.value, col);
      });
    }

    if (selCol) selCol.onchange = _recargarCursos;
    selCur.onchange = function () { _pintarLista(selCur.value, selCol ? selCol.value : colIni); };
    _recargarCursos();
  }

  function _pintarLista(curso, colegioSel) {
    var host = document.getElementById('liaxFuentesLista');
    if (!host || !curso) return;
    host.innerHTML = '<div style="font-size:12px;color:' + C.muted + '">Cargando…</div>';
    var col = colegioSel || _colegioId();
    _supa.from('fuentes_curso').select('*')
      .eq('colegio_id', col).eq('curso', curso)
      .then(function (r) {
        var filas = (r && r.data) ? r.data : [];
        var html = '<div style="display:flex;flex-direction:column;gap:9px">';
        TIPOS.forEach(function (t) {
          var f = filas.filter(function (x) { return x.tipo === t.id; })[0];
          if (f) {
            html +=
              '<div style="display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid #cde3d5;' +
                'border-radius:10px;background:#f2f8f4">' +
                '<span style="font-size:19px">' + t.icono + '</span>' +
                '<div style="flex:1;min-width:0">' +
                  '<div style="font-size:12px;font-weight:700;color:' + C.verde + '">' + t.label + '</div>' +
                  '<div style="font-size:10px;color:#5a5648;font-family:monospace;overflow:hidden;' +
                    'text-overflow:ellipsis;white-space:nowrap">' + (f.sheet_id || '') + '</div>' +
                '</div>' +
                '<span style="font-size:10px;color:' + C.verde2 + ';font-weight:700">\u2713 Conectada</span>' +
                '<button data-cambiar="' + t.id + '" style="padding:5px 10px;border-radius:7px;border:1px solid ' +
                  C.borde + ';background:#fff;font-size:11px;cursor:pointer">Cambiar</button>' +
              '</div>';
          } else {
            html +=
              '<div style="display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px dashed #e0d5c0;' +
                'border-radius:10px;background:#fff">' +
                '<span style="font-size:19px;opacity:.5">' + t.icono + '</span>' +
                '<div style="flex:1">' +
                  '<div style="font-size:12px;font-weight:700;color:' + C.muted + '">' + t.label + '</div>' +
                  '<input data-url="' + t.id + '" placeholder="Pega aquí el enlace de la hoja…" ' +
                    'style="width:100%;margin-top:4px;padding:6px 9px;border-radius:6px;border:1px solid ' +
                    C.borde + ';font-size:11px;font-family:inherit;box-sizing:border-box">' +
                '</div>' +
                '<button data-guardar="' + t.id + '" style="padding:7px 14px;border-radius:8px;background:' +
                  C.verde2 + ';border:none;color:#fff;font-size:11px;font-weight:700;cursor:pointer">Guardar</button>' +
              '</div>';
          }
        });
        html += '</div>';
        host.innerHTML = html;

        Array.prototype.forEach.call(host.querySelectorAll('[data-guardar]'), function (b) {
          b.onclick = function () { _guardar(curso, b.getAttribute('data-guardar'), host, col); };
        });
        Array.prototype.forEach.call(host.querySelectorAll('[data-cambiar]'), function (b) {
          b.onclick = function () { _borrar(curso, b.getAttribute('data-cambiar'), host, col); };
        });
      })
      .catch(function () {
        host.innerHTML = '<div style="font-size:12px;color:#8a3a3a">No se pudieron cargar las fuentes.</div>';
      });
  }

  function _guardar(curso, tipo, host, col) {
    var inp = host.querySelector('[data-url="' + tipo + '"]');
    if (!inp) return;
    var url = (inp.value || '').trim();
    var sid = _sheetIdDe(url);
    if (!sid) { inp.style.borderColor = '#c66'; inp.placeholder = 'Enlace de Google Sheets no válido'; inp.value=''; return; }
    _supa.from('fuentes_curso').upsert({
      colegio_id: col || _colegioId(), curso: curso, tipo: tipo,
      gdrive_url: url, subido_por: (_supaUser ? _supaUser.id : null), activo: true
    }, { onConflict: 'colegio_id,curso,tipo' })
      .then(function () { _pintarLista(curso, col); })
      .catch(function () { inp.style.borderColor = '#c66'; inp.placeholder = 'No se pudo guardar'; });
  }

  function _borrar(curso, tipo, host, col) {
    _supa.from('fuentes_curso').delete()
      .eq('colegio_id', col || _colegioId()).eq('curso', curso).eq('tipo', tipo)
      .then(function () { _pintarLista(curso, col); })
      .catch(function () {});
  }

  // ── Auto-inyección del contenedor de chips en el sidebar ─────
  // El sidebar de contexto (#agentCtxCol) se RE-RENDERIZA al cambiar de
  // agente, así que esto se reevalúa periódicamente: si la caja de chips
  // ya no está en el DOM, se vuelve a colgar.
  function _asegurarHostChips() {
    var actual = document.getElementById('liaxFuentesChips');
    if (actual && document.body.contains(actual)) return true;

    var col = document.getElementById('agentCtxCol');
    if (!col) return false;

    var box = document.createElement('div');
    box.id = 'liaxFuentesChips';
    box.style.cssText = 'margin-top:10px;display:none';

    // Se cuelga justo después de la lista de archivos de contexto.
    var lista = document.getElementById('ctxFilesList');
    if (lista && lista.parentNode === col) {
      col.insertBefore(box, lista.nextSibling);
    } else {
      col.appendChild(box);
    }
    return true;
  }

  // Vigila la re-creación del sidebar y el cambio de curso en el contexto.
  var _ultCurso = null;
  function _vigilarSidebar() {
    setInterval(function () {
      try {
        var cur = _cursoDocente();

        // El docente cambió de curso en el selector de contexto → recargar.
        if (cur !== _ultCurso) {
          _ultCurso = cur;
          _activas = {};
          _estado  = {};
          _modif = {};
          cargarFuentes().then(function () {
            _asegurarHostChips();
            renderChips();
            _cargarModificados().then(function () { renderChips(); });
          });
          return;
        }

        if (!_fuentes.length) return;
        var falta = !document.getElementById('liaxFuentesChips');
        if (falta && _asegurarHostChips()) renderChips();
      } catch (e) {}
    }, 1500);
  }

  // ── API pública ──────────────────────────────────────────────
  window.LIAXFuentes = {
    cargar: function () {
      return cargarFuentes().then(function (f) {
        _asegurarHostChips();
        renderChips();
        // Las fechas llegan después; al volver se repinta con el dato.
        _cargarModificados().then(function () { renderChips(); });
        return f;
      });
    },
    adjuntos: adjuntosParaChat,
    abrirPanel: abrirPanel,
    puedeAdministrar: _puedeAdministrar,
    refrescarChips: function () { _asegurarHostChips(); renderChips(); }
  };

  // ── Acceso al panel en el menú lateral (solo encargados) ─────
  function _asegurarNav() {
    try {
      if (document.getElementById('liaxFuentesNav')) return;
      if (!_puedeAdministrar()) return;
      var ancla = document.querySelector('[onclick*="gestion-cursos"]');
      if (!ancla || !ancla.parentNode) return;
      var it = document.createElement('div');
      it.id = 'liaxFuentesNav';
      it.className = ancla.className;
      it.innerHTML = '<span>\uD83D\uDCC1</span> <span>Fuentes del Curso</span>';
      it.onclick = abrirPanel;
      ancla.parentNode.insertBefore(it, ancla.nextSibling);
    } catch (e) {}
  }

  // ── Arranque ─────────────────────────────────────────────────
  function init() {
    setTimeout(function () {
      try { _asegurarNav(); } catch (e) {}
      try { window.LIAXFuentes.cargar(); } catch (e) {}
      try { _vigilarSidebar(); } catch (e) {}
    }, 2000);
    // Reintento por si el nav se renderiza tarde
    setTimeout(function () { try { _asegurarNav(); } catch (e) {} }, 6000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
