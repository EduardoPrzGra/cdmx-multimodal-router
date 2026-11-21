import json
import math
import os
import re
import unicodedata
from collections import defaultdict
import pandas as pd
import networkx as nx

# ==========================================
# CONFIGURACIÓN DE RUTAS Y PARÁMETROS
# ==========================================
GTFS_DIR = "./gtfs_cdmx"  # Carpeta donde descomprimiste el ZIP
OUTPUT_JSON = "./docs/data/grafo_multimodal.json"

AGENCIAS_OBJETIVO = ["METRO", "MB"]
MAX_DIST_CAMINATA_M = 800   # Radio máximo para aristas de caminata (metros)
FACTOR_URBANO = 1.25        # Ajuste de distancia recta a calles reales
VEL_CAMINATA_M_MIN = 75.0   # 4.5 km/h

# Tiempos estimados de transbordo interno en estaciones grandes del Metro (minutos)
TRANSBORDOS_LARGOS_METRO = {
    "pantitlan": 9.0,
    "la raza": 8.5,
    "atlalilco": 8.0,
    "guerrero": 6.5,
    "tacubaya": 6.5,
    "chabacano": 6.0,
    "hidalgo": 5.5,
    "pino suarez": 5.5,
    "balderas": 5.0,
    "centro medico": 5.5,
    "ermita": 6.0,
    "mixcoac": 6.0,
}

# Polígonos aproximados (bounding boxes) de zonas históricas de conflicto vial
ZONAS_CONFLICTO = {
    "corredor_reforma": (19.4200, 19.4385, -99.1780, -99.1480),
    "centro_historico": (19.4240, 19.4395, -99.1480, -99.1260),
    "insurgentes_centro": (19.4150, 19.4330, -99.1680, -99.1560),
    "balderas_juarez": (19.4240, 19.4375, -99.1530, -99.1440),
}

# ==========================================
# FUNCIONES AUXILIARES
# ==========================================
def normalizar_texto(texto: str) -> str:
    texto = str(texto).strip().lower()
    texto = "".join(
        c for c in unicodedata.normalize("NFD", texto)
        if unicodedata.category(c) != "Mn"
    )
    texto = re.sub(r"[^a-z0-9\s]", "", texto)
    return re.sub(r"\s+", " ", texto).strip()

def haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def tiempo_gtfs_a_min(t_str: str) -> float:
    """Convierte HH:MM:SS (incluso >24:00:00) a minutos."""
    try:
        h, m, s = map(int, str(t_str).split(":"))
        return h * 60.0 + m + s / 60.0
    except Exception:
        return None

def detectar_zona_conflicto(lat: float, lon: float, sistema: str) -> str:
    if sistema == "METRO":
        return "ninguna"  # Inmune a bloqueos superficiales por marchas
    for zona, (lat_min, lat_max, lon_min, lon_max) in ZONAS_CONFLICTO.items():
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return zona
    return "ninguna"

# ==========================================
# 1. CARGA Y FILTRADO DEL GTFS
# ==========================================
print("Cargando archivos GTFS...")
routes = pd.read_csv(os.path.join(GTFS_DIR, "routes.txt"), dtype=str)
trips = pd.read_csv(os.path.join(GTFS_DIR, "trips.txt"), dtype=str)
stops = pd.read_csv(os.path.join(GTFS_DIR, "stops.txt"), dtype=str)
stop_times = pd.read_csv(os.path.join(GTFS_DIR, "stop_times.txt"), dtype=str)

# Filtrar solo METRO y MB
routes = routes[routes["agency_id"].isin(AGENCIAS_OBJETIVO)].copy()
trips = trips[trips["route_id"].isin(routes["route_id"])].copy()
stop_times = stop_times[stop_times["trip_id"].isin(trips["trip_id"])].copy()

stops["stop_lat"] = stops["stop_lat"].astype(float)
stops["stop_lon"] = stops["stop_lon"].astype(float)
stop_times["stop_sequence"] = stop_times["stop_sequence"].astype(int)

# Unir información relevante
st = stop_times.merge(trips[["trip_id", "route_id"]], on="trip_id", how="inner")
st = st.merge(routes[["route_id", "agency_id", "route_short_name", "route_color"]], on="route_id", how="inner")
st = st.merge(stops[["stop_id", "stop_name", "stop_lat", "stop_lon"]], on="stop_id", how="inner")

st["stop_norm"] = st["stop_name"].apply(normalizar_texto)
st["node_id"] = st["agency_id"] + "_" + st["route_short_name"].fillna(st["route_id"]) + "_" + st["stop_norm"].str.replace(" ", "_")

# ==========================================
# 2. CONSTRUCCIÓN DE NODOS CANÓNICOS
# ==========================================
print("Construyendo nodos...")
nodos_df = (
    st.groupby("node_id", as_index=False)
    .agg(
        nombre=("stop_name", "first"),
        nombre_norm=("stop_norm", "first"),
        sistema=("agency_id", "first"),
        linea=("route_short_name", "first"),
        color=("route_color", "first"),
        lat=("stop_lat", "mean"),
        lon=("stop_lon", "mean"),
    )
)

grafo = {}
for _, row in nodos_df.iterrows():
    zona = detectar_zona_conflicto(row["lat"], row["lon"], row["sistema"])
    color_hex = f"#{row['color']}" if pd.notna(row["color"]) and row["color"] != "" else ("#FF6B00" if row["sistema"] == "MB" else "#00A8E8")
    grafo[row["node_id"]] = {
        "id": row["node_id"],
        "nombre": row["nombre"],
        "sistema": row["sistema"],
        "linea": str(row["linea"]),
        "color": color_hex,
        "coords": [round(row["lat"], 6), round(row["lon"], 6)],
        "zona_conflicto": zona,
        "indice_cierres_historicos": 0.75 if zona != "ninguna" else 0.10,
        "vecinos": []
    }

# ==========================================
# 3. ARISTAS DE VIAJE (METRO Y METROBÚS)
# ==========================================
print("Extrayendo tramos de viaje...")
st = st.sort_values(["trip_id", "stop_sequence"])
st["t_min"] = st["arrival_time"].apply(tiempo_gtfs_a_min)

tramos_tiempos = defaultdict(list)

for _, grupo in st.groupby("trip_id"):
    nodos_seq = grupo["node_id"].tolist()
    tiempos_seq = grupo["t_min"].tolist()
    sistema = grupo["agency_id"].iloc[0]

    for i in range(len(nodos_seq) - 1):
        u, v = nodos_seq[i], nodos_seq[i + 1]
        if u == v:
            continue
        dt = None
        if tiempos_seq[i] is not None and tiempos_seq[i + 1] is not None:
            diff = tiempos_seq[i + 1] - tiempos_seq[i]
            if 0.3 <= diff <= 25.0:
                dt = diff
        if dt is None:
            # Fallback por distancia y velocidad comercial (Metro 32 km/h, MB 18 km/h)
            c1, c2 = grafo[u]["coords"], grafo[v]["coords"]
            dist_m = haversine_m(c1[0], c1[1], c2[0], c2[1])
            vel_m_min = 533.0 if sistema == "METRO" else 300.0
            dt = max(1.0, dist_m / vel_m_min)

        tramos_tiempos[(u, v, sistema.lower())].append(dt)

# Guardar aristas directas (usando mediana de tiempos)
aristas_existentes = set()
for (u, v, tipo), lista_t in tramos_tiempos.items():
    tiempo_med = round(float(pd.Series(lista_t).median()), 2)
    c1, c2 = grafo[u]["coords"], grafo[v]["coords"]
    dist_m = round(haversine_m(c1[0], c1[1], c2[0], c2[1]))
    grafo[u]["vecinos"].append({
        "destino": v,
        "tiempo_min": tiempo_med,
        "distancia_m": dist_m,
        "tipo": tipo
    })
    aristas_existentes.add((u, v))

# ==========================================
# 4. ARISTAS DE TRANSBORDO INTERNO Y CAMINATA
# ==========================================
print("Calculando transbordos y caminatas intermodales...")
lista_nodos = nodos_df.to_dict("records")
n = len(lista_nodos)

for i in range(n):
    a = lista_nodos[i]
    for j in range(i + 1, n):
        b = lista_nodos[j]
        u, v = a["node_id"], b["node_id"]

        dist_m = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        if dist_m > MAX_DIST_CAMINATA_M:
            continue

        # Caso A: Transbordo interno (mismo sistema, distinta línea, mismo nombre o muy cerca)
        mismo_sistema = a["sistema"] == b["sistema"]
        distinta_linea = a["linea"] != b["linea"]
        mismo_nombre = a["nombre_norm"] == b["nombre_norm"]

        if mismo_sistema and distinta_linea and (mismo_nombre or dist_m <= 120):
            if a["sistema"] == "METRO":
                t_trans = TRANSBORDOS_LARGOS_METRO.get(a["nombre_norm"], 4.0)
                tipo = "transbordo_metro"
            else:
                t_trans = 3.0
                tipo = "transbordo_mb"

            for orig, dest in [(u, v), (v, u)]:
                if (orig, dest) not in aristas_existentes:
                    grafo[orig]["vecinos"].append({
                        "destino": dest,
                        "tiempo_min": t_trans,
                        "distancia_m": round(dist_m),
                        "tipo": tipo
                    })
                    aristas_existentes.add((orig, dest))

        # Caso B: Caminata (intermodal Metro<->MB o rodeo peatonal entre estaciones)
        else:
            dist_real = round(dist_m * FACTOR_URBANO)
            t_cam = round(max(1.5, dist_real / VEL_CAMINATA_M_MIN), 1)
            for orig, dest in [(u, v), (v, u)]:
                if (orig, dest) not in aristas_existentes:
                    grafo[orig]["vecinos"].append({
                        "destino": dest,
                        "tiempo_min": t_cam,
                        "distancia_m": dist_real,
                        "tipo": "caminata"
                    })
                    aristas_existentes.add((orig, dest))

# ==========================================
# 5. VALIDACIÓN CON NETWORKX Y EXPORTACIÓN
# ==========================================
G = nx.DiGraph()
conteo_tipos = defaultdict(int)
for u, data in grafo.items():
    G.add_node(u)
    for edge in data["vecinos"]:
        G.add_edge(u, edge["destino"], weight=edge["tiempo_min"], tipo=edge["tipo"])
        conteo_tipos[edge["tipo"]] += 1

print(f"\n--- RESUMEN DEL GRAFO MULTIMODAL ---")
print(f"Total de nodos (estaciones por línea): {G.number_of_nodes()}")
print(f"Total de aristas dirigidas: {G.number_of_edges()}")
for k, v in conteo_tipos.items():
    print(f"  - {k}: {v}")
print(f"Componentes débilmente conexas: {nx.number_weakly_connected_components(G)}")

os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)
with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
    json.dump(grafo, f, ensure_ascii=False, indent=2)

print(f"\nArchivo generado correctamente en: {OUTPUT_JSON}")