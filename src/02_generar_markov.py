import json
import os
import re
import numpy as np

# ==========================================
# CONFIGURACIÓN DE RUTAS
# ==========================================
GRAFO_JSON = "./docs/data/grafo_multimodal.json"
OUTPUT_MARKOV = "./docs/data/matrices_markov.json"

ESTADOS = ["Fluido", "Saturado", "Bloqueado"]

FRANJAS = {
    "manana_pico": {"label": "Mañana Pico (06:30 - 09:30)", "mult_sat": 1.35, "mult_bloq": 1.15},
    "valle":       {"label": "Horario Valle (09:30 - 17:00)", "mult_sat": 0.75, "mult_bloq": 1.10},
    "tarde_pico":  {"label": "Tarde Pico (17:00 - 21:00)",   "mult_sat": 1.45, "mult_bloq": 1.40},
    "noche":       {"label": "Noche (21:00 - 00:00)",        "mult_sat": 0.55, "mult_bloq": 0.50},
}

# Líneas con mayor incidencia histórica de saturación/cierres
MB_ALTO_CONFLICTO = {"1", "3", "4", "7"}
METRO_ALTA_AFLUENCIA = {"1", "2", "3", "8", "9", "A", "B", "12"}
METRO_SUPERFICIAL_LLUVIA = {"2", "4", "9", "A", "B"}

def normalizar_linea(linea: str) -> str:
    """Extrae el número o letra principal de la línea (ej. 'Línea 1' -> '1', 'L7' -> '7')."""
    s = str(linea).strip().upper()
    m = re.search(r"(\d+|[AB])$", s)
    return m.group(1) if m else s

def normalizar_matriz(M: np.ndarray) -> np.ndarray:
    """Asegura probabilidades no negativas y que cada fila sume exactamente 1.0."""
    M = np.clip(M, 0.001, None)
    M = M / M.sum(axis=1, keepdims=True)
    return np.round(M, 4)

def distribucion_estacionaria(M: np.ndarray, pasos: int = 50) -> list:
    """Calcula el vector estacionario aproximado elevando la matriz a una potencia alta."""
    P_k = np.linalg.matrix_power(M, pasos)
    pi = P_k[0]
    pi = pi / pi.sum()
    return [round(float(x), 4) for x in pi]

def construir_matriz(sistema: str, linea_norm: str, mult_sat: float, mult_bloq: float) -> np.ndarray:
    if sistema == "MB":
        es_critica = linea_norm in MB_ALTO_CONFLICTO
        # Matriz base [Fluido, Saturado, Bloqueado]
        base = np.array([
            [0.72, 0.22, 0.06],  # Desde Fluido
            [0.28, 0.54, 0.18],  # Desde Saturado
            [0.12, 0.33, 0.55],  # Desde Bloqueado (persistencia de marcha/cierre)
        ], dtype=float)
        if es_critica:
            base[:, 1] *= 1.25
            base[:, 2] *= 1.50
    else:  # METRO
        es_alta = linea_norm in METRO_ALTA_AFLUENCIA
        base = np.array([
            [0.84, 0.14, 0.02],  # Desde Fluido
            [0.35, 0.58, 0.07],  # Desde Saturado
            [0.20, 0.45, 0.35],  # Desde Bloqueado (falla técnica / servicio provisional)
        ], dtype=float)
        if es_alta:
            base[:, 1] *= 1.35
            base[:, 2] *= 1.20

    # Aplicar multiplicadores de franja horaria
    M = base.copy()
    M[0, 1] *= mult_sat
    M[0, 2] *= mult_bloq
    M[1, 1] *= mult_sat
    M[1, 2] *= mult_bloq

    # Reajustar probabilidad de mantenerse fluido para balancear
    M[0, 0] = max(0.15, 1.0 - (M[0, 1] + M[0, 2]))
    return normalizar_matriz(M)

# ==========================================
# EJECUCIÓN PRINCIPAL
# ==========================================
with open(GRAFO_JSON, "r", encoding="utf-8") as f:
    grafo = json.load(f)

# Detectar todas las combinaciones únicas (sistema, linea) presentes en el grafo
lineas_por_sistema = {"MB": set(), "METRO": set()}
for nodo in grafo.values():
    lineas_por_sistema[nodo["sistema"]].add(nodo["linea"])

resultado = {
    "estados": ESTADOS,
    "franjas": {k: v["label"] for k, v in FRANJAS.items()},
    "factores_lluvia": {"MB": {}, "METRO": {}},
    "matrices": {"MB": {}, "METRO": {}},
    "estacionaria": {"MB": {}, "METRO": {}},
}

for sistema, lineas in lineas_por_sistema.items():
    for linea in sorted(lineas):
        lnorm = normalizar_linea(linea)

        # Factor de lluvia (marcha de seguridad en tramos superficiales / tráfico en MB)
        if sistema == "MB":
            resultado["factores_lluvia"][sistema][linea] = 1.45
        else:
            resultado["factores_lluvia"][sistema][linea] = 1.35 if lnorm in METRO_SUPERFICIAL_LLUVIA else 1.05

        resultado["matrices"][sistema][linea] = {}
        resultado["estacionaria"][sistema][linea] = {}

        for franja_id, cfg in FRANJAS.items():
            M = construir_matriz(sistema, lnorm, cfg["mult_sat"], cfg["mult_bloq"])
            # Validación estocástica
            assert np.allclose(M.sum(axis=1), 1.0, atol=1e-2), f"Error estocástico en {sistema} {linea}"
            resultado["matrices"][sistema][linea][franja_id] = M.tolist()
            resultado["estacionaria"][sistema][linea][franja_id] = distribucion_estacionaria(M)

os.makedirs(os.path.dirname(OUTPUT_MARKOV), exist_ok=True)
with open(OUTPUT_MARKOV, "w", encoding="utf-8") as f:
    json.dump(resultado, f, ensure_ascii=False, indent=2)

print("--- RESUMEN DE MODELOS DE MARKOV ---")
print(f"Líneas MB modeladas ({len(lineas_por_sistema['MB'])}): {sorted(lineas_por_sistema['MB'])}")
print(f"Líneas METRO modeladas ({len(lineas_por_sistema['METRO'])}): {sorted(lineas_por_sistema['METRO'])}")
print(f"Archivo generado correctamente en: {OUTPUT_MARKOV}")