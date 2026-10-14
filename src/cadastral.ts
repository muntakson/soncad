import { store, nextId } from './store';
import { Entity } from './types';
import { startShelterMode, ShelterMeta } from './shelter';

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3002' : '';

// EPSG:4326 (lon/lat) → EPSG:3857 (Web Mercator meters)
function lonLatToMercator(lon: number, lat: number): { x: number; y: number } {
  const x = lon * 20037508.34 / 180;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.34 / Math.PI;
  return { x, y };
}

function lonLatToTile(lon: number, lat: number, z: number): { tx: number; ty: number } {
  const n = Math.pow(2, z);
  const tx = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const ty = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { tx, ty };
}

function tileBoundsM(tx: number, ty: number, z: number): { west: number; south: number; east: number; north: number } {
  const ext = 40075016.685578488;
  const n = Math.pow(2, z);
  const tileSize = ext / n;
  const origin = -ext / 2;
  const west = origin + tx * tileSize;
  const north = -origin - ty * tileSize;
  const east = west + tileSize;
  const south = north - tileSize;
  return { west, south, east, north };
}

function ensureLayer(name: string, color: string) {
  if (!store.layers.find(l => l.name === name)) {
    store.layers.push({
      name, color, visible: true, locked: false,
      frozen: false, current: false, lineweight: 1, plot: true,
    });
  }
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

async function geocodeAddress(address: string, type: string): Promise<{ lon: number; lat: number } | null> {
  const res = await fetch(`${API_BASE}/api/vworld/geocode?address=${encodeURIComponent(address)}&type=${type}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (data.response?.status !== 'OK' || !data.response?.result?.point) return null;
  return {
    lon: parseFloat(data.response.result.point.x),
    lat: parseFloat(data.response.result.point.y),
  };
}

function makeBbox(centerM: { x: number; y: number }, halfSpan: number): string {
  return `${centerM.x - halfSpan},${centerM.y - halfSpan},${centerM.x + halfSpan},${centerM.y + halfSpan}`;
}

async function fetchVectorData(bbox: string, dataLayer: string): Promise<any[]> {
  let allFeatures: any[] = [];
  let page = 1;
  const maxPages = 5;
  while (page <= maxPages) {
    const res = await fetch(`${API_BASE}/api/vworld/data?bbox=${encodeURIComponent(bbox)}&data=${dataLayer}&page=${page}&size=1000`);
    const data = await res.json();
    if (data?.response?.status === 'ERROR') {
      throw new Error(data.response.error?.text || 'Data API error');
    }
    const features = data?.response?.result?.featureCollection?.features;
    if (!features || features.length === 0) break;
    allFeatures = allFeatures.concat(features);
    const totalPages = data?.response?.page?.total || 1;
    if (page >= totalPages) break;
    page++;
  }
  return allFeatures;
}

function extractPolygons(features: any[], centerM: { x: number; y: number }): { x: number; y: number }[][] {
  const rings: { x: number; y: number }[][] = [];
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom) continue;
    const polys: number[][][][] = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    for (const poly of polys) {
      for (const ring of poly) {
        const pts = ring.map((c: number[]) => ({ x: c[0] - centerM.x, y: c[1] - centerM.y }));
        if (pts.length >= 2) rings.push(pts);
      }
    }
  }
  return rings;
}

function extractLines(features: any[], centerM: { x: number; y: number }): { x: number; y: number }[][] {
  const lines: { x: number; y: number }[][] = [];
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom) continue;
    const lineArrays: number[][][] = [];
    if (geom.type === 'LineString') lineArrays.push(geom.coordinates);
    else if (geom.type === 'MultiLineString') lineArrays.push(...geom.coordinates);
    for (const coords of lineArrays) {
      const pts = coords.map((c: number[]) => ({ x: c[0] - centerM.x, y: c[1] - centerM.y }));
      if (pts.length >= 2) lines.push(pts);
    }
  }
  return lines;
}

function polygonCentroid(pts: { x: number; y: number }[]): { x: number; y: number } {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

// ── Satellite Tiles ──

async function fetchSatelliteTiles(
  lon: number, lat: number, centerM: { x: number; y: number },
  log: (msg: string) => void,
) {
  const z = 18;
  const { tx, ty } = lonLatToTile(lon, lat, z);
  const gridR = 2;
  const canvas = document.createElement('canvas');
  canvas.width = (gridR * 2 + 1) * 256;
  canvas.height = (gridR * 2 + 1) * 256;
  const ctx = canvas.getContext('2d')!;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let loaded = 0;
  const total = (gridR * 2 + 1) ** 2;

  for (let dy = -gridR; dy <= gridR; dy++) {
    for (let dx = -gridR; dx <= gridR; dx++) {
      const cx = tx + dx;
      const cy = ty + dy;
      try {
        const img = await loadImage(`${API_BASE}/api/vworld/satellite/${z}/${cy}/${cx}`);
        ctx.drawImage(img, (dx + gridR) * 256, (dy + gridR) * 256);
        loaded++;
      } catch {
        loaded++;
      }
      const b = tileBoundsM(cx, cy, z);
      minX = Math.min(minX, b.west);
      minY = Math.min(minY, b.south);
      maxX = Math.max(maxX, b.east);
      maxY = Math.max(maxY, b.north);
    }
  }
  log(`Satellite: ${loaded}/${total} tiles`);

  const img = new Image();
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.src = canvas.toDataURL('image/jpeg', 0.9);
  });

  ensureLayer('CADASTRAL-SAT', '#00ff00');
  store.rasterOverlays.push({
    id: `sat-${Date.now()}`,
    layer: 'CADASTRAL-SAT',
    image: img,
    bounds: {
      minX: minX - centerM.x, minY: minY - centerM.y,
      maxX: maxX - centerM.x, maxY: maxY - centerM.y,
    },
  });
}

// ── Cadastral Map Image Overlay ──

function zoomToMetersPerPixel(zoom: number): number {
  return 40075016.685578488 / (256 * Math.pow(2, zoom));
}

async function fetchCadastralImage(
  centerM: { x: number; y: number },
  log: (msg: string) => void,
) {
  const zoom = 18;
  const size = 1024;
  const center = `${centerM.x},${centerM.y}`;
  const url = `${API_BASE}/api/vworld/image?center=${encodeURIComponent(center)}&zoom=${zoom}&layers=lp_pa_cbnd_bonbun&size=${size},${size}`;
  const img = await loadImage(url);
  log('Cadastral image overlay loaded');

  const mpp = zoomToMetersPerPixel(zoom);
  const halfExtent = (size / 2) * mpp;

  ensureLayer('CADASTRAL-IMG', '#ffff00');
  store.rasterOverlays.push({
    id: `cad-img-${Date.now()}`,
    layer: 'CADASTRAL-IMG',
    image: img,
    bounds: { minX: -halfExtent, minY: -halfExtent, maxX: halfExtent, maxY: halfExtent },
  });
}

// ── Cadastral Boundaries (Vector) ──

async function fetchCadastralBoundaries(
  centerM: { x: number; y: number }, halfSpan: number, log: (msg: string) => void,
) {
  const bbox = makeBbox(centerM, halfSpan);
  const features = await fetchVectorData(bbox, 'LP_PA_CBND_BUBUN');
  if (features.length === 0) { log('No cadastral boundaries in this area'); return; }

  ensureLayer('CADASTRAL-BDRY', '#ff0000');
  const entities: Entity[] = [];
  const rings = extractPolygons(features, centerM);
  for (const pts of rings) {
    entities.push({
      id: nextId(), type: 'polyline', layer: 'CADASTRAL-BDRY',
      color: 'bylayer', lineweight: 1, linetype: 'continuous',
      visible: true, selected: false,
      points: pts, bulges: pts.map(() => 0), closed: true,
    } as Entity);
  }

  store.pushUndo('CADASTRAL-BDRY');
  store.entities.push(...entities);
  log(`Boundaries: ${entities.length} polygons`);
}

// ── 지번 Labels ──

async function fetchJibunLabels(
  centerM: { x: number; y: number }, halfSpan: number, log: (msg: string) => void,
) {
  const bbox = makeBbox(centerM, halfSpan);
  const features = await fetchVectorData(bbox, 'LP_PA_CBND_BUBUN');
  if (features.length === 0) { log('No 지번 data in this area'); return; }

  ensureLayer('CADASTRAL-JIBUN', '#ffff00');
  const entities: Entity[] = [];

  for (const feat of features) {
    const props = feat.properties || {};
    const jibun = props.jibun || `${props.bonbun || ''}-${props.bubun || ''}`;
    if (!jibun || jibun === '-') continue;

    const geom = feat.geometry;
    if (!geom) continue;
    const polys: number[][][][] = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);

    if (polys.length > 0 && polys[0].length > 0) {
      const ring = polys[0][0];
      const pts = ring.map((c: number[]) => ({ x: c[0] - centerM.x, y: c[1] - centerM.y }));
      const center = polygonCentroid(pts);
      entities.push({
        id: nextId(), type: 'text', layer: 'CADASTRAL-JIBUN',
        color: 'bylayer', lineweight: 1, linetype: 'continuous',
        visible: true, selected: false,
        position: center, text: jibun, height: 3, rotation: 0,
      } as Entity);
    }
  }

  store.entities.push(...entities);
  log(`지번: ${entities.length} labels`);
}

// ── Buildings ──

async function fetchBuildings(
  centerM: { x: number; y: number }, halfSpan: number, log: (msg: string) => void,
) {
  const bbox = makeBbox(centerM, halfSpan);
  const features = await fetchVectorData(bbox, 'LT_C_SPBD');
  if (features.length === 0) { log('No buildings in this area'); return; }

  ensureLayer('CADASTRAL-BLDG', '#ff00ff');
  const entities: Entity[] = [];

  const rings = extractPolygons(features, centerM);
  for (const pts of rings) {
    entities.push({
      id: nextId(), type: 'polyline', layer: 'CADASTRAL-BLDG',
      color: 'bylayer', lineweight: 1, linetype: 'continuous',
      visible: true, selected: false,
      points: pts, bulges: pts.map(() => 0), closed: true,
    } as Entity);
  }

  // Building name labels
  for (const feat of features) {
    const props = feat.properties || {};
    const name = props.buld_nm || props.buld_nm_dc || '';
    if (!name) continue;
    const geom = feat.geometry;
    if (!geom) continue;
    const polys: number[][][][] = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    if (polys.length > 0 && polys[0].length > 0) {
      const ring = polys[0][0];
      const pts = ring.map((c: number[]) => ({ x: c[0] - centerM.x, y: c[1] - centerM.y }));
      const center = polygonCentroid(pts);
      entities.push({
        id: nextId(), type: 'text', layer: 'CADASTRAL-BLDG',
        color: 'bylayer', lineweight: 1, linetype: 'continuous',
        visible: true, selected: false,
        position: center, text: name, height: 2, rotation: 0,
      } as Entity);
    }
  }

  store.entities.push(...entities);
  log(`Buildings: ${rings.length} outlines`);
}

// ── Roads ──

async function fetchRoads(
  centerM: { x: number; y: number }, halfSpan: number, log: (msg: string) => void,
) {
  const bbox = makeBbox(centerM, halfSpan);
  const features = await fetchVectorData(bbox, 'LT_L_SPRD');
  if (features.length === 0) { log('No roads in this area'); return; }

  ensureLayer('CADASTRAL-ROAD', '#00ff00');
  const entities: Entity[] = [];

  const lines = extractLines(features, centerM);
  for (const pts of lines) {
    entities.push({
      id: nextId(), type: 'polyline', layer: 'CADASTRAL-ROAD',
      color: 'bylayer', lineweight: 2, linetype: 'continuous',
      visible: true, selected: false,
      points: pts, bulges: pts.map(() => 0), closed: false,
    } as Entity);
  }

  // Road name labels at midpoint
  for (const feat of features) {
    const rn = feat.properties?.rn;
    if (!rn) continue;
    const geom = feat.geometry;
    if (!geom) continue;
    const lineArrays: number[][][] = [];
    if (geom.type === 'LineString') lineArrays.push(geom.coordinates);
    else if (geom.type === 'MultiLineString') lineArrays.push(...geom.coordinates);
    if (lineArrays.length > 0) {
      const coords = lineArrays[0];
      const mid = coords[Math.floor(coords.length / 2)];
      entities.push({
        id: nextId(), type: 'text', layer: 'CADASTRAL-ROAD',
        color: 'bylayer', lineweight: 1, linetype: 'continuous',
        visible: true, selected: false,
        position: { x: mid[0] - centerM.x, y: mid[1] - centerM.y },
        text: rn, height: 2.5, rotation: 0,
      } as Entity);
    }
  }

  store.entities.push(...entities);
  log(`Roads: ${lines.length} segments`);
}

// ── Land Use (용도지역) ──

async function fetchLandUse(
  centerM: { x: number; y: number }, halfSpan: number, log: (msg: string) => void,
) {
  const bbox = makeBbox(centerM, halfSpan);
  const features = await fetchVectorData(bbox, 'LT_C_UQ111');
  if (features.length === 0) { log('No land use data in this area'); return; }

  ensureLayer('CADASTRAL-LANDUSE', '#00ffff');
  const entities: Entity[] = [];

  const rings = extractPolygons(features, centerM);
  for (const pts of rings) {
    entities.push({
      id: nextId(), type: 'polyline', layer: 'CADASTRAL-LANDUSE',
      color: 'bylayer', lineweight: 1, linetype: 'dashed',
      visible: true, selected: false,
      points: pts, bulges: pts.map(() => 0), closed: true,
    } as Entity);
  }

  for (const feat of features) {
    const uname = feat.properties?.uname;
    if (!uname) continue;
    const geom = feat.geometry;
    if (!geom) continue;
    const polys: number[][][][] = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    if (polys.length > 0 && polys[0].length > 0) {
      const ring = polys[0][0];
      const pts = ring.map((c: number[]) => ({ x: c[0] - centerM.x, y: c[1] - centerM.y }));
      const center = polygonCentroid(pts);
      entities.push({
        id: nextId(), type: 'text', layer: 'CADASTRAL-LANDUSE',
        color: 'bylayer', lineweight: 1, linetype: 'continuous',
        visible: true, selected: false,
        position: center, text: uname, height: 4, rotation: 0,
      } as Entity);
    }
  }

  store.entities.push(...entities);
  log(`Land use: ${rings.length} zones`);
}

// ── 지적도 다운로드 (Cadastral Map Image) ──

async function resolveLocation(
  address: string, addrType: string,
): Promise<{ lon: number; lat: number } | null> {
  if (addrType === 'lonlat') {
    const parts = address.split(/[,\s]+/).map(Number);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
    return { lon: parts[0], lat: parts[1] };
  }
  const geoType = addrType === 'road' ? 'road' : 'parcel';
  let result = await geocodeAddress(address, geoType);
  if (!result && geoType === 'road') result = await geocodeAddress(address, 'parcel');
  return result;
}

async function fetchMapDataURL(centerM: { x: number; y: number }, z: number): Promise<string> {
  const tile = 1024;
  const mpp = zoomToMetersPerPixel(z);
  const halfM = (tile / 2) * mpp;
  const outSize = tile * 2;
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d')!;

  const offsets = [
    { dx: -1, dy:  1, px: 0,    py: 0    },
    { dx:  1, dy:  1, px: tile,  py: 0    },
    { dx: -1, dy: -1, px: 0,    py: tile  },
    { dx:  1, dy: -1, px: tile,  py: tile  },
  ];
  for (const { dx, dy, px, py } of offsets) {
    const cx = centerM.x + dx * halfM;
    const cy = centerM.y + dy * halfM;
    const c = `${cx},${cy}`;
    try {
      const img = await loadImage(
        `${API_BASE}/api/vworld/image?center=${encodeURIComponent(c)}&zoom=${z}&layers=lp_pa_cbnd_bonbun,lp_pa_cbnd_bubun&size=${tile},${tile}&basemap=GRAPHIC`
      );
      ctx.drawImage(img, px, py);
    } catch { /* skip failed quadrant */ }
  }
  return canvas.toDataURL('image/png');
}

async function downloadCadastralMap(
  address: string, addrType: string, log: (msg: string) => void,
) {
  log('지적도 등본: resolving location...');

  const loc = await resolveLocation(address, addrType);
  if (!loc) { log('Error: Address not found'); return; }
  const { lon, lat } = loc;

  const centerM = lonLatToMercator(lon, lat);
  const z = 18;
  const halfSpan = 50;
  const bbox = makeBbox(centerM, halfSpan);

  log('지적도 등본: fetching map & parcel data...');
  const [mapDataURL, bdryFeatures, landFeatures] = await Promise.all([
    fetchMapDataURL(centerM, z),
    fetchVectorData(bbox, 'LP_PA_CBND_BUBUN'),
    fetchVectorData(bbox, 'LT_C_LANDINFOBASEMAP'),
  ]);

  const parcel = findParcelAtPoint(bdryFeatures, centerM.x, centerM.y);
  const landInfo = findParcelAtPoint(landFeatures, centerM.x, centerM.y);

  const bp = parcel?.properties || {};
  const lp = landInfo?.properties || {};

  const jibun = bp.jibun || lp.jibun || `${bp.bonbun || ''}-${bp.bubun || ''}`;
  const addr = bp.addr || lp.addr || address;
  const pnu = lp.pnu || '';
  const jimokCode = lp.jimok || '';
  const jimokFull = JIMOK_CODES[jimokCode] || jimokCode || '—';
  const jiga = bp.jiga || '';

  let areaM2 = '';
  if (lp.parea) {
    areaM2 = parseFloat(lp.parea).toFixed(1);
  } else if (parcel?.geometry) {
    const polys: number[][][][] = [];
    const g = parcel.geometry;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
    if (polys.length > 0 && polys[0].length > 0) {
      areaM2 = computePolygonArea(polys[0][0]).toFixed(1);
    }
  }
  const areaPy = areaM2 ? (parseFloat(areaM2) / 3.3058).toFixed(1) : '';

  // Neighboring parcels table
  const neighbors = bdryFeatures
    .filter((f: any) => f !== parcel)
    .slice(0, 12)
    .map((f: any) => {
      const p = f.properties || {};
      return { jibun: p.jibun || `${p.bonbun || ''}-${p.bubun || ''}`, addr: p.addr || '' };
    });

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>지적도 등본 - ${jibun}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Malgun Gothic', '맑은 고딕', 'Noto Sans KR', sans-serif; background: #f5f5f5; color: #000; }
  .page { max-width: 210mm; margin: 10mm auto; background: #fff; border: 1px solid #ccc; padding: 12mm; }
  @media print { body { background: #fff; } .page { margin: 0; border: none; padding: 0; } .no-print { display: none; } }

  .header { text-align: center; border-bottom: 3px double #000; padding-bottom: 8px; margin-bottom: 12px; }
  .header h1 { font-size: 26px; letter-spacing: 14px; margin-bottom: 2px; }
  .header .subtitle { font-size: 12px; color: #555; }
  .header .doc-no { font-size: 11px; color: #888; margin-top: 4px; }

  .map-section { border: 2px solid #000; margin-bottom: 12px; position: relative; background: #eee; }
  .map-section img { width: 100%; display: block; }
  .map-label { position: absolute; top: 0; left: 0; right: 0; background: rgba(0,0,0,0.65); color: #fff; font-size: 13px; padding: 4px 10px; font-weight: bold; }

  .section-title { font-size: 15px; font-weight: bold; border-bottom: 2px solid #000; padding: 4px 0; margin: 14px 0 6px 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; }
  th, td { border: 1px solid #333; padding: 6px 10px; }
  th { background: #f0f0f0; font-weight: bold; text-align: left; width: 130px; white-space: nowrap; }
  td { text-align: left; }
  .val-big { font-size: 15px; font-weight: bold; }

  .neighbors { font-size: 12px; }
  .neighbors th { background: #f8f8f8; text-align: center; width: auto; }
  .neighbors td { text-align: center; }

  .footer { margin-top: 16px; border-top: 2px solid #000; padding-top: 8px; }
  .footer-grid { display: flex; justify-content: space-between; font-size: 11px; color: #555; }
  .stamp { text-align: center; margin: 14px 0 8px 0; }
  .stamp-box { display: inline-block; border: 2px solid #c00; color: #c00; padding: 6px 20px; font-size: 13px; font-weight: bold; border-radius: 3px; transform: rotate(-3deg); }
  .disclaimer { font-size: 10px; color: #999; text-align: center; margin-top: 6px; line-height: 1.5; }

  .print-btn { display: block; margin: 10px auto; padding: 10px 30px; font-size: 15px; background: #1a56db; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  .print-btn:hover { background: #1040a0; }
</style>
</head>
<body>

<button class="print-btn no-print" onclick="window.print()">인쇄 / PDF 저장</button>

<div class="page">
  <div class="header">
    <h1>유사 지적도 등본</h1>
    <div class="subtitle" style="color:#c00;font-weight:bold;font-size:14px">⚠ 공식문서 아님 — 개인참고용 (Not an Official Document)</div>
    <div class="doc-no">발급번호: CAD-${Date.now().toString(36).toUpperCase()} | 발급일시: ${dateStr} ${timeStr}</div>
  </div>

  <div class="section-title">도면 (Map)</div>
  <div class="map-section">
    <div class="map-label">지적도 — ${address} (Zoom ${z})</div>
    <img src="${mapDataURL}" alt="지적도">
  </div>

  <div class="section-title">토지 표시 (Land Description)</div>
  <table>
    <tr><th>소재지</th><td class="val-big" colspan="3">${addr}</td></tr>
    <tr><th>지번</th><td class="val-big">${jibun}</td><th>본번-부번</th><td>${bp.bonbun || '—'}-${bp.bubun || '—'}</td></tr>
    ${pnu ? `<tr><th>필지고유번호 (PNU)</th><td colspan="3">${pnu}</td></tr>` : ''}
    <tr><th>지목 (Land Category)</th><td>${jimokFull}</td><th>좌표 (WGS84)</th><td>${lon.toFixed(6)}, ${lat.toFixed(6)}</td></tr>
    <tr><th>면적 (Area)</th><td>${areaM2 ? `<span class="val-big">${areaM2} m²</span> (${areaPy} 평)` : '—'}</td><th>축척</th><td>1:1,200 상당 (Zoom ${z})</td></tr>
    ${jiga ? `<tr><th>공시지가 (₩/m²)</th><td>${Number(jiga).toLocaleString()} 원/m²</td><th>총 추정가</th><td>${areaM2 ? (Number(jiga) * parseFloat(areaM2)).toLocaleString() + ' 원' : '—'}</td></tr>` : ''}
  </table>

  ${neighbors.length > 0 ? `
  <div class="section-title">인접 필지 (Neighboring Parcels)</div>
  <table class="neighbors">
    <tr><th>No.</th><th>지번</th><th>소재지</th></tr>
    ${neighbors.map((n: any, i: number) => `<tr><td>${i + 1}</td><td>${n.jibun}</td><td>${n.addr}</td></tr>`).join('\n    ')}
  </table>` : ''}

  <div class="footer">
    <div class="stamp"><div class="stamp-box">VWorld 공간정보 열람</div></div>
    <div class="footer-grid">
      <span>출처: VWorld 국토교통부 공간정보 오픈플랫폼</span>
      <span>발급: MiniCAD Cadastral</span>
      <span>${dateStr}</span>
    </div>
    <div class="disclaimer">
      본 문서는 브이월드(VWorld) 공간정보 API 데이터를 기반으로 자동 생성된 참고용 문서이며,<br>
      법적 효력이 있는 공식 지적도 등본은 정부24 (gov.kr) 또는 관할 지적소관청에서 발급받으시기 바랍니다.
    </div>
  </div>
</div>

</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `유사지적도등본_${jibun.replace(/\s+/g, '_')}_${dateStr}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(`유사 지적도 등본 downloaded: ${jibun}`);
}

// ── 토지대장 (Land Registry) ──

const JIMOK_CODES: Record<string, string> = {
  '전': '전 (田, Dry Field)', '답': '답 (畓, Paddy)', '과': '과수원 (Orchard)',
  '목': '목장용지 (Pasture)', '임': '임야 (Forest)', '광': '광천지 (Mineral Spring)',
  '염': '염전 (Salt Pan)', '대': '대 (Building Site)', '공': '공장용지 (Factory)',
  '학': '학교용지 (School)', '주': '주차장 (Parking)', '주유': '주유소용지 (Gas Station)',
  '창': '창고용지 (Warehouse)', '도': '도로 (Road)', '철': '철도용지 (Railway)',
  '하': '하천 (River)', '제': '제방 (Embankment)', '구': '구거 (Ditch)',
  '유': '유지 (Pond)', '양': '양어장 (Fish Farm)', '수': '수도용지 (Water Supply)',
  '공원': '공원 (Park)', '체': '체육용지 (Sports)', '유원': '유원지 (Amusement)',
  '종': '종교용지 (Religious)', '사': '사적지 (Historical)', '묘': '묘지 (Cemetery)',
  '잡': '잡종지 (Miscellaneous)',
};

function pointInPolygon(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function findParcelAtPoint(features: any[], px: number, py: number): any | null {
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom) continue;
    const polys: number[][][][] = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    for (const poly of polys) {
      if (poly.length > 0 && pointInPolygon(px, py, poly[0])) return feat;
    }
  }
  return features.length > 0 ? features[0] : null;
}

function featureRing(feat: any): number[][] {
  const geom = feat.geometry;
  if (!geom) return [];
  if (geom.type === 'Polygon' && geom.coordinates.length > 0) return geom.coordinates[0];
  if (geom.type === 'MultiPolygon' && geom.coordinates.length > 0 && geom.coordinates[0].length > 0) return geom.coordinates[0][0];
  return [];
}

function sharesEdge(a: any, b: any): boolean {
  const rA = featureRing(a), rB = featureRing(b);
  if (rA.length === 0 || rB.length === 0) return false;
  const tol = 0.1;
  let shared = 0;
  for (const pA of rA) {
    for (const pB of rB) {
      if (Math.abs(pA[0] - pB[0]) < tol && Math.abs(pA[1] - pB[1]) < tol) {
        if (++shared >= 2) return true;
      }
    }
  }
  return false;
}

function computePolygonArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area / 2);
}

async function downloadLandRegistry(
  address: string, addrType: string, log: (msg: string) => void,
) {
  log('토지대장: resolving location...');

  const loc = await resolveLocation(address, addrType);
  if (!loc) { log('Error: Address not found'); return; }
  const { lon, lat } = loc;

  const centerM = lonLatToMercator(lon, lat);
  const halfSpan = 50;
  const bbox = makeBbox(centerM, halfSpan);

  log('토지대장: fetching parcel data...');
  const [bdryFeatures, landFeatures] = await Promise.all([
    fetchVectorData(bbox, 'LP_PA_CBND_BUBUN'),
    fetchVectorData(bbox, 'LT_C_LANDINFOBASEMAP'),
  ]);

  const parcel = findParcelAtPoint(bdryFeatures, centerM.x, centerM.y);
  const landInfo = findParcelAtPoint(landFeatures, centerM.x, centerM.y);

  if (!parcel && !landInfo) {
    log('Error: No parcel data found at this location');
    return;
  }

  const bp = parcel?.properties || {};
  const lp = landInfo?.properties || {};

  const jibun = bp.jibun || lp.jibun || `${bp.bonbun || ''}-${bp.bubun || ''}`;
  const addr = bp.addr || lp.addr || address;
  const pnu = lp.pnu || '';
  const jimokCode = lp.jimok || '';
  const jimokFull = JIMOK_CODES[jimokCode] || jimokCode;
  const jiga = bp.jiga || '';

  let areaM2 = '';
  if (lp.parea) {
    areaM2 = parseFloat(lp.parea).toFixed(1);
  } else if (parcel?.geometry) {
    const polys: number[][][][] = [];
    const g = parcel.geometry;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
    if (polys.length > 0 && polys[0].length > 0) {
      areaM2 = computePolygonArea(polys[0][0]).toFixed(1);
    }
  }
  const areaPy = areaM2 ? (parseFloat(areaM2) / 3.3058).toFixed(1) : '';

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>토지대장 - ${jibun}</title>
<style>
  @page { size: A4; margin: 20mm; }
  body { font-family: 'Malgun Gothic', '맑은 고딕', sans-serif; margin: 0; padding: 20px; color: #000; background: #fff; }
  .doc { max-width: 700px; margin: 0 auto; border: 2px solid #000; padding: 30px; }
  h1 { text-align: center; font-size: 28px; margin: 0 0 5px 0; letter-spacing: 12px; }
  .sub { text-align: center; font-size: 13px; color: #555; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { border: 1px solid #000; padding: 8px 12px; font-size: 14px; }
  th { background: #f0f0f0; font-weight: bold; width: 140px; text-align: left; }
  td { text-align: left; }
  .section-title { font-size: 16px; font-weight: bold; margin: 20px 0 8px 0; padding-bottom: 4px; border-bottom: 2px solid #000; }
  .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #888; }
  .stamp { text-align: center; margin-top: 20px; }
  .stamp-box { display: inline-block; border: 2px solid #cc0000; color: #cc0000; padding: 8px 16px; font-size: 14px; font-weight: bold; border-radius: 4px; transform: rotate(-5deg); }
</style>
</head>
<body>
<div class="doc">
  <h1>토 지 대 장</h1>
  <div class="sub">Land Registry (토지대장) — VWorld Data</div>

  <div class="section-title">1. 토지 소재지 (Location)</div>
  <table>
    <tr><th>소재지 (주소)</th><td>${addr}</td></tr>
    <tr><th>지번</th><td>${jibun}</td></tr>
    ${pnu ? `<tr><th>필지고유번호 (PNU)</th><td>${pnu}</td></tr>` : ''}
    <tr><th>좌표 (WGS84)</th><td>${lon.toFixed(6)}, ${lat.toFixed(6)}</td></tr>
  </table>

  <div class="section-title">2. 토지 현황 (Land Details)</div>
  <table>
    <tr><th>지목 (Land Category)</th><td>${jimokFull || '—'}</td></tr>
    <tr><th>면적</th><td>${areaM2 ? `${areaM2} m² (${areaPy} 평)` : '—'}</td></tr>
    ${jiga ? `<tr><th>공시지가 (₩/m²)</th><td>${Number(jiga).toLocaleString()} 원/m²${areaM2 ? ` (총 ${(Number(jiga) * parseFloat(areaM2)).toLocaleString()} 원)` : ''}</td></tr>` : ''}
  </table>

  <div class="section-title">3. 원시 속성 데이터 (Raw Properties)</div>
  <table>
    <tr><th colspan="2" style="text-align:center">경계 데이터 (LP_PA_CBND_BUBUN)</th></tr>
    ${Object.entries(bp).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n    ')}
    ${Object.keys(bp).length === 0 ? '<tr><td colspan="2" style="text-align:center;color:#888">데이터 없음</td></tr>' : ''}
  </table>
  <table>
    <tr><th colspan="2" style="text-align:center">토지정보 (LT_C_LANDINFOBASEMAP)</th></tr>
    ${Object.entries(lp).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n    ')}
    ${Object.keys(lp).length === 0 ? '<tr><td colspan="2" style="text-align:center;color:#888">데이터 없음</td></tr>' : ''}
  </table>

  <div class="stamp">
    <div class="stamp-box">VWorld 공간정보 조회</div>
  </div>
  <div class="footer">
    발급일: ${dateStr} | 출처: VWorld 국토교통부 공간정보 | MiniCAD<br>
    본 문서는 참고용이며 법적 효력이 없습니다. 정식 토지대장은 정부24에서 발급받으시기 바랍니다.
  </div>
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `토지대장_${jibun.replace(/\s+/g, '_')}_${dateStr}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(`토지대장 downloaded: ${jibun}`);
}

// ── 토지이동이력 (Land Movement History) ──

async function downloadLandHistory(
  address: string, addrType: string, log: (msg: string) => void,
) {
  log('토지이동이력: resolving location...');

  const loc = await resolveLocation(address, addrType);
  if (!loc) { log('Error: Address not found'); return; }
  const { lon, lat } = loc;

  const centerM = lonLatToMercator(lon, lat);
  const halfSpan = 50;
  const bbox = makeBbox(centerM, halfSpan);

  log('토지이동이력: fetching parcel info...');
  const [bdryFeatures, landFeatures] = await Promise.all([
    fetchVectorData(bbox, 'LP_PA_CBND_BUBUN'),
    fetchVectorData(bbox, 'LT_C_LANDINFOBASEMAP'),
  ]);

  const parcel = findParcelAtPoint(bdryFeatures, centerM.x, centerM.y);
  const landInfo = findParcelAtPoint(landFeatures, centerM.x, centerM.y);
  const bp = parcel?.properties || {};
  const lp = landInfo?.properties || {};

  const pnu = lp.pnu || '';
  const jibun = bp.jibun || lp.jibun || `${bp.bonbun || ''}-${bp.bubun || ''}`;
  const addr = bp.addr || lp.addr || address;
  const jimokCode = lp.jimok || '';
  const jimokFull = JIMOK_CODES[jimokCode] || jimokCode || '—';
  const jiga = bp.jiga || '';
  let areaM2 = '';
  if (lp.parea) {
    areaM2 = parseFloat(lp.parea).toFixed(1);
  } else if (parcel?.geometry) {
    const polys: number[][][][] = [];
    const g = parcel.geometry;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
    if (polys.length > 0 && polys[0].length > 0) areaM2 = computePolygonArea(polys[0][0]).toFixed(1);
  }
  const areaPy = areaM2 ? (parseFloat(areaM2) / 3.3058).toFixed(1) : '';

  if (!pnu) {
    log('Error: PNU (필지고유번호) not found for this parcel. Cannot query history.');
    return;
  }

  log(`토지이동이력: querying PNU ${pnu}...`);
  let items: any[] = [];
  let apiError = '';
  try {
    const res = await fetch(`${API_BASE}/api/land/history?pnu=${pnu}`);
    const data = await res.json();
    if (data.error) {
      apiError = data.error;
    } else {
      items = data?.landMoves?.field || [];
      if (!Array.isArray(items)) items = [];
    }
  } catch {
    apiError = 'API connection failed';
  }

  if (apiError) {
    log(`토지이동이력 API: ${apiError}`);
  }
  if (items.length === 0 && !apiError) {
    log('토지이동이력: No history records found for this parcel');
  }

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const rows = items.map((it: any, i: number) => {
    const mvDate = it.ladMvmnDe || '—';
    const ersrDate = it.ladMvmnErsrDe || '';
    const reason = it.ladMvmnPrvonshCodeNm || '—';
    const jimok = it.lndcgrCodeNm || '—';
    const area = it.lndpclAr ? `${it.lndpclAr}` : '—';
    const lotNum = it.mnnmSlno || '—';
    const ldName = it.ldCodeNm || '';
    const regType = it.regstrSeCodeNm || '';
    return `<tr>
      <td>${i + 1}</td>
      <td>${mvDate}</td>
      <td>${ersrDate !== '9999-12-31' ? ersrDate : '현재'}</td>
      <td>${reason}</td>
      <td>${jimok}</td>
      <td>${area}</td>
      <td>${lotNum}</td>
      <td style="font-size:11px">${ldName}</td>
    </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>토지이동이력 - ${jibun}</title>
<style>
  @page { size: A4 landscape; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Malgun Gothic', '맑은 고딕', sans-serif; background: #f5f5f5; color: #000; }
  .page { max-width: 290mm; margin: 10mm auto; background: #fff; border: 1px solid #ccc; padding: 12mm; }
  @media print { body { background: #fff; } .page { margin: 0; border: none; padding: 0; } .no-print { display: none; } }

  .header { text-align: center; border-bottom: 3px double #000; padding-bottom: 8px; margin-bottom: 14px; }
  .header h1 { font-size: 24px; letter-spacing: 8px; margin-bottom: 2px; }
  .header .subtitle { font-size: 12px; color: #c00; font-weight: bold; }
  .header .doc-no { font-size: 11px; color: #888; margin-top: 4px; }

  .info-table { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 13px; }
  .info-table th, .info-table td { border: 1px solid #333; padding: 5px 10px; }
  .info-table th { background: #f0f0f0; font-weight: bold; width: 140px; text-align: left; }

  .section-title { font-size: 15px; font-weight: bold; border-bottom: 2px solid #000; padding: 4px 0; margin: 14px 0 6px 0; }

  .history-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .history-table th { background: #e8e8e8; border: 1px solid #333; padding: 6px 8px; text-align: center; font-weight: bold; }
  .history-table td { border: 1px solid #555; padding: 5px 8px; text-align: center; }
  .history-table tr:nth-child(even) { background: #fafafa; }
  .history-table tr:hover { background: #ffffdd; }

  .footer { margin-top: 16px; border-top: 2px solid #000; padding-top: 8px; text-align: center; }
  .footer-info { font-size: 11px; color: #555; }
  .disclaimer { font-size: 10px; color: #999; margin-top: 6px; }

  .print-btn { display: block; margin: 10px auto; padding: 10px 30px; font-size: 15px; background: #1a56db; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  .print-btn:hover { background: #1040a0; }
</style>
</head>
<body>

<button class="print-btn no-print" onclick="window.print()">인쇄 / PDF 저장</button>

<div class="page">
  <div class="header">
    <h1>토지이동이력 속성조회</h1>
    <div class="subtitle">⚠ 공식문서 아님 — 개인참고용</div>
    <div class="doc-no">조회일시: ${dateStr} | PNU: ${pnu}</div>
  </div>

  <table class="info-table">
    <tr><th>소재지</th><td>${addr}</td><th>지번</th><td>${jibun}</td></tr>
    <tr><th>필지고유번호 (PNU)</th><td colspan="3">${pnu}</td></tr>
  </table>

  <div class="section-title">토지 현황 (VWorld 공간정보)</div>
  <table class="info-table">
    <tr><th>지목</th><td>${jimokFull}</td><th>면적</th><td>${areaM2 ? `${areaM2} m² (${areaPy} 평)` : '—'}</td></tr>
    ${jiga ? `<tr><th>공시지가</th><td>${Number(jiga).toLocaleString()} 원/m²</td><th>총 추정가</th><td>${areaM2 ? (Number(jiga) * parseFloat(areaM2)).toLocaleString() + ' 원' : '—'}</td></tr>` : ''}
  </table>

  ${items.length > 0 ? `
  <div class="section-title">이동이력 (${items.length}건)</div>
  <table class="history-table">
    <tr>
      <th>No.</th>
      <th>이동일자</th>
      <th>말소일자</th>
      <th>이동사유</th>
      <th>지목</th>
      <th>면적(m²)</th>
      <th>지번</th>
      <th>소재지</th>
    </tr>
    ${rows}
  </table>
  ` : `
  <div class="section-title">이동이력</div>
  <div style="border:1px solid #c00;padding:12px;margin:8px 0;background:#fff5f5;font-size:13px">
    <strong style="color:#c00">⚠ 토지이동이력 API 미연결</strong><br><br>
    ${apiError ? `<strong>오류:</strong> ${apiError}<br><br>` : ''}
    <strong>설정 방법:</strong><br>
    1. <a href="https://www.data.go.kr" target="_blank">data.go.kr</a> 에 로그인<br>
    2. "국토교통부_토지이동이력 정보서비스" 검색 후 <strong>활용신청</strong><br>
    3. 발급받은 서비스키를 <code>~/.secrets</code>에 추가:<br>
    <code style="background:#eee;padding:2px 6px">DATA_GO_KR_API_KEY=발급받은키</code><br>
    4. 백엔드 재시작 후 다시 조회
  </div>
  `}

  <div class="footer">
    <div class="footer-info">출처: ${items.length > 0 ? '공공데이터포털 — 국토교통부 토지이동이력 정보서비스' : 'VWorld 국토교통부 공간정보'} | MiniCAD</div>
    <div class="disclaimer">본 문서는 참고용이며 법적 효력이 없습니다.</div>
  </div>
</div>

</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `토지이동이력_${jibun.replace(/\s+/g, '_')}_${dateStr}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(`토지이동이력 downloaded: ${jibun} (${items.length}건)`);
}

// ── 토지이용계획 (Land Use Plan) ──

async function downloadLandUsePlan(
  address: string, addrType: string, log: (msg: string) => void,
) {
  log('토지이용계획: resolving location...');
  const loc = await resolveLocation(address, addrType);
  if (!loc) { log('Error: Address not found'); return; }
  const { lon, lat } = loc;
  const centerM = lonLatToMercator(lon, lat);
  const bbox = makeBbox(centerM, 50);

  log('토지이용계획: fetching parcel & land use data...');
  const [bdryFeatures, landFeatures] = await Promise.all([
    fetchVectorData(bbox, 'LP_PA_CBND_BUBUN'),
    fetchVectorData(bbox, 'LT_C_LANDINFOBASEMAP'),
  ]);
  const parcel = findParcelAtPoint(bdryFeatures, centerM.x, centerM.y);
  const landInfo = findParcelAtPoint(landFeatures, centerM.x, centerM.y);
  const bp = parcel?.properties || {};
  const lp = landInfo?.properties || {};
  const pnu = lp.pnu || '';
  const jibun = bp.jibun || lp.jibun || `${bp.bonbun || ''}-${bp.bubun || ''}`;
  const addr = bp.addr || lp.addr || address;

  if (!pnu) { log('Error: PNU not found'); return; }

  log(`토지이용계획: querying PNU ${pnu}...`);
  const res = await fetch(`${API_BASE}/api/land/use?pnu=${pnu}`);
  const data = await res.json();
  if (data.error) { log(`Error: ${data.error}`); return; }

  const items: any[] = data?.landUses?.field || [];
  if (items.length === 0) { log('토지이용계획: No data found'); return; }

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const rows = items.map((it: any, i: number) => `<tr>
    <td>${i + 1}</td>
    <td>${it.prposAreaDstrcCodeNm || '—'}</td>
    <td>${it.prposAreaDstrcCode || '—'}</td>
    <td>${it.cnflcAtNm || '—'}</td>
    <td style="font-size:11px">${it.registDt || '—'}</td>
    <td style="font-size:11px">${it.lastUpdtDt || '—'}</td>
  </tr>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>토지이용계획 - ${jibun}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Malgun Gothic', '맑은 고딕', sans-serif; background: #f5f5f5; color: #000; }
  .page { max-width: 210mm; margin: 10mm auto; background: #fff; border: 1px solid #ccc; padding: 12mm; }
  @media print { body { background: #fff; } .page { margin: 0; border: none; } .no-print { display: none; } }
  .header { text-align: center; border-bottom: 3px double #000; padding-bottom: 8px; margin-bottom: 14px; }
  .header h1 { font-size: 24px; letter-spacing: 8px; }
  .header .subtitle { font-size: 12px; color: #c00; font-weight: bold; }
  .header .doc-no { font-size: 11px; color: #888; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; }
  th, td { border: 1px solid #333; padding: 6px 10px; }
  th { background: #f0f0f0; font-weight: bold; text-align: center; }
  td { text-align: center; }
  .info th { text-align: left; width: 140px; }
  .info td { text-align: left; }
  .section-title { font-size: 15px; font-weight: bold; border-bottom: 2px solid #000; padding: 4px 0; margin: 14px 0 6px 0; }
  .footer { margin-top: 16px; border-top: 2px solid #000; padding-top: 8px; text-align: center; font-size: 11px; color: #555; }
  .disclaimer { font-size: 10px; color: #999; margin-top: 6px; }
  .print-btn { display: block; margin: 10px auto; padding: 10px 30px; font-size: 15px; background: #1a56db; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">인쇄 / PDF 저장</button>
<div class="page">
  <div class="header">
    <h1>토지이용계획 확인서</h1>
    <div class="subtitle">⚠ 공식문서 아님 — 개인참고용</div>
    <div class="doc-no">조회일시: ${dateStr} | PNU: ${pnu}</div>
  </div>
  <table class="info">
    <tr><th>소재지</th><td>${addr}</td><th>지번</th><td>${jibun}</td></tr>
    <tr><th>필지고유번호</th><td colspan="3">${pnu}</td></tr>
    <tr><th>좌표 (WGS84)</th><td colspan="3">${lon.toFixed(6)}, ${lat.toFixed(6)}</td></tr>
  </table>
  <div class="section-title">지역·지구·구역 지정 현황 (${items.length}건)</div>
  <table>
    <tr><th>No.</th><th>용도지역지구명</th><th>코드</th><th>저촉</th><th>등록일</th><th>갱신일</th></tr>
    ${rows}
  </table>
  <div class="footer">
    출처: VWorld 국토교통부 국가중점데이터 — 토지이용계획속성조회 | MiniCAD
    <div class="disclaimer">본 문서는 참고용이며 법적 효력이 없습니다.</div>
  </div>
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `토지이용계획_${jibun.replace(/\s+/g, '_')}_${dateStr}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(`토지이용계획 downloaded: ${jibun} (${items.length}건)`);
}

// ── 토지이용규제정보 (Land Use Regulation + Price History) ──

async function downloadLandRegulation(
  address: string, addrType: string, log: (msg: string) => void,
) {
  log('토지이용규제정보: resolving location...');
  const loc = await resolveLocation(address, addrType);
  if (!loc) { log('Error: Address not found'); return; }
  const { lon, lat } = loc;
  const centerM = lonLatToMercator(lon, lat);
  const bbox = makeBbox(centerM, 50);

  log('토지이용규제정보: fetching data...');
  const [bdryFeatures, landFeatures] = await Promise.all([
    fetchVectorData(bbox, 'LP_PA_CBND_BUBUN'),
    fetchVectorData(bbox, 'LT_C_LANDINFOBASEMAP'),
  ]);
  const parcel = findParcelAtPoint(bdryFeatures, centerM.x, centerM.y);
  const landInfo = findParcelAtPoint(landFeatures, centerM.x, centerM.y);
  const bp = parcel?.properties || {};
  const lp = landInfo?.properties || {};
  const pnu = lp.pnu || '';
  const jibun = bp.jibun || lp.jibun || `${bp.bonbun || ''}-${bp.bubun || ''}`;
  const addr = bp.addr || lp.addr || address;
  const jimokCode = lp.jimok || '';
  const jimokFull = JIMOK_CODES[jimokCode] || jimokCode || '—';
  let areaM2 = lp.parea ? parseFloat(lp.parea).toFixed(1) : '';

  if (!pnu) { log('Error: PNU not found'); return; }

  log(`토지이용규제정보: querying PNU ${pnu}...`);
  const [useRes, priceRes] = await Promise.all([
    fetch(`${API_BASE}/api/land/use?pnu=${pnu}`).then(r => r.json()),
    fetch(`${API_BASE}/api/land/price?pnu=${pnu}`).then(r => r.json()),
  ]);

  const useItems: any[] = useRes?.landUses?.field || [];
  const priceItems: any[] = priceRes?.indvdLandPrices?.field || [];
  priceItems.sort((a: any, b: any) => (b.stdrYear || '').localeCompare(a.stdrYear || ''));

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const useRows = useItems.map((it: any, i: number) => `<tr>
    <td>${i + 1}</td>
    <td style="text-align:left">${it.prposAreaDstrcCodeNm || '—'}</td>
    <td>${it.cnflcAtNm || '—'}</td>
  </tr>`).join('\n');

  const priceRows = priceItems.slice(0, 20).map((it: any) => `<tr>
    <td>${it.stdrYear || '—'}</td>
    <td>${it.pblntfPclnd ? Number(it.pblntfPclnd).toLocaleString() : '—'}</td>
    <td>${it.pblntfPclnd && areaM2 ? (Number(it.pblntfPclnd) * parseFloat(areaM2)).toLocaleString() : '—'}</td>
    <td>${it.pblntfDe || '—'}</td>
  </tr>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>토지이용규제정보 - ${jibun}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Malgun Gothic', '맑은 고딕', sans-serif; background: #f5f5f5; color: #000; }
  .page { max-width: 210mm; margin: 10mm auto; background: #fff; border: 1px solid #ccc; padding: 12mm; }
  @media print { body { background: #fff; } .page { margin: 0; border: none; } .no-print { display: none; } }
  .header { text-align: center; border-bottom: 3px double #000; padding-bottom: 8px; margin-bottom: 14px; }
  .header h1 { font-size: 22px; letter-spacing: 6px; }
  .header .subtitle { font-size: 12px; color: #c00; font-weight: bold; }
  .header .doc-no { font-size: 11px; color: #888; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px; }
  th, td { border: 1px solid #333; padding: 5px 8px; }
  th { background: #f0f0f0; font-weight: bold; text-align: center; }
  td { text-align: center; }
  .info th { text-align: left; width: 130px; }
  .info td { text-align: left; }
  .section-title { font-size: 15px; font-weight: bold; border-bottom: 2px solid #000; padding: 4px 0; margin: 14px 0 6px 0; }
  .two-col { display: flex; gap: 12px; }
  .two-col > div { flex: 1; }
  .footer { margin-top: 16px; border-top: 2px solid #000; padding-top: 8px; text-align: center; font-size: 11px; color: #555; }
  .disclaimer { font-size: 10px; color: #999; margin-top: 6px; }
  .print-btn { display: block; margin: 10px auto; padding: 10px 30px; font-size: 15px; background: #1a56db; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">인쇄 / PDF 저장</button>
<div class="page">
  <div class="header">
    <h1>토지이용규제정보 확인서</h1>
    <div class="subtitle">⚠ 공식문서 아님 — 개인참고용</div>
    <div class="doc-no">조회일시: ${dateStr} | PNU: ${pnu}</div>
  </div>

  <table class="info">
    <tr><th>소재지</th><td>${addr}</td><th>지번</th><td>${jibun}</td></tr>
    <tr><th>필지고유번호</th><td colspan="3">${pnu}</td></tr>
    <tr><th>지목</th><td>${jimokFull}</td><th>면적</th><td>${areaM2 ? `${areaM2} m²` : '—'}</td></tr>
  </table>

  <div class="section-title">용도지역·지구·구역 (${useItems.length}건)</div>
  ${useItems.length > 0 ? `<table>
    <tr><th style="width:30px">No.</th><th>용도지역지구명</th><th style="width:60px">저촉</th></tr>
    ${useRows}
  </table>` : '<p style="color:#888;padding:8px">데이터 없음</p>'}

  <div class="section-title">개별공시지가 이력 (최근 ${Math.min(priceItems.length, 20)}건 / ${priceItems.length}건)</div>
  ${priceItems.length > 0 ? `<table>
    <tr><th>기준년도</th><th>공시지가 (원/m²)</th><th>추정 총가 (원)</th><th>공시일</th></tr>
    ${priceRows}
  </table>` : '<p style="color:#888;padding:8px">데이터 없음</p>'}

  <div class="footer">
    출처: VWorld 국토교통부 국가중점데이터 — 토지이용계획속성조회 · 개별공시지가속성조회 | MiniCAD
    <div class="disclaimer">본 문서는 참고용이며 법적 효력이 없습니다.</div>
  </div>
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `토지이용규제정보_${jibun.replace(/\s+/g, '_')}_${dateStr}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(`토지이용규제정보 downloaded: ${jibun} (규제 ${useItems.length}건, 공시지가 ${priceItems.length}건)`);
}

// ── Dialog ──

export async function openCadastralDialog(log: (msg: string) => void) {
  const overlay = document.getElementById('cloud-overlay')!;
  const dialog = document.getElementById('cloud-dialog')!;

  dialog.innerHTML = `
    <div class="cloud-dialog-title">
      <span>지적도 Cadastral Import</span>
      <button id="cad-close">&times;</button>
    </div>
    <div class="cloud-dialog-body">
      <div style="margin-bottom:6px;font-weight:bold">위치 입력 (Location)</div>
      <div style="margin-bottom:4px;display:flex;gap:8px;align-items:center">
        <label style="white-space:nowrap"><input type="radio" name="cad-addr-type" value="road" checked> 도로명 주소</label>
        <label style="white-space:nowrap"><input type="radio" name="cad-addr-type" value="old"> 기존 주소 (지번)</label>
        <label style="white-space:nowrap"><input type="radio" name="cad-addr-type" value="lonlat"> 경도-위도</label>
      </div>
      <input class="cloud-save-input" id="cad-address" value="경주시 태종로 450-5" style="margin-bottom:8px" />
      <div id="cad-lonlat-hint" style="display:none;color:#808080;font-size:11px;margin:-4px 0 6px 0">
        Format: longitude, latitude (예: 129.2106, 35.8562)
      </div>

      <div style="margin-bottom:4px;font-weight:bold">레이어 선택 (Layers)</div>
      <div style="margin-bottom:8px;display:flex;flex-direction:column;gap:3px">
        <label><input type="checkbox" id="cad-ly-sat" checked> 위성사진 (Satellite)</label>
        <label><input type="checkbox" id="cad-ly-cadimg"> 지적도 이미지 (Cadastral Map Overlay)</label>
        <label><input type="checkbox" id="cad-ly-bdry" checked> 지적도 경계선 (Cadastral Boundaries)</label>
        <label><input type="checkbox" id="cad-ly-jibun"> 지번 (Lot Numbers)</label>
        <label><input type="checkbox" id="cad-ly-bldg" checked> 건축물 (Buildings)</label>
        <label><input type="checkbox" id="cad-ly-road" checked> 도로 (Roads)</label>
        <label><input type="checkbox" id="cad-ly-landuse"> 용도지역 (Land Use Zones)</label>
      </div>

      <div style="margin-bottom:8px;border-top:1px solid #555;padding-top:8px;display:flex;flex-wrap:wrap;gap:5px">
        <button class="cloud-btn" id="cad-map-dl" style="flex:1;min-width:120px;background:#2a3a4a;color:#6cf;border:1px solid #48f;font-size:11px;padding:4px 6px">지적도 다운로드</button>
        <button class="cloud-btn" id="cad-land-reg" style="flex:1;min-width:120px;background:#2a4a2a;color:#0f0;border:1px solid #0a0;font-size:11px;padding:4px 6px">토지대장 다운로드</button>
        <button class="cloud-btn" id="cad-land-hist" style="flex:1;min-width:120px;background:#4a2a2a;color:#fc6;border:1px solid #a80;font-size:11px;padding:4px 6px">토지이동이력</button>
        <button class="cloud-btn" id="cad-land-use" style="flex:1;min-width:120px;background:#2a2a4a;color:#c8f;border:1px solid #80a;font-size:11px;padding:4px 6px">토지이용계획</button>
        <button class="cloud-btn" id="cad-land-regul" style="flex:1;min-width:120px;background:#3a3a2a;color:#ff8;border:1px solid #aa0;font-size:11px;padding:4px 6px">토지이용규제정보</button>
      </div>

      <div style="margin-bottom:8px;border-top:1px solid #555;padding-top:8px">
        <button class="cloud-btn" id="cad-shelter" style="width:100%;background:#1a3a1a;color:#0f0;border:2px solid #0a0;font-size:13px;padding:6px 10px;font-weight:bold" title="쉼터 건물배치도 작성&#10;&#10;조작법:&#10;  W = 높이 증가 (+0.1m)&#10;  S = 높이 감소 (-0.1m)&#10;  A = 폭 증가 (+0.1m)&#10;  D = 폭 감소 (-0.1m)&#10;  Q = 반시계 회전 (+15°)&#10;  E = 시계 회전 (-15°)&#10;  클릭 = 배치 확정&#10;  ESC = 취소">🏠 쉼터 건물배치도</button>
      </div>

      <div class="cloud-btn-row" style="margin-top:8px;border-top:1px solid #555;padding-top:8px">
        <button class="cloud-btn primary" id="cad-ok" style="flex:2;font-size:14px;padding:8px 16px;background:#1a4a8a;color:#fff;border:2px solid #48f;font-weight:bold">📥 삽입 (Insert to MiniCAD)</button>
        <button class="cloud-btn" id="cad-cancel" style="flex:1">Cancel</button>
      </div>
    </div>`;
  overlay.classList.add('open');

  const close = () => overlay.classList.remove('open');
  dialog.querySelector('#cad-close')!.addEventListener('click', close);
  dialog.querySelector('#cad-cancel')!.addEventListener('click', close);

  dialog.querySelector('#cad-map-dl')!.addEventListener('click', async () => {
    const addrType = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
    const address = (dialog.querySelector('#cad-address') as HTMLInputElement).value.trim();
    if (!address) { log('Error: No address entered'); return; }
    close();
    try {
      await downloadCadastralMap(address, addrType, log);
    } catch (e: any) {
      log(`지적도 error: ${e.message}`);
    }
  });

  dialog.querySelector('#cad-land-reg')!.addEventListener('click', async () => {
    const addrType = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
    const address = (dialog.querySelector('#cad-address') as HTMLInputElement).value.trim();
    if (!address) { log('Error: No address entered'); return; }
    close();
    try {
      await downloadLandRegistry(address, addrType, log);
    } catch (e: any) {
      log(`토지대장 error: ${e.message}`);
    }
  });

  dialog.querySelector('#cad-land-hist')!.addEventListener('click', async () => {
    const addrType = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
    const address = (dialog.querySelector('#cad-address') as HTMLInputElement).value.trim();
    if (!address) { log('Error: No address entered'); return; }
    close();
    try {
      await downloadLandHistory(address, addrType, log);
    } catch (e: any) {
      log(`토지이동이력 error: ${e.message}`);
    }
  });

  dialog.querySelector('#cad-land-use')!.addEventListener('click', async () => {
    const addrType = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
    const address = (dialog.querySelector('#cad-address') as HTMLInputElement).value.trim();
    if (!address) { log('Error: No address entered'); return; }
    close();
    try {
      await downloadLandUsePlan(address, addrType, log);
    } catch (e: any) {
      log(`토지이용계획 error: ${e.message}`);
    }
  });

  dialog.querySelector('#cad-land-regul')!.addEventListener('click', async () => {
    const addrType = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
    const address = (dialog.querySelector('#cad-address') as HTMLInputElement).value.trim();
    if (!address) { log('Error: No address entered'); return; }
    close();
    try {
      await downloadLandRegulation(address, addrType, log);
    } catch (e: any) {
      log(`토지이용규제정보 error: ${e.message}`);
    }
  });

  dialog.querySelector('#cad-shelter')!.addEventListener('click', async () => {
    const addrType = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
    const address = (dialog.querySelector('#cad-address') as HTMLInputElement).value.trim();
    if (!address) { log('Error: No address entered'); return; }
    close();
    try {
      await loadShelterMode(address, addrType, log);
    } catch (e: any) {
      log(`쉼터 error: ${e.message}`);
    }
  });

  dialog.querySelectorAll('input[name="cad-addr-type"]').forEach(r => {
    r.addEventListener('change', () => {
      const val = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
      const hint = dialog.querySelector('#cad-lonlat-hint') as HTMLElement;
      const input = dialog.querySelector('#cad-address') as HTMLInputElement;
      hint.style.display = val === 'lonlat' ? 'block' : 'none';
      if (val === 'lonlat') {
        input.placeholder = '129.2106, 35.8562';
      } else {
        input.placeholder = '주소 입력';
      }
    });
  });

  dialog.querySelector('#cad-ok')!.addEventListener('click', async () => {
    const addrType = (dialog.querySelector('input[name="cad-addr-type"]:checked') as HTMLInputElement).value;
    const address = (dialog.querySelector('#cad-address') as HTMLInputElement).value.trim();
    const wantSat = (dialog.querySelector('#cad-ly-sat') as HTMLInputElement).checked;
    const wantCadImg = (dialog.querySelector('#cad-ly-cadimg') as HTMLInputElement).checked;
    const wantBdry = (dialog.querySelector('#cad-ly-bdry') as HTMLInputElement).checked;
    const wantJibun = (dialog.querySelector('#cad-ly-jibun') as HTMLInputElement).checked;
    const wantBldg = (dialog.querySelector('#cad-ly-bldg') as HTMLInputElement).checked;
    const wantRoad = (dialog.querySelector('#cad-ly-road') as HTMLInputElement).checked;
    const wantLandUse = (dialog.querySelector('#cad-ly-landuse') as HTMLInputElement).checked;

    if (!address) { log('Error: No address entered'); return; }
    if (!wantSat && !wantCadImg && !wantBdry && !wantJibun && !wantBldg && !wantRoad && !wantLandUse) {
      log('Error: No layers selected'); return;
    }

    close();
    log('Cadastral: resolving location...');

    try {
      let lon: number, lat: number;

      if (addrType === 'lonlat') {
        const parts = address.split(/[,\s]+/).map(Number);
        if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
          log('Error: Invalid lon/lat format. Use: 129.2106, 35.8562');
          return;
        }
        lon = parts[0];
        lat = parts[1];
      } else {
        const geoType = addrType === 'road' ? 'road' : 'parcel';
        let result = await geocodeAddress(address, geoType);
        if (!result && geoType === 'road') {
          result = await geocodeAddress(address, 'parcel');
        }
        if (!result) { log('Error: Address not found'); return; }
        lon = result.lon;
        lat = result.lat;
      }

      log(`Location: ${lon.toFixed(6)}, ${lat.toFixed(6)}`);
      const centerM = lonLatToMercator(lon, lat);
      const halfSpan = 200;

      if (wantSat) {
        log('Fetching satellite tiles...');
        await fetchSatelliteTiles(lon, lat, centerM, log);
      }
      if (wantCadImg) {
        log('Fetching cadastral map overlay...');
        await fetchCadastralImage(centerM, log);
      }
      if (wantBdry) {
        log('Fetching cadastral boundaries...');
        await fetchCadastralBoundaries(centerM, halfSpan, log);
      }
      if (wantJibun) {
        log('Fetching 지번 labels...');
        await fetchJibunLabels(centerM, halfSpan, log);
      }
      if (wantBldg) {
        log('Fetching buildings...');
        await fetchBuildings(centerM, halfSpan, log);
      }
      if (wantRoad) {
        log('Fetching roads...');
        await fetchRoads(centerM, halfSpan, log);
      }
      if (wantLandUse) {
        log('Fetching land use zones...');
        await fetchLandUse(centerM, halfSpan, log);
      }

      // Zoom to fit
      let extMinX = -halfSpan, extMinY = -halfSpan, extMaxX = halfSpan, extMaxY = halfSpan;
      for (const ov of store.rasterOverlays) {
        extMinX = Math.min(extMinX, ov.bounds.minX);
        extMinY = Math.min(extMinY, ov.bounds.minY);
        extMaxX = Math.max(extMaxX, ov.bounds.maxX);
        extMaxY = Math.max(extMaxY, ov.bounds.maxY);
      }
      const extW = extMaxX - extMinX;
      const extH = extMaxY - extMinY;
      const canvasEl = document.getElementById('cad-canvas')!;
      const cw = canvasEl.getBoundingClientRect().width;
      const ch = canvasEl.getBoundingClientRect().height;
      const zFit = Math.min(cw / (extW * 1.1), ch / (extH * 1.1));
      store.view.zoom = zFit;
      store.view.panX = (extMinX + extMaxX) / 2 - cw / (2 * zFit);
      store.view.panY = (extMinY + extMaxY) / 2 + ch / (2 * zFit);
      store.emit();
      log('Cadastral import complete');
    } catch (e: any) {
      log(`Cadastral error: ${e.message}`);
    }
  });

  const input = dialog.querySelector('#cad-address') as HTMLInputElement;
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dialog.querySelector<HTMLButtonElement>('#cad-ok')!.click();
    if (e.key === 'Escape') close();
  });
}

// ── Shelter Mode ──

async function loadShelterMode(
  address: string, addrType: string, log: (msg: string) => void,
) {
  log('쉼터: resolving location...');

  const loc = await resolveLocation(address, addrType);
  if (!loc) { log('Error: Address not found'); return; }
  const { lon, lat } = loc;

  log(`Location: ${lon.toFixed(6)}, ${lat.toFixed(6)}`);
  const centerM = lonLatToMercator(lon, lat);
  const halfSpan = 100;

  log('쉼터: fetching cadastral boundaries...');
  store.pushUndo('SHELTER_IMPORT');

  const bbox = makeBbox(centerM, halfSpan);
  const features = await fetchVectorData(bbox, 'LP_PA_CBND_BUBUN');
  if (features.length === 0) { log('No cadastral boundaries found'); return; }

  // Find user's parcel and its direct neighbors only
  const myParcel = findParcelAtPoint(features, centerM.x, centerM.y);
  const drawFeatures = myParcel
    ? features.filter(f => f === myParcel || sharesEdge(myParcel, f))
    : features;

  ensureLayer('CADASTRAL-BDRY', '#00ffff');
  ensureLayer('대상지', '#ff0000');
  const entities: Entity[] = [];
  const rings = extractPolygons(drawFeatures, centerM);
  for (const pts of rings) {
    entities.push({
      id: nextId(), type: 'polyline', layer: 'CADASTRAL-BDRY',
      color: 'bylayer', lineweight: 1, linetype: 'continuous',
      visible: true, selected: false,
      points: pts, bulges: pts.map(() => 0), closed: true,
    } as Entity);
  }
  store.entities.push(...entities);

  // Highlight user's parcel with thick red overlay
  if (myParcel) {
    const myRings = extractPolygons([myParcel], centerM);
    for (const pts of myRings) {
      store.entities.push({
        id: nextId(), type: 'polyline', layer: '대상지',
        color: 'bylayer', lineweight: 4, linetype: 'continuous',
        visible: true, selected: false,
        points: pts, bulges: pts.map(() => 0), closed: true,
      } as Entity);
    }
  }

  // Jibun labels (only for drawn parcels)
  for (const feat of drawFeatures) {
    const props = feat.properties || {};
    const jibun = props.jibun || `${props.bonbun || ''}-${props.bubun || ''}`;
    if (!jibun || jibun === '-') continue;
    const geom = feat.geometry;
    if (!geom) continue;
    const polys: number[][][][] = [];
    if (geom.type === 'Polygon') polys.push(geom.coordinates);
    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    if (polys.length > 0 && polys[0].length > 0) {
      const ring = polys[0][0];
      const pts = ring.map((c: number[]) => ({ x: c[0] - centerM.x, y: c[1] - centerM.y }));
      const center = polygonCentroid(pts);
      store.entities.push({
        id: nextId(), type: 'text', layer: 'CADASTRAL-BDRY',
        color: '#ffff00', lineweight: 1, linetype: 'continuous',
        visible: true, selected: false,
        position: center, text: jibun, height: 2, rotation: 0,
      } as Entity);
    }
  }

  log(`Boundaries: ${entities.length} polygons (${drawFeatures.length} of ${features.length} parcels — my parcel + neighbors)`);

  // Zoom to fit boundaries
  let extMinX = Infinity, extMinY = Infinity, extMaxX = -Infinity, extMaxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      extMinX = Math.min(extMinX, p.x);
      extMinY = Math.min(extMinY, p.y);
      extMaxX = Math.max(extMaxX, p.x);
      extMaxY = Math.max(extMaxY, p.y);
    }
  }
  const extW = extMaxX - extMinX || 100;
  const extH = extMaxY - extMinY || 100;
  const canvasEl = document.getElementById('cad-canvas')!;
  const cw = canvasEl.getBoundingClientRect().width;
  const ch = canvasEl.getBoundingClientRect().height;
  const zFit = Math.min(cw / (extW * 1.3), ch / (extH * 1.3));
  store.view.zoom = zFit;
  store.view.panX = (extMinX + extMaxX) / 2 - cw / (2 * zFit);
  store.view.panY = (extMinY + extMaxY) / 2 + ch / (2 * zFit);
  store.emit();

  // Gather metadata for 건축개요 table
  const myProps = myParcel?.properties || {};
  const myJibun = myProps.jibun || `${myProps.bonbun || ''}-${myProps.bubun || ''}`.replace(/^-$/, '');

  // Parcel area: use API field if available, else compute from coordinates
  let parcelArea = 0;
  if (myProps.parea) {
    parcelArea = parseFloat(myProps.parea);
  } else if (myParcel?.geometry) {
    const ring = featureRing(myParcel);
    if (ring.length > 0) {
      const rawArea = computePolygonArea(ring);
      const latRad = 2 * Math.atan(Math.exp(centerM.y / 6378137)) - Math.PI / 2;
      parcelArea = rawArea * Math.cos(latRad) * Math.cos(latRad);
    }
  }

  // Fetch land use zone (지역지구)
  let landUseZone = '';
  try {
    const luFeatures = await fetchVectorData(bbox, 'LT_C_UQ111');
    const luNames: string[] = [];
    for (const f of luFeatures) {
      const uname = f.properties?.uname;
      if (uname && !luNames.includes(uname)) luNames.push(uname);
    }
    landUseZone = luNames.join(', ');
  } catch { /* ignore */ }

  const meta: ShelterMeta = {
    address,
    jibun: myJibun,
    parcelArea: Math.round(parcelArea * 100) / 100,
    landUseZone,
  };

  // Start shelter placement at center of boundaries
  const shelterCenter = { x: (extMinX + extMaxX) / 2, y: (extMinY + extMaxY) / 2 };
  startShelterMode(shelterCenter, log, meta);
}
