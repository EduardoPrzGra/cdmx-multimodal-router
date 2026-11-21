/**
 * Módulo de Modelos de Markov (proyección a k pasos + efecto dominó por bloqueos)
 */
const MarkovEngine = {
  multiplicarVectorMatriz(vec, mat) {
    const res = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        res[j] += vec[i] * mat[i][j];
      }
    }
    return res;
  },

  /**
   * Calcula el riesgo esperado de un nodo proyectando k pasos en su cadena de Markov.
   * Si un vecino está bloqueado, aplica efecto dominó desplazando el estado inicial a Saturado.
   */
  calcularRiesgoNodo(nodo, grafo, markovData, franja, lluvia, nodosBloqueados, pasos = 2) {
    const sis = nodo.sistema;
    const lin = nodo.linea;
    const matriz = markovData.matrices?.[sis]?.[lin]?.[franja];
    if (!matriz) return { probs: [0.8, 0.15, 0.05], riesgo: 0.1 };

    // Verificar efecto dominó (algún vecino directo bloqueado)
    const vecinoBloqueado = nodo.vecinos.some((v) => nodosBloqueados.has(v.destino));
    let estado = vecinoBloqueado ? [0.15, 0.65, 0.20] : [0.75, 0.20, 0.05];

    // Proyección de Markov a k pasos: v_k = v_0 * P^k
    for (let k = 0; k < pasos; k++) {
      estado = this.multiplicarVectorMatriz(estado, matriz);
    }

    // Riesgo ponderado: Saturado (0.6) + Bloqueado (1.8)
    let riesgo = estado[1] * 0.6 + estado[2] * 1.8;

    // Ajuste por lluvia (marcha de seguridad en tramos superficiales / tráfico en MB)
    if (lluvia) {
      const factorLluvia = markovData.factores_lluvia?.[sis]?.[lin] || 1.1;
      riesgo *= factorLluvia;
    }

    return { probs: estado, riesgo };
  }
};