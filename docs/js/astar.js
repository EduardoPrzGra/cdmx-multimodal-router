/**
 * Multimodal A* Algorithm with admissible heuristic and Markov risk penalty
 */
class MinHeap {
  constructor() { this.data = []; }
  push(item) {
    this.data.push(item);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.data[p].f <= this.data[i].f) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }
  pop() {
    if (this.data.length === 0) return null;
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      while (true) {
        let l = 2 * i + 1, r = 2 * i + 2, s = i;
        if (l < this.data.length && this.data[l].f < this.data[s].f) s = l;
        if (r < this.data.length && this.data[r].f < this.data[s].f) s = r;
        if (s === i) break;
        [this.data[i], this.data[s]] = [this.data[s], this.data[i]];
        i = s;
      }
    }
    return top;
  }
  get size() { return this.data.length; }
}

const AStarEngine = {
  haversineM(c1, c2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(c2[0] - c1[0]);
    const dLon = toRad(c2[1] - c1[1]);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(c1[0])) * Math.cos(toRad(c2[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  // Admissible heuristic: straight-line distance / max Metro speed (50 km/h = 833.33 m/min)
  heuristica(nodoA, nodoDestino) {
    return this.haversineM(nodoA.coords, nodoDestino.coords) / 833.33;
  },

  buscarRuta(grafo, markovData, origenId, destinoId, opciones) {
    const {
      modoResiliente = true,
      alpha = 2.0,
      maxCaminataM = 600,
      franja = "tarde_pico",
      lluvia = false,
      nodosBloqueados = new Set(),
    } = opciones;

    const nodoDestino = grafo[destinoId];
    if (!grafo[origenId] || !nodoDestino) return null;

    if (modoResiliente && (nodosBloqueados.has(origenId) || nodosBloqueados.has(destinoId))) {
      return { error: "Origin or destination station is currently blocked." };
    }

    const openSet = new MinHeap();
    const gScore = { [origenId]: 0 };
    const cameFrom = {};
    const visitados = new Set();

    openSet.push({ id: origenId, f: this.heuristica(grafo[origenId], nodoDestino) });

    while (openSet.size > 0) {
      const actual = openSet.pop().id;
      if (actual === destinoId) {
        return this.reconstruirRuta(cameFrom, actual, grafo, markovData, franja, lluvia, nodosBloqueados);
      }
      if (visitados.has(actual)) continue;
      visitados.add(actual);

      for (const arista of grafo[actual].vecinos) {
        const vecinoId = arista.destino;
        if (visitados.has(vecinoId)) continue;

        // Hard constraint: blocked node
        if (modoResiliente && nodosBloqueados.has(vecinoId)) continue;

        // Max outdoor walking constraint
        if (arista.tipo === "caminata" && arista.distancia_m > maxCaminataM) continue;

        // Edge cost g(u, v)
        let costo = arista.tiempo_min;
        if (arista.tipo === "caminata") {
          costo = arista.tiempo_min * 1.8;
        } else if (arista.tipo.startsWith("transbordo")) {
          costo = arista.tiempo_min * 1.3;
        } else if (modoResiliente) {
          const { riesgo } = MarkovEngine.calcularRiesgoNodo(
            grafo[vecinoId], grafo, markovData, franja, lluvia, nodosBloqueados
          );
          costo = arista.tiempo_min * (1 + alpha * riesgo);
        }

        const tentativeG = gScore[actual] + costo;
        if (tentativeG < (gScore[vecinoId] ?? Infinity)) {
          cameFrom[vecinoId] = { previo: actual, arista };
          gScore[vecinoId] = tentativeG;
          const f = tentativeG + this.heuristica(grafo[vecinoId], nodoDestino);
          openSet.push({ id: vecinoId, f });
        }
      }
    }

    return { error: "No route available with the current disruptions and walking limit." };
  },

  reconstruirRuta(cameFrom, destinoId, grafo, markovData, franja, lluvia, nodosBloqueados) {
    const pasos = [];
    let actual = destinoId;
    let tiempoTotal = 0;
    let caminataTotalM = 0;
    let transbordos = 0;
    let sumaRiesgo = 0;
    let tramosTransporte = 0;

    while (cameFrom[actual]) {
      const { previo, arista } = cameFrom[actual];
      tiempoTotal += arista.tiempo_min;
      if (arista.tipo === "caminata") caminataTotalM += arista.distancia_m;
      if (arista.tipo.startsWith("transbordo") || arista.tipo === "caminata") transbordos += 1;

      if (arista.tipo === "mb" || arista.tipo === "metro") {
        const { riesgo } = MarkovEngine.calcularRiesgoNodo(
          grafo[actual], grafo, markovData, franja, lluvia, nodosBloqueados
        );
        sumaRiesgo += riesgo;
        tramosTransporte += 1;
      }

      pasos.unshift({ origen: previo, destino: actual, arista });
      actual = previo;
    }

    return {
      pasos,
      tiempoTotal: Number(tiempoTotal.toFixed(1)),
      caminataTotalM: Math.round(caminataTotalM),
      transbordos,
      riesgoPromedio: tramosTransporte > 0 ? Number((sumaRiesgo / tramosTransporte).toFixed(2)) : 0
    };
  }
};