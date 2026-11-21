let grafo = {};
let markovData = {};
let map;
let capaEstaciones, capaRutaEstatica, capaRutaResiliente;
const marcadoresNodos = {};
const bloqueosManuales = new Set();

let origenSeleccionado = null;
let destinoSeleccionado = null;
let ultimaRutaValida = null;

const ETIQUETAS_FRANJA = {
  manana_pico: "Morning Peak (06:30 - 09:30)",
  valle: "Off-Peak (09:30 - 17:00)",
  tarde_pico: "Evening Peak (17:00 - 21:00)",
  noche: "Night (21:00 - 06:30)"
};

// Official Metro & Metrobús CDMX colors (optimized for dark map contrast)
const COLORES_OFICIALES = {
  METRO: {
    "1":  "#F04E98", // Pink
    "2":  "#0072CE", // Blue
    "3":  "#AF9800", // Olive Green
    "4":  "#6BBBAE", // Cyan
    "5":  "#FFD100", // Yellow
    "6":  "#DA291C", // Red
    "7":  "#E87722", // Orange
    "8":  "#009A44", // Green
    "9":  "#9C6644", // Brown (lightened for contrast)
    "A":  "#981D97", // Purple
    "B":  "#B0B7BC", // Gray
    "12": "#D4AF37"  // Gold
  },
  MB: {
    "1":    "#E53935", // Red
    "2":    "#AB47BC", // Purple
    "3":    "#8BC34A", // Lime Green
    "4":    "#FFA726", // Orange
    "5":    "#2979FF", // Navy Blue (lightened for contrast)
    "6":    "#EC407A", // Pink
    "7":    "#26A65B", // Green
    "SL01": "#F472B6"  // L1 Support Service
  }
};

function obtenerColorLinea(sistema, linea, fallback = "#00A8E8") {
  const sis = String(sistema).trim().toUpperCase();
  let key = String(linea).trim().toUpperCase();
  if (key !== "SL01" && key.startsWith("L")) {
    key = key.slice(1);
  }
  return COLORES_OFICIALES[sis]?.[key] || fallback;
}

function formatearLinea(sistema, linea) {
  const l = String(linea).trim().toUpperCase();
  if (l === "SL01") return "L1 Support";
  if (l.startsWith("L")) return l;
  return `L${l}`;
}

function etiquetaNodo(nodo) {
  return `[${nodo.sistema} ${formatearLinea(nodo.sistema, nodo.linea)}] ${nodo.nombre}`;
}

function normalizarBusqueda(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function distanciaEdicion(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + costo);
    }
  }
  return dp[m][n];
}

function puntuarCoincidencia(opcion, query) {
  if (!query) return 0;
  const nombre = opcion.nombreNorm;
  const completo = opcion.busqueda;

  if (nombre.startsWith(query)) return 1;
  if (nombre.split(" ").some((p) => p.startsWith(query))) return 2;
  if (nombre.includes(query)) return 3;
  if (completo.includes(query)) return 4;

  if (query.length >= 3) {
    let mejorDist = Infinity;
    for (const palabra of nombre.split(" ")) {
      const recorte = palabra.slice(0, Math.max(query.length, 3));
      const d = distanciaEdicion(query, recorte);
      if (d < mejorDist) mejorDist = d;
    }
    if (mejorDist <= 2) return 5 + mejorDist;
  }
  return Infinity;
}

function resaltarTexto(etiqueta, query) {
  if (!query) return etiqueta;
  const normEtiq = normalizarBusqueda(etiqueta);
  const idx = normEtiq.indexOf(query);
  if (idx === -1) return etiqueta;
  return (
    etiqueta.slice(0, idx) +
    `<mark class="match-hl">${etiqueta.slice(idx, idx + query.length)}</mark>` +
    etiqueta.slice(idx + query.length)
  );
}

function actualizarEtiquetasSliders() {
  const alpha = parseFloat(document.getElementById("slider-riesgo").value);
  let descRiesgo = "Balanced";
  if (alpha === 0) descRiesgo = "Speed only";
  else if (alpha <= 1.5) descRiesgo = "Moderate";
  else if (alpha >= 3.5) descRiesgo = "Max safety";
  document.getElementById("val-riesgo").textContent = `${alpha.toFixed(1)} · ${descRiesgo}`;

  const metros = parseInt(document.getElementById("slider-caminata").value, 10);
  const mins = Math.round(metros / 75);
  document.getElementById("val-caminata").textContent =
    metros === 0 ? "0 m · Transfers only" : `${metros} m · ~${mins} min`;
}

function obtenerFranjaActiva() {
  const selector = document.getElementById("select-franja").value;
  const infoEl = document.getElementById("franja-auto-info");

  if (selector !== "auto") {
    infoEl.textContent = `Manual override: ${ETIQUETAS_FRANJA[selector]}`;
    return selector;
  }

  const ahora = new Date();
  const minutosDia = ahora.getHours() * 60 + ahora.getMinutes();
  const horaTexto = ahora.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

  let franja = "noche";
  if (minutosDia >= 390 && minutosDia < 570) franja = "manana_pico";
  else if (minutosDia >= 570 && minutosDia < 1020) franja = "valle";
  else if (minutosDia >= 1020 && minutosDia < 1260) franja = "tarde_pico";

  infoEl.textContent = `Current time (${horaTexto}) → ${ETIQUETAS_FRANJA[franja]}`;
  return franja;
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([19.4326, -99.1332], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  capaEstaciones = L.layerGroup().addTo(map);
  capaRutaEstatica = L.layerGroup().addTo(map);
  capaRutaResiliente = L.layerGroup().addTo(map);
}

function configurarCombobox(inputId, listId, opciones, onSelect) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let resultadosActuales = [];
  let indiceActivo = -1;

  function seleccionar(op) {
    if (!op) return;
    input.value = op.etiqueta;
    list.classList.remove("open");
    onSelect(op.id);
  }

  function actualizarResaltadoTeclado() {
    const items = list.querySelectorAll(".combobox-item");
    items.forEach((el, idx) => el.classList.toggle("active", idx === indiceActivo));
    if (indiceActivo >= 0 && items[indiceActivo]) {
      items[indiceActivo].scrollIntoView({ block: "nearest" });
    }
  }

  function renderLista(filtro = "") {
    const q = normalizarBusqueda(filtro.trim());
    resultadosActuales = opciones
      .map((op) => ({ op, score: puntuarCoincidencia(op, q) }))
      .filter((x) => x.score < Infinity)
      .sort((a, b) => a.score - b.score || a.op.etiqueta.localeCompare(b.op.etiqueta))
      .slice(0, 40)
      .map((x) => x.op);

    list.innerHTML = "";
    indiceActivo = resultadosActuales.length > 0 ? 0 : -1;

    if (resultadosActuales.length === 0) {
      list.innerHTML = `<div class="combobox-empty">No matches for "${filtro}"</div>`;
      return;
    }

    resultadosActuales.forEach((op, idx) => {
      const item = document.createElement("div");
      item.className = "combobox-item" + (idx === 0 ? " active" : "");
      item.innerHTML = `<span class="line-dot" style="background:${op.color}"></span><span>${resaltarTexto(op.etiqueta, q)}</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        seleccionar(op);
      });
      list.appendChild(item);
    });
  }

  input.addEventListener("focus", () => {
    input.select();
    renderLista("");
    list.classList.add("open");
  });

  input.addEventListener("input", () => {
    renderLista(input.value);
    list.classList.add("open");
  });

  input.addEventListener("keydown", (e) => {
    if (!list.classList.contains("open")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      indiceActivo = Math.min(indiceActivo + 1, resultadosActuales.length - 1);
      actualizarResaltadoTeclado();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      indiceActivo = Math.max(indiceActivo - 1, 0);
      actualizarResaltadoTeclado();
    } else if (e.key === "Enter") {
      e.preventDefault();
      seleccionar(resultadosActuales[indiceActivo] || resultadosActuales[0]);
    } else if (e.key === "Escape") {
      list.classList.remove("open");
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => list.classList.remove("open"), 150);
  });
}

function obtenerNodosBloqueados() {
  const bloqueados = new Set(bloqueosManuales);
  const zonasActivas = new Set(
    Array.from(document.querySelectorAll(".zona-check:checked")).map((el) => el.value)
  );

  for (const [id, nodo] of Object.entries(grafo)) {
    if (zonasActivas.has(nodo.zona_conflicto)) {
      bloqueados.add(id);
    }
  }
  return bloqueados;
}

function actualizarVisualBloqueos() {
  const bloqueados = obtenerNodosBloqueados();
  for (const [id, marker] of Object.entries(marcadoresNodos)) {
    const nodo = grafo[id];
    const estaBloqueado = bloqueados.has(id);
    const colorOficial = obtenerColorLinea(nodo.sistema, nodo.linea, nodo.color);
    marker.setStyle({
      radius: estaBloqueado ? 6 : 3.5,
      fillColor: estaBloqueado ? "#ef4444" : colorOficial,
      color: estaBloqueado ? "#ffffff" : "#0a0f1c",
      weight: estaBloqueado ? 1.5 : 0.8,
      fillOpacity: estaBloqueado ? 0.95 : 0.72
    });
  }

  const total = bloqueados.size;
  const pill = document.getElementById("contador-bloqueos");
  const btnLimpiar = document.getElementById("btn-limpiar");

  pill.textContent = `${total} ${total === 1 ? "station" : "stations"}`;
  pill.classList.toggle("has-blocks", total > 0);

  btnLimpiar.disabled = total === 0;
  btnLimpiar.textContent = total > 0
    ? `Clear disruptions (${total})`
    : "No active disruptions";
}

function poblarInterfaz() {
  const nodosOrdenados = Object.values(grafo).sort((a, b) =>
    etiquetaNodo(a).localeCompare(etiquetaNodo(b))
  );

  const opciones = nodosOrdenados.map((nodo) => {
    const etiqueta = etiquetaNodo(nodo);
    return {
      id: nodo.id,
      etiqueta,
      color: obtenerColorLinea(nodo.sistema, nodo.linea, nodo.color),
      nombreNorm: normalizarBusqueda(nodo.nombre),
      busqueda: normalizarBusqueda(etiqueta)
    };
  });

  for (const nodo of nodosOrdenados) {
    const texto = etiquetaNodo(nodo);
    const colorOficial = obtenerColorLinea(nodo.sistema, nodo.linea, nodo.color);
    const marker = L.circleMarker(nodo.coords, {
      radius: 3.5,
      fillColor: colorOficial,
      color: "#0a0f1c",
      weight: 0.8,
      fillOpacity: 0.72
    }).addTo(capaEstaciones);

    marker.bindTooltip(`${texto}${nodo.zona_conflicto !== "ninguna" ? " (Conflict zone)" : ""}`);
    marker.on("click", () => {
      if (bloqueosManuales.has(nodo.id)) bloqueosManuales.delete(nodo.id);
      else bloqueosManuales.add(nodo.id);
      actualizarVisualBloqueos();
      ejecutarCalculo();
    });
    marcadoresNodos[nodo.id] = marker;
  }

  configurarCombobox("input-origen", "list-origen", opciones, (id) => {
    origenSeleccionado = id;
    ejecutarCalculo(true);
  });

  configurarCombobox("input-destino", "list-destino", opciones, (id) => {
    destinoSeleccionado = id;
    ejecutarCalculo(true);
  });

  const ejemploOrig = opciones.find((o) => o.busqueda.includes("indios verdes") && o.busqueda.includes("mb l1")) || opciones[0];
  const ejemploDest = opciones.find((o) => o.busqueda.includes("chapultepec") && o.busqueda.includes("mb l7"))
    || opciones.find((o) => o.busqueda.includes("chapultepec") && o.busqueda.includes("metro"))
    || opciones[1];

  if (ejemploOrig) {
    origenSeleccionado = ejemploOrig.id;
    document.getElementById("input-origen").value = ejemploOrig.etiqueta;
  }
  if (ejemploDest) {
    destinoSeleccionado = ejemploDest.id;
    document.getElementById("input-destino").value = ejemploDest.etiqueta;
  }
}

function centrarEnRuta() {
  if (!origenSeleccionado || !destinoSeleccionado) return;
  const puntos = [];
  if (ultimaRutaValida && !ultimaRutaValida.error && ultimaRutaValida.pasos.length > 0) {
    puntos.push(grafo[ultimaRutaValida.pasos[0].origen].coords);
    for (const p of ultimaRutaValida.pasos) puntos.push(grafo[p.destino].coords);
  } else {
    puntos.push(grafo[origenSeleccionado].coords, grafo[destinoSeleccionado].coords);
  }
  if (puntos.length > 0) {
    map.fitBounds(L.latLngBounds(puntos), { padding: [50, 50], maxZoom: 15 });
  }
}

function dibujarRuta(resultado, capa, esEstatica) {
  capa.clearLayers();
  if (!resultado || resultado.error) return;

  for (const paso of resultado.pasos) {
    const orig = grafo[paso.origen];
    const dest = grafo[paso.destino];
    const c1 = orig.coords;
    const c2 = dest.coords;
    const tipo = paso.arista.tipo;

    let style;
    if (esEstatica) {
      style = { color: "#9ca3af", weight: 3, dashArray: "6, 8", opacity: 0.65 };
    } else if (tipo === "caminata") {
      style = { color: "#ffffff", weight: 3.5, dashArray: "4, 8", opacity: 0.95 };
    } else if (tipo === "metro" || tipo === "mb") {
      const colorLinea = obtenerColorLinea(dest.sistema, dest.linea, dest.color);
      L.polyline([c1, c2], { color: "#0a0f1c", weight: 8, opacity: 0.75, interactive: false }).addTo(capa);
      style = { color: colorLinea, weight: 5, opacity: 0.98 };
    } else {
      style = { color: "#a855f7", weight: 4, dashArray: "2, 6", opacity: 0.9 };
    }

    const linea = L.polyline([c1, c2], style).addTo(capa);
    if (!esEstatica) {
      let linTexto = "TRANSFER";
      if (tipo === "metro" || tipo === "mb") {
        linTexto = `${dest.sistema} ${formatearLinea(dest.sistema, dest.linea)}`;
      } else if (tipo === "caminata") {
        linTexto = "WALK";
      }
      linea.bindTooltip(`${linTexto}: ${orig.nombre} → ${dest.nombre} (${paso.arista.tiempo_min} min)`);
    }
  }

  if (!esEstatica && origenSeleccionado && destinoSeleccionado) {
    const pinA = L.divIcon({ className: "", html: `<div class="pin-marker pin-origen">A</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    const pinB = L.divIcon({ className: "", html: `<div class="pin-marker pin-destino">B</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    L.marker(grafo[origenSeleccionado].coords, { icon: pinA, interactive: false }).addTo(capa);
    L.marker(grafo[destinoSeleccionado].coords, { icon: pinB, interactive: false }).addTo(capa);
  }
}

function renderizarResultados(estatica, resiliente) {
  const contenedor = document.getElementById("resumen-metricas");
  const lista = document.getElementById("lista-tramos");
  lista.innerHTML = "";

  if (resiliente.error) {
    contenedor.innerHTML = `<p style="grid-column: span 2; color: #ef4444; font-size: 0.8rem;">${resiliente.error}</p>`;
    return;
  }

  contenedor.innerHTML = `
    <div class="metric-card">
      <h3>Static Route</h3>
      <div class="metric-val">${estatica.error ? "N/A" : estatica.tiempoTotal + " min"}</div>
      <div class="metric-sub">Walk: ${estatica.caminataTotalM ?? 0} m · Risk: ${estatica.riesgoPromedio ?? "-"}</div>
    </div>
    <div class="metric-card resiliente">
      <h3>Resilient Route (AI)</h3>
      <div class="metric-val">${resiliente.tiempoTotal} min</div>
      <div class="metric-sub">Walk: ${resiliente.caminataTotalM} m · Risk: ${resiliente.riesgoPromedio}</div>
    </div>
  `;

  const bloques = [];
  for (const p of resiliente.pasos) {
    const orig = grafo[p.origen];
    const dest = grafo[p.destino];
    const tipo = p.arista.tipo;
    const linDest = formatearLinea(dest.sistema, dest.linea);
    const colorLinea = obtenerColorLinea(dest.sistema, dest.linea, dest.color);
    const etiqueta = tipo === "caminata"
      ? `Walk ${p.arista.distancia_m} m to ${dest.nombre} (${p.arista.tiempo_min} min)`
      : tipo.startsWith("transbordo")
      ? `Transfer at ${dest.nombre} to ${dest.sistema} ${linDest} (${p.arista.tiempo_min} min)`
      : `${dest.sistema} ${linDest}`;

    const ultimo = bloques[bloques.length - 1];
    if ((tipo === "mb" || tipo === "metro") && ultimo && ultimo.clave === etiqueta) {
      ultimo.hasta = dest.nombre;
      ultimo.tiempo += p.arista.tiempo_min;
      ultimo.estaciones += 1;
    } else {
      bloques.push({
        clave: etiqueta,
        tipo: tipo.startsWith("transbordo") ? "transbordo" : tipo,
        color: colorLinea,
        desde: orig.nombre,
        hasta: dest.nombre,
        tiempo: p.arista.tiempo_min,
        estaciones: 1
      });
    }
  }

  for (const b of bloques) {
    const div = document.createElement("div");
    div.className = `tramo-item ${b.tipo}`;
    if (b.tipo === "mb" || b.tipo === "metro") {
      div.style.borderLeftColor = b.color;
      const stopWord = b.estaciones === 1 ? "stop" : "stops";
      div.textContent = `${b.clave}: ${b.desde} → ${b.hasta} (${b.estaciones} ${stopWord}, ${b.tiempo.toFixed(1)} min)`;
    } else {
      div.textContent = b.clave;
    }
    lista.appendChild(div);
  }
}

function ejecutarCalculo(ajustarZoom = false) {
  if (!origenSeleccionado || !destinoSeleccionado) return;

  const franja = obtenerFranjaActiva();
  const alpha = parseFloat(document.getElementById("slider-riesgo").value);
  const maxCaminataM = parseInt(document.getElementById("slider-caminata").value, 10);
  const lluvia = document.getElementById("check-lluvia").checked;
  const nodosBloqueados = obtenerNodosBloqueados();

  const rutaEstatica = AStarEngine.buscarRuta(grafo, markovData, origenSeleccionado, destinoSeleccionado, {
    modoResiliente: false, alpha: 0, maxCaminataM, franja, lluvia: false, nodosBloqueados: new Set()
  });

  const rutaResiliente = AStarEngine.buscarRuta(grafo, markovData, origenSeleccionado, destinoSeleccionado, {
    modoResiliente: true, alpha, maxCaminataM, franja, lluvia, nodosBloqueados
  });

  ultimaRutaValida = rutaResiliente;
  dibujarRuta(rutaEstatica, capaRutaEstatica, true);
  dibujarRuta(rutaResiliente, capaRutaResiliente, false);
  renderizarResultados(rutaEstatica, rutaResiliente);

  if (ajustarZoom) centrarEnRuta();
}

async function bootstrap() {
  initMap();
  const [resGrafo, resMarkov] = await Promise.all([
    fetch("data/grafo_multimodal.json"),
    fetch("data/matrices_markov.json")
  ]);
  grafo = await resGrafo.json();
  markovData = await resMarkov.json();

  poblarInterfaz();
  actualizarEtiquetasSliders();
  actualizarVisualBloqueos();
  ejecutarCalculo(true);

  document.getElementById("btn-swap").addEventListener("click", () => {
    const tempId = origenSeleccionado;
    origenSeleccionado = destinoSeleccionado;
    destinoSeleccionado = tempId;

    const inOrig = document.getElementById("input-origen");
    const inDest = document.getElementById("input-destino");
    const tempVal = inOrig.value;
    inOrig.value = inDest.value;
    inDest.value = tempVal;

    ejecutarCalculo(true);
  });

  document.getElementById("btn-centrar").addEventListener("click", centrarEnRuta);

  document.getElementById("btn-limpiar").addEventListener("click", () => {
    bloqueosManuales.clear();
    document.querySelectorAll(".zona-check").forEach((c) => (c.checked = false));
    document.getElementById("check-historicas").checked = false;
    actualizarVisualBloqueos();
    ejecutarCalculo();
  });

  document.getElementById("slider-riesgo").addEventListener("input", () => {
    actualizarEtiquetasSliders();
    ejecutarCalculo();
  });

  document.getElementById("slider-caminata").addEventListener("input", () => {
    actualizarEtiquetasSliders();
    ejecutarCalculo();
  });

  ["select-franja", "check-lluvia"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => ejecutarCalculo());
  });

  const checkHistoricas = document.getElementById("check-historicas");
  const zonaChecks = Array.from(document.querySelectorAll(".zona-check"));

  checkHistoricas.addEventListener("change", () => {
    zonaChecks.forEach((c) => (c.checked = checkHistoricas.checked));
    actualizarVisualBloqueos();
    ejecutarCalculo();
  });

  zonaChecks.forEach((el) => {
    el.addEventListener("change", () => {
      checkHistoricas.checked = zonaChecks.every((c) => c.checked);
      actualizarVisualBloqueos();
      ejecutarCalculo();
    });
  });
}

bootstrap();