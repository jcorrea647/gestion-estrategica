// generar-brecha-avanzado v7.2
// v7.2: agrega campo top-level "causales_top_3" — array de hasta 3 códigos
// (ej. ["C6","C8","C5"]) que el frontend usa para pre-marcar causales y
// garantizar consistencia con el texto del resumen. Antes el frontend
// calculaba esto por su cuenta y daba resultados distintos a los del texto.

import Anthropic from "npm:@anthropic-ai/sdk@0.27.3";

const client = new Anthropic();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_CHARS_DOC = 120000;

const CAUSALES_CATALOGO = `
ESTRUCTURALES:
- C1 Tiempo: tiempo dedicado a la acción, prioridad horaria, espacio en agenda.
- C2 Recursos materiales: infraestructura, equipamiento, materiales pedagógicos.
- C3 Recursos humanos: dotación, cobertura, disponibilidad de personas.
- C4 Competencias técnicas: capacidades técnicas o pedagógicas instaladas.
- C5 Coordinación entre cargos: articulación entre equipo directivo, UTP, docentes.
- C6 Definición poco clara: claridad de la acción, criterios, alcance, responsables.
- C7 Datos o información: disponibilidad y calidad de datos para decidir.
- C8 Evaluación y monitoreo: sistemas de seguimiento, análisis de resultados.
- C9 Causas externas: factores fuera del control del establecimiento.

RELACIONALES:
- C10 Liderazgo directivo: claridad y firmeza de la conducción del proceso.
- C11 Cultura institucional: hábitos, normas implícitas, expectativas compartidas, visión común.
- C12 Resistencia al cambio: actitudes frente a nuevas prácticas o procesos.
- C13 Comunicación interna: cómo circula la información entre actores del colegio.
- C14 Clima laboral: vínculos, confianza, motivación, satisfacción en el equipo.
- C15 Participación docente: implicación activa de docentes en la acción.
- C16 Compromiso estudiantil: implicación de estudiantes con la acción.
- C17 Vinculación con familias: vínculo con apoderados, lineamientos hacia las familias.
`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { colegio_id, accion_id, accion_nombre, accion_descripcion, pct, banda, mes } = body;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

    let colegioNombre = "el establecimiento";
    let colegioComuna = "";
    try {
      const colegioResp = await fetch(
        `${supabaseUrl}/rest/v1/colegios?id=eq.${colegio_id}&select=nombre,comuna`,
        { headers }
      );
      const colegios = await colegioResp.json();
      if (colegios?.[0]) {
        colegioNombre = colegios[0].nombre || "el establecimiento";
        colegioComuna = colegios[0].comuna || "";
      }
    } catch (e) { console.warn("[v7.2] Error fetch colegios:", e.message); }

    let textoPEI = "", textoPME = "", textoFASE = "";
    let docsDisponibles = [];

    try {
      const docsResp = await fetch(
        `${supabaseUrl}/rest/v1/colegio_documentos?colegio_id=eq.${colegio_id}&estado=eq.LISTO&select=tipo,texto_extraido`,
        { headers }
      );
      const docs = await docsResp.json();
      if (Array.isArray(docs)) {
        for (const doc of docs) {
          const txt = (doc.texto_extraido || "").trim();
          if (!txt) continue;
          const truncado = txt.slice(0, MAX_CHARS_DOC);
          if (doc.tipo === "PEI") { textoPEI = truncado; docsDisponibles.push("PEI"); }
          else if (doc.tipo === "PME_2025") { textoPME = truncado; docsDisponibles.push("Análisis PME 2025 Mineduc"); }
          else if (doc.tipo === "FASE_2026") { textoFASE = truncado; docsDisponibles.push("Fase Estratégica PME 2026"); }
        }
      }
    } catch (e) { console.warn("[v7.2] Error fetch colegio_documentos:", e.message); }

    const nombreAccion = (accion_nombre || "").trim() || "la acción evaluada";
    const descripcionAccion = (accion_descripcion || "").trim();
    const hayDocumentos = docsDisponibles.length > 0;

    const nivelNum = !pct ? 1 : pct <= 25 ? 1 : pct <= 50 ? 2 : pct <= 70 ? 3 : pct <= 90 ? 4 : 5;
    const nivelNombre = nivelNum === 1 ? "Inicial" : nivelNum === 2 ? "Básico" : nivelNum === 3 ? "En Desarrollo" : nivelNum === 4 ? "Satisfactorio" : "Consolidado";

    if (!hayDocumentos) {
      return new Response(JSON.stringify({
        modo: "FALLBACK_SIN_CONTEXTO",
        mensaje: "Para recibir un análisis personalizado con citas del PEI del colegio, carga los documentos institucionales desde Configuración → Documentos.",
        resumen: "",
        causales_top_3: [],
        brechas: [],
        fuentes_consultadas: [],
        _meta: { colegio: colegioNombre, accion: nombreAccion, nivel: nivelNombre }
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const contextoDocs = [
      textoPEI ? `### PEI · Proyecto Educativo Institucional de ${colegioNombre}\n${textoPEI}` : "",
      textoPME ? `### Análisis PME 2025 del Mineduc para ${colegioNombre}\n${textoPME}` : "",
      textoFASE ? `### Fase Estratégica PME 2026 de ${colegioNombre}\n${textoFASE}` : ""
    ].filter(Boolean).join("\n\n---\n\n");

    const prompt = `Eres un experto en mejoramiento escolar chileno. Vas a analizar una acción específica del plan de monitoreo de un colegio chileno usando EXCLUSIVAMENTE los documentos institucionales reales que te entrego.

ESTABLECIMIENTO: ${colegioNombre}${colegioComuna ? `, ${colegioComuna}` : ""}
ACCIÓN EVALUADA: ${nombreAccion}
${descripcionAccion ? `DESCRIPCIÓN DE LA ACCIÓN: ${descripcionAccion}` : ""}
NIVEL DE LOGRO ACTUAL: ${nivelNombre} (${pct ?? "?"}%)

DOCUMENTOS INSTITUCIONALES DEL COLEGIO:

${contextoDocs}

---

CATÁLOGO DE CAUSALES (úsalo en los campos "causales_sugeridas" y "causales_top_3"):
${CAUSALES_CATALOGO}

---

INSTRUCCIONES CRÍTICAS — LEE TODAS ANTES DE GENERAR:

REGLA FUNDAMENTAL — TODO VIENE DE LOS DOCUMENTOS DEL COLEGIO:
Cada brecha que generes DEBE estar anclada en una cita textual del PEI, Análisis PME 2025 o Fase Estratégica 2026 del colegio. Cero contenido teórico genérico. No menciones EID, CIAE, Harvard, Data Wise, Instructional Rounds ni ninguna otra fuente externa. El único contenido válido es el de los documentos que te entregué.

❌ INCORRECTO: "Investigación CIAE muestra que acompañamiento sin ciclos..."
❌ INCORRECTO: "Modelo Instructional Rounds exige observación con enfoque colectivo..."
❌ INCORRECTO: "Según el marco EID 4.5..."
✅ CORRECTO: "El PEI del ${colegioNombre} declara que '[cita exacta del PEI]', pero la acción está en nivel ${nivelNombre} (${pct ?? "?"}%)..."
✅ CORRECTO: "El Análisis PME 2025 del ${colegioNombre} reporta que '[cita exacta del PME]'..."
✅ CORRECTO: "La Fase Estratégica PME 2026 del ${colegioNombre} proyecta '[cita exacta de la Fase]'..."

CANTIDAD DE BRECHAS:
- NO hay un número fijo. Genera tantas brechas como citas relevantes encuentres en los documentos del colegio respecto a la acción "${nombreAccion}".
- Si encuentras 5 citas valiosas, genera 5 brechas. Si encuentras 1, genera 1. Si encuentras 0, genera 1 brecha del tipo "sin referencias" (ver caso especial abajo).
- Cada brecha = una cita textual + análisis breve del problema.
- Prioriza calidad sobre cantidad.

CASO ESPECIAL — DOCUMENTOS NO MENCIONAN LA ACCIÓN:
Si revisaste los documentos y NO encontraste ninguna referencia significativa a la acción "${nombreAccion}", devuelve exactamente UNA brecha con:
- "diagnostico": "No se encontraron referencias específicas a esta acción en los documentos institucionales cargados del ${colegioNombre}. Considera cargar [docs faltantes] o revisar si esta acción está contemplada en una sección distinta del PEI/PME."
- "fuente_doc": "ninguna"
- "cita_textual": ""
- "causales_sugeridas": []

ESTRUCTURA DE CADA BRECHA:
{
  "fuente_doc": "PEI" | "PME_2025" | "FASE_2026",
  "cita_textual": "[la cita literal del documento, entre 5 y 25 palabras]",
  "diagnostico": "[análisis breve: cómo la cita conecta con la acción ${nombreAccion} y su nivel ${nivelNombre} (${pct ?? "?"}%). Entre 25 y 60 palabras. Refiere al PROBLEMA, no a la solución.]",
  "causales_sugeridas": [
    { "codigo": "C8", "justificacion": "[máx 25 palabras: qué frase de la cita o del diagnóstico te llevó a esta causal]" }
  ]
}

Reglas para "causales_sugeridas":
- Cada brecha puede tener entre 1 y 3 causales sugeridas, según cuántas detecten naturalmente.
- NO fuerces más de 1 si solo hay una causa raíz clara.
- NO fuerces causales distintas entre brechas: si dos brechas convergen en C5, ambas pueden listar C5.
- Cada causal del array DEBE incluir "justificacion".

NOMENCLATURA DE LA ACCIÓN:
Nunca uses "acción PME" ni "acción del PME". Usa "la acción '${nombreAccion}'" o "la acción ${nombreAccion}". El colegio tendrá su PME oficial cargado por separado y mezclar nomenclatura genera confusión.

PERSONALIZACIÓN OBLIGATORIA:
Cuando cites el PEI, PME 2025 o Fase 2026, SIEMPRE menciona el nombre del colegio: "El PEI del ${colegioNombre} declara...", "El Análisis PME 2025 del ${colegioNombre} reporta...", "La Fase Estratégica PME 2026 del ${colegioNombre} proyecta...". Nunca uses "El PEI..." sin nombre.

═══════════════════════════════════════════════════════════════════════════
CAMPO TOP-LEVEL "causales_top_3" (CRÍTICO PARA LA CONSISTENCIA):
═══════════════════════════════════════════════════════════════════════════

Además del campo "resumen" textual, DEBES devolver un campo top-level "causales_top_3" con un ARRAY DE CÓDIGOS (no nombres) de las causales más recurrentes.

EJEMPLO: "causales_top_3": ["C6","C8","C5"]

REGLAS:
1. El array contiene HASTA 3 códigos (puede ser 0, 1, 2 o 3).
2. El orden importa: el primer código es la causal MÁS recurrente, después la segunda, después la tercera.
3. Criterio de "recurrencia":
   - Cuenta cuántas veces aparece cada código distinto en los arrays "causales_sugeridas" de todas las brechas que generaste.
   - El más frecuente va primero.
   - En caso de empate, prioriza por orden de aparición: la causal que apareció antes en la primera brecha gana.
4. Si solo hay 1 o 2 causales distintas en todo el análisis, devuelve solo esas (ej. ["C5","C8"]).
5. Si no hay ninguna causal (caso de brecha "sin referencias"), devuelve "causales_top_3": [].

CONSISTENCIA CON EL RESUMEN (CRÍTICO):
La frase de cierre del campo "resumen" DEBE nombrar EXACTAMENTE las mismas causales que pongas en "causales_top_3", en el MISMO ORDEN.

❌ INCORRECTO: "causales_top_3": ["C6","C8","C5"] pero el resumen dice "...son Evaluación y monitoreo, Coordinación entre cargos y Clima Laboral".
✅ CORRECTO: "causales_top_3": ["C6","C8","C5"] y el resumen dice "...son Definición poco clara, Evaluación y monitoreo y Coordinación entre cargos".

ANTES DE FINALIZAR LA RESPUESTA, VERIFICA:
- ¿Las causales que nombré en el texto del resumen son exactamente las mismas que puse en "causales_top_3"?
- ¿Están en el mismo orden?
- Si la respuesta es NO a cualquiera, CORRIGE antes de enviar.

═══════════════════════════════════════════════════════════════════════════
CAMPO "resumen":
═══════════════════════════════════════════════════════════════════════════

Si generas 2 o más brechas, escribe también un campo "resumen" con la siguiente ESTRUCTURA FIJA:

1. Una síntesis narrativa de 2-3 oraciones que empiece con "El análisis del ${colegioNombre} muestra que los documentos institucionales cargados ([lista de docs disponibles entre paréntesis]) [verbo: enfatizan/declaran/proyectan] [tema principal], pero [contraste con el nivel actual]. El nivel ${nivelNombre} (${pct ?? "?"}%) de la acción refleja [tipo de brecha: declarativa vs operativa, intención vs sistematización, etc.]."

2. Una frase de cierre con la conclusión accionable, EN UNA LÍNEA APARTE, con el siguiente formato exacto:
"Las 3 causales más recurrentes por tanto son [Nombre Causal 1], [Nombre Causal 2] y [Nombre Causal 3]."

Los nombres deben corresponder EXACTAMENTE a los códigos del array "causales_top_3".

Si generas solo 1 brecha, devuelve "resumen": "" (vacío) y "causales_top_3": [<el código de la única causal sugerida, si existe>].

Responde SOLO con JSON válido, sin markdown, sin texto antes ni después:

{
  "resumen": "...",
  "causales_top_3": ["C6","C8","C5"],
  "brechas": [
    {
      "fuente_doc": "PEI",
      "cita_textual": "...",
      "diagnostico": "...",
      "causales_sugeridas": [
        { "codigo": "C8", "justificacion": "..." }
      ]
    }
  ],
  "documentos_colegio_consultados": ${JSON.stringify(docsDisponibles)}
}`;

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content[0].text.trim();
    const clean = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const result = JSON.parse(clean);

    result.modo = "PERSONALIZADO";
    result._meta = { colegio: colegioNombre, accion: nombreAccion, nivel: nivelNombre, docs: docsDisponibles };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("generar-brecha-avanzado v7.2:", e);
    return new Response(JSON.stringify({
      modo: "ERROR",
      error: e.message,
      resumen: "",
      causales_top_3: [],
      brechas: [],
      fuentes_consultadas: []
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
