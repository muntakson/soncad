"""MiniCAD DXF import/export backend."""

import io
import math
import os
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncio
import json as json_mod

import ezdxf
import httpx
from ezdxf.entities import DXFGraphic
from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from contextlib import asynccontextmanager

from backend.mcp_tools import mcp as _mcp_server, set_subscribers as _mcp_set_subs, get_state as _mcp_get_state, set_state as _mcp_set_state

_mcp_app = _mcp_server.http_app(path="/")


@asynccontextmanager
async def _lifespan(the_app):
    async with _mcp_app.router.lifespan_context(_mcp_app):
        yield


app = FastAPI(title="MiniCAD DXF Backend", lifespan=_lifespan)
app.mount("/api/mcp", _mcp_app)


class _McpSlashFix:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("path") == "/api/mcp":
            scope = dict(scope, path="/api/mcp/")
        await self.app(scope, receive, send)

app.add_middleware(_McpSlashFix)

# ── Cloud storage setup ──

STORAGE_DIR = Path(__file__).parent / "storage"
STORAGE_DIR.mkdir(exist_ok=True)
DB_PATH = STORAGE_DIR / "metadata.db"


def _init_db() -> None:
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS dxf_files (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            entity_count INTEGER NOT NULL DEFAULT 0,
            uploaded_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


_init_db()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── ACI color index → hex (AutoCAD standard palette, first 7) ──

ACI_HEX = {
    1: "#ff0000",
    2: "#ffff00",
    3: "#00ff00",
    4: "#00ffff",
    5: "#0000ff",
    6: "#ff00ff",
    7: "#ffffff",
}


def aci_to_hex(aci: int) -> str:
    return ACI_HEX.get(aci, "#ffffff")


def hex_to_aci(hex_color: str) -> int:
    inv = {v: k for k, v in ACI_HEX.items()}
    return inv.get(hex_color.lower(), 7)


# ── DXF → frontend entity conversion ──


def _eid() -> str:
    return f"e{uuid.uuid4().hex[:8]}"


def _base(entity: DXFGraphic) -> dict[str, Any]:
    color_val = entity.dxf.get("color", 256)
    if color_val == 256:
        color = "bylayer"
    elif color_val == 0:
        color = "bylayer"
    else:
        color = aci_to_hex(color_val)

    lw = entity.dxf.get("lineweight", -1)
    if lw < 0:
        lw = 1

    lt = entity.dxf.get("linetype", "")
    if not lt or lt.upper() == "BYLAYER":
        lt = "continuous"
    elif lt.upper() in ("DASHED", "HIDDEN"):
        lt = "dashed"
    elif lt.upper() in ("CENTER", "DASHDOT"):
        lt = "center"
    else:
        lt = "continuous"

    return {
        "id": _eid(),
        "layer": entity.dxf.get("layer", "0"),
        "color": color,
        "lineweight": max(1, lw // 10) if lw > 0 else 1,
        "linetype": lt,
        "visible": True,
        "selected": False,
    }


def convert_entity(entity: DXFGraphic) -> list[dict[str, Any]]:
    """Convert a single DXF entity to frontend JSON. Returns a list (INSERT can expand)."""
    dtype = entity.dxftype()
    try:
        if dtype == "LINE":
            return [_convert_line(entity)]
        elif dtype == "CIRCLE":
            return [_convert_circle(entity)]
        elif dtype == "ARC":
            return [_convert_arc(entity)]
        elif dtype == "LWPOLYLINE":
            return [_convert_lwpolyline(entity)]
        elif dtype == "POLYLINE":
            return [_convert_polyline(entity)]
        elif dtype == "ELLIPSE":
            return [_convert_ellipse(entity)]
        elif dtype == "TEXT":
            return [_convert_text(entity)]
        elif dtype == "MTEXT":
            return [_convert_mtext(entity)]
        elif dtype == "DIMENSION":
            return [_convert_dimension(entity)]
        elif dtype == "POINT":
            return [_convert_point(entity)]
        elif dtype == "HATCH":
            return [_convert_hatch(entity)]
        elif dtype == "INSERT":
            return _convert_insert(entity)
    except Exception:
        pass
    return []


def _convert_line(e: DXFGraphic) -> dict:
    s = e.dxf.start
    d = e.dxf.end
    return {**_base(e), "type": "line", "start": {"x": s.x, "y": s.y}, "end": {"x": d.x, "y": d.y}}


def _convert_circle(e: DXFGraphic) -> dict:
    c = e.dxf.center
    return {**_base(e), "type": "circle", "center": {"x": c.x, "y": c.y}, "radius": e.dxf.radius}


def _convert_arc(e: DXFGraphic) -> dict:
    c = e.dxf.center
    return {
        **_base(e),
        "type": "arc",
        "center": {"x": c.x, "y": c.y},
        "radius": e.dxf.radius,
        "startAngle": math.radians(e.dxf.start_angle),
        "endAngle": math.radians(e.dxf.end_angle),
    }


def _convert_lwpolyline(e: DXFGraphic) -> dict:
    points = []
    bulges = []
    for x, y, _start_w, _end_w, bulge in e.get_points(format="xyseb"):
        points.append({"x": x, "y": y})
        bulges.append(bulge)
    return {
        **_base(e),
        "type": "polyline",
        "points": points,
        "bulges": bulges,
        "closed": e.closed,
    }


def _convert_polyline(e: DXFGraphic) -> dict:
    points = []
    bulges = []
    for v in e.vertices:
        loc = v.dxf.location
        points.append({"x": loc.x, "y": loc.y})
        bulges.append(v.dxf.get("bulge", 0.0))
    return {
        **_base(e),
        "type": "polyline",
        "points": points,
        "bulges": bulges,
        "closed": e.is_closed,
    }


def _convert_ellipse(e: DXFGraphic) -> dict:
    c = e.dxf.center
    major = e.dxf.major_axis
    return {
        **_base(e),
        "type": "ellipse",
        "center": {"x": c.x, "y": c.y},
        "majorX": major.x,
        "majorY": major.y,
        "ratio": e.dxf.ratio,
        "startParam": e.dxf.start_param,
        "endParam": e.dxf.end_param,
    }


def _convert_text(e: DXFGraphic) -> dict:
    ins = e.dxf.get("insert", ezdxf.math.Vec3(0, 0, 0))
    return {
        **_base(e),
        "type": "text",
        "position": {"x": ins.x, "y": ins.y},
        "text": e.dxf.get("text", ""),
        "height": e.dxf.get("height", 2.5),
        "rotation": e.dxf.get("rotation", 0),
    }


def _convert_mtext(e: DXFGraphic) -> dict:
    ins = e.dxf.get("insert", ezdxf.math.Vec3(0, 0, 0))
    return {
        **_base(e),
        "type": "text",
        "position": {"x": ins.x, "y": ins.y},
        "text": e.plain_text(),
        "height": e.dxf.get("char_height", 2.5),
        "rotation": e.dxf.get("rotation", 0),
    }


def _convert_dimension(e: DXFGraphic) -> dict:
    defpoint = e.dxf.get("defpoint", ezdxf.math.Vec3(0, 0, 0))
    defpoint2 = e.dxf.get("defpoint2", ezdxf.math.Vec3(0, 0, 0))
    defpoint3 = e.dxf.get("defpoint3", ezdxf.math.Vec3(0, 0, 0))
    text_midpoint = e.dxf.get("text_midpoint", ezdxf.math.Vec3(0, 0, 0))
    dim_type_flags = e.dxf.get("dimtype", 0) & 0x0F

    if dim_type_flags == 0:
        dim_type = "linear"
    elif dim_type_flags == 1:
        dim_type = "aligned"
    elif dim_type_flags == 4:
        dim_type = "radius"
    elif dim_type_flags == 3:
        dim_type = "diameter"
    else:
        dim_type = "linear"

    override = e.dxf.get("text", "")

    return {
        **_base(e),
        "type": "dimension",
        "dimType": dim_type,
        "p1": {"x": defpoint2.x, "y": defpoint2.y},
        "p2": {"x": defpoint3.x, "y": defpoint3.y},
        "textPos": {"x": text_midpoint.x, "y": text_midpoint.y},
        "textOverride": override if override else None,
    }


def _convert_point(e: DXFGraphic) -> dict:
    loc = e.dxf.location
    return {**_base(e), "type": "point", "position": {"x": loc.x, "y": loc.y}, "pdmode": 3, "pdsize": 5}


def _convert_hatch(e: DXFGraphic) -> dict:
    boundaries: list[list[dict]] = []
    for path in e.paths:
        pts: list[dict] = []
        if hasattr(path, "vertices"):
            for v in path.vertices:
                pts.append({"x": v[0], "y": v[1]})
        elif hasattr(path, "edges"):
            for edge in path.edges:
                if hasattr(edge, "start"):
                    pts.append({"x": edge.start[0], "y": edge.start[1]})
        if pts:
            boundaries.append(pts)
    pattern = e.dxf.get("pattern_name", "SOLID") or "SOLID"
    return {
        **_base(e),
        "type": "hatch",
        "boundaries": boundaries,
        "patternName": pattern,
        "patternScale": e.dxf.get("pattern_scale", 1.0),
        "patternAngle": e.dxf.get("pattern_angle", 0.0),
    }


def _convert_insert(e: DXFGraphic, depth: int = 0) -> list[dict]:
    if depth > 6:
        return []
    results = []
    try:
        for virtual in e.virtual_entities():
            if virtual.dxftype() == "INSERT":
                results.extend(_convert_insert(virtual, depth + 1))
            else:
                results.extend(convert_entity(virtual))
    except Exception:
        pass
    return results


# ── Frontend entity → DXF entity ──


def write_entity(msp: Any, ent: dict, doc: Any) -> None:
    """Add a frontend entity dict to the DXF modelspace."""
    etype = ent.get("type")
    dxf_attribs: dict[str, Any] = {"layer": ent.get("layer", "0")}

    color = ent.get("color", "bylayer")
    if color != "bylayer":
        dxf_attribs["color"] = hex_to_aci(color)

    lt = ent.get("linetype", "continuous")
    if lt == "dashed":
        dxf_attribs["linetype"] = "DASHED"
    elif lt == "center":
        dxf_attribs["linetype"] = "CENTER"

    if etype == "line":
        msp.add_line(
            (ent["start"]["x"], ent["start"]["y"]),
            (ent["end"]["x"], ent["end"]["y"]),
            dxfattribs=dxf_attribs,
        )
    elif etype == "circle":
        msp.add_circle(
            (ent["center"]["x"], ent["center"]["y"]),
            ent["radius"],
            dxfattribs=dxf_attribs,
        )
    elif etype == "arc":
        msp.add_arc(
            (ent["center"]["x"], ent["center"]["y"]),
            ent["radius"],
            math.degrees(ent["startAngle"]),
            math.degrees(ent["endAngle"]),
            dxfattribs=dxf_attribs,
        )
    elif etype == "polyline":
        pts = ent.get("points", [])
        bulges = ent.get("bulges", [])
        fmt_pts = []
        for i, p in enumerate(pts):
            b = bulges[i] if i < len(bulges) else 0
            fmt_pts.append((p["x"], p["y"], 0, 0, b))
        pline = msp.add_lwpolyline(fmt_pts, format="xyseb", dxfattribs=dxf_attribs)
        if ent.get("closed"):
            pline.close()
    elif etype == "rect":
        c1, c2 = ent["corner1"], ent["corner2"]
        x1, y1 = min(c1["x"], c2["x"]), min(c1["y"], c2["y"])
        x2, y2 = max(c1["x"], c2["x"]), max(c1["y"], c2["y"])
        pts = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
        pline = msp.add_lwpolyline(pts, dxfattribs=dxf_attribs)
        pline.close()
    elif etype == "text":
        text_content = ent.get("text", "")
        if "\n" in text_content:
            msp.add_mtext(
                text_content,
                dxfattribs={
                    **dxf_attribs,
                    "insert": (ent["position"]["x"], ent["position"]["y"]),
                    "char_height": ent.get("height", 2.5),
                    "rotation": ent.get("rotation", 0),
                },
            )
        else:
            msp.add_text(
                text_content,
                dxfattribs={
                    **dxf_attribs,
                    "insert": (ent["position"]["x"], ent["position"]["y"]),
                    "height": ent.get("height", 2.5),
                    "rotation": ent.get("rotation", 0),
                },
            )
    elif etype == "point":
        msp.add_point(
            (ent["position"]["x"], ent["position"]["y"]),
            dxfattribs=dxf_attribs,
        )
    elif etype == "hatch":
        pattern = ent.get("patternName", "SOLID")
        if pattern == "SOLID":
            hatch = msp.add_hatch(dxfattribs=dxf_attribs)
        else:
            hatch = msp.add_hatch(
                dxfattribs=dxf_attribs,
            )
            hatch.set_pattern_fill(
                pattern,
                scale=ent.get("patternScale", 1.0),
                angle=ent.get("patternAngle", 0.0),
            )
        for boundary in ent.get("boundaries", []):
            pts = [(p["x"], p["y"]) for p in boundary]
            if pts:
                hatch.paths.add_polyline_path(pts, is_closed=True)
    elif etype == "ellipse":
        msp.add_ellipse(
            (ent["center"]["x"], ent["center"]["y"]),
            (ent["majorX"], ent["majorY"], 0),
            ent["ratio"],
            ent.get("startParam", 0),
            ent.get("endParam", math.tau),
            dxfattribs=dxf_attribs,
        )
    elif etype == "dimension":
        dim_type = ent.get("dimType", "linear")
        p1 = (ent["p1"]["x"], ent["p1"]["y"])
        p2 = (ent["p2"]["x"], ent["p2"]["y"])
        tp = ent.get("textPos", {"x": 0, "y": 0})
        text_pos = (tp["x"], tp["y"])
        override = ent.get("textOverride")
        dimtxt = 0.08
        dimasz = 0.05
        if dim_type in ("linear", "aligned"):
            dx = abs(p2[0] - p1[0])
            dy = abs(p2[1] - p1[1])
            angle = 90 if dy > dx else 0
            dim = msp.add_linear_dim(base=text_pos, p1=p1, p2=p2, angle=angle, override={"dimtxt": dimtxt, "dimasz": dimasz})
            if override:
                dim.dimension.dxf.text = override
            dim.render()
        elif dim_type == "radius":
            r = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
            if r > 0:
                msp.add_radius_dim(center=p1, radius=r, angle=math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0])),
                                   override={"dimtxt": dimtxt, "dimasz": dimasz}).render()
        elif dim_type == "diameter":
            r = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
            if r > 0:
                msp.add_diameter_dim(center=p1, radius=r, angle=math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0])),
                                     override={"dimtxt": dimtxt, "dimasz": dimasz}).render()


# ── API Endpoints ──


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/dxf/import")
async def dxf_import(file: UploadFile = File(...)):
    contents = await file.read()
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
    tmp.write(contents)
    tmp.close()
    try:
        doc = ezdxf.readfile(tmp.name)
    except Exception as exc:
        os.unlink(tmp.name)
        return {"error": f"Failed to parse DXF: {exc}"}
    os.unlink(tmp.name)

    msp = doc.modelspace()
    entities: list[dict] = []
    for entity in msp:
        entities.extend(convert_entity(entity))

    layers: list[dict] = []
    for layer in doc.layers:
        layers.append({
            "name": layer.dxf.name,
            "color": aci_to_hex(layer.color),
            "visible": not layer.is_off,
            "locked": layer.is_locked,
            "current": layer.dxf.name == "0",
        })
    if not layers:
        layers.append({"name": "0", "color": "#ffffff", "visible": True, "locked": False, "current": True})

    return {"entities": entities, "layers": layers, "count": len(entities)}


class ExportPayload(BaseModel):
    entities: list[dict]
    layers: list[dict] = []
    filename: str = "drawing.dxf"


@app.post("/api/dxf/export")
async def dxf_export(payload: ExportPayload):
    doc = ezdxf.new(dxfversion="R2010", units=ezdxf.units.MM)
    msp = doc.modelspace()

    std = doc.dimstyles.get("Standard")
    std.dxf.dimtxt = 0.08
    std.dxf.dimasz = 0.05
    std.dxf.dimexe = 0.05
    std.dxf.dimexo = 0.025
    std.dxf.dimgap = 0.025

    for layer_data in payload.layers:
        name = layer_data["name"]
        color = hex_to_aci(layer_data.get("color", "#ffffff"))
        if name in doc.layers:
            doc.layers.get(name).color = color
        else:
            doc.layers.add(name, color=color)

    for ent in payload.entities:
        write_entity(msp, ent, doc)

    strbuf = io.StringIO()
    doc.write(strbuf)
    buf = io.BytesIO(strbuf.getvalue().encode("utf-8"))

    return StreamingResponse(
        buf,
        media_type="application/dxf",
        headers={"Content-Disposition": f'attachment; filename="{payload.filename}"'},
    )


# ── Cloud Storage Endpoints ──


class CloudSavePayload(BaseModel):
    entities: list[dict]
    layers: list[dict] = []
    filename: str = "drawing.dxf"


@app.post("/api/cloud/save")
async def cloud_save(payload: CloudSavePayload):
    """Save current drawing as DXF to cloud storage."""
    doc = ezdxf.new(dxfversion="R2010", units=ezdxf.units.MM)
    msp = doc.modelspace()

    std = doc.dimstyles.get("Standard")
    std.dxf.dimtxt = 0.08
    std.dxf.dimasz = 0.05
    std.dxf.dimexe = 0.05
    std.dxf.dimexo = 0.025
    std.dxf.dimgap = 0.025

    for layer_data in payload.layers:
        name = layer_data["name"]
        color = hex_to_aci(layer_data.get("color", "#ffffff"))
        if name in doc.layers:
            doc.layers.get(name).color = color
        else:
            doc.layers.add(name, color=color)

    for ent in payload.entities:
        write_entity(msp, ent, doc)

    file_id = uuid.uuid4().hex[:12]
    fname = payload.filename if payload.filename.endswith(".dxf") else payload.filename + ".dxf"
    file_path = STORAGE_DIR / f"{file_id}.dxf"

    doc.saveas(str(file_path))
    file_size = file_path.stat().st_size
    now = datetime.now(timezone.utc).isoformat()

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO dxf_files (id, filename, file_size, entity_count, uploaded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (file_id, fname, file_size, len(payload.entities), now, now),
    )
    conn.commit()
    conn.close()

    return {"id": file_id, "filename": fname, "file_size": file_size, "entity_count": len(payload.entities)}


@app.post("/api/cloud/upload")
async def cloud_upload(file: UploadFile = File(...)):
    """Upload a raw DXF file to cloud storage."""
    contents = await file.read()
    file_id = uuid.uuid4().hex[:12]
    fname = file.filename or "upload.dxf"

    file_path = STORAGE_DIR / f"{file_id}.dxf"
    file_path.write_bytes(contents)

    entity_count = 0
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
    tmp.write(contents)
    tmp.close()
    try:
        doc = ezdxf.readfile(tmp.name)
        msp = doc.modelspace()
        for entity in msp:
            entity_count += len(convert_entity(entity))
    except Exception:
        pass
    os.unlink(tmp.name)

    file_size = len(contents)
    now = datetime.now(timezone.utc).isoformat()

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute(
        "INSERT INTO dxf_files (id, filename, file_size, entity_count, uploaded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (file_id, fname, file_size, entity_count, now, now),
    )
    conn.commit()
    conn.close()

    return {"id": file_id, "filename": fname, "file_size": file_size, "entity_count": entity_count}


@app.get("/api/cloud/list")
def cloud_list():
    """List all DXF files in cloud storage."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM dxf_files ORDER BY updated_at DESC").fetchall()
    conn.close()
    return {"files": [dict(r) for r in rows]}


@app.get("/api/cloud/open/{file_id}")
async def cloud_open(file_id: str):
    """Open a DXF file from cloud storage, returning entities JSON."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM dxf_files WHERE id = ?", (file_id,)).fetchone()
    conn.close()
    if not row:
        return {"error": "File not found"}

    file_path = STORAGE_DIR / f"{file_id}.dxf"
    if not file_path.exists():
        return {"error": "File data missing from storage"}

    try:
        doc = ezdxf.readfile(str(file_path))
    except Exception as exc:
        return {"error": f"Failed to parse DXF: {exc}"}

    msp = doc.modelspace()
    entities: list[dict] = []
    for entity in msp:
        entities.extend(convert_entity(entity))

    layers: list[dict] = []
    for layer in doc.layers:
        layers.append({
            "name": layer.dxf.name,
            "color": aci_to_hex(layer.color),
            "visible": not layer.is_off,
            "locked": layer.is_locked,
            "current": layer.dxf.name == "0",
        })
    if not layers:
        layers.append({"name": "0", "color": "#ffffff", "visible": True, "locked": False, "current": True})

    return {"entities": entities, "layers": layers, "count": len(entities), "filename": row["filename"]}


@app.delete("/api/cloud/delete/{file_id}")
def cloud_delete(file_id: str):
    """Delete a DXF file from cloud storage."""
    conn = sqlite3.connect(str(DB_PATH))
    row = conn.execute("SELECT id FROM dxf_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        conn.close()
        return {"error": "File not found"}
    conn.execute("DELETE FROM dxf_files WHERE id = ?", (file_id,))
    conn.commit()
    conn.close()

    file_path = STORAGE_DIR / f"{file_id}.dxf"
    if file_path.exists():
        file_path.unlink()

    return {"ok": True}


# ── MCP Live Sync (SSE) ──

_mcp_subscribers: list[asyncio.Queue] = []
_mcp_set_subs(_mcp_subscribers)


@app.get("/api/live/state")
async def mcp_state():
    """Return the current MCP drawing state (entities + layers)."""
    return _mcp_get_state()


@app.post("/api/live/sync")
async def mcp_sync(request: Request):
    """Receive entity state from MCP server and broadcast to all SSE subscribers."""
    data = await request.json()
    _mcp_set_state(data.get("entities", []), data.get("layers", []))
    payload = json_mod.dumps(data)
    dead = []
    for q in _mcp_subscribers:
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _mcp_subscribers.remove(q)
    return {"ok": True, "subscribers": len(_mcp_subscribers)}


@app.get("/api/live/events")
async def mcp_events(request: Request):
    """SSE stream that pushes MCP entity updates to the browser."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    _mcp_subscribers.append(queue)

    async def event_generator():
        try:
            yield "event: connected\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"event: sync\ndata: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if queue in _mcp_subscribers:
                _mcp_subscribers.remove(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── VWorld Cadastral Proxy ──

def _vworld_key() -> str:
    key = os.environ.get("VWORLD_API_KEY", "")
    if not key:
        secrets_path = Path.home() / ".secrets"
        if secrets_path.exists():
            text = secrets_path.read_text()
            if secrets_path.is_file():
                for line in text.splitlines():
                    if line.startswith("VWORLD_API_KEY="):
                        key = line.split("=", 1)[1].strip()
                        break
            elif (secrets_path / "vworld_api_key").exists():
                key = (secrets_path / "vworld_api_key").read_text().strip()
    return key


@app.get("/api/vworld/geocode")
async def vworld_geocode(
    address: str = Query(...),
    type: str = Query("road"),
):
    key = _vworld_key()
    if not key:
        return {"error": "VWORLD_API_KEY not configured"}
    addr_type = "road" if type == "road" else "parcel"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            "https://api.vworld.kr/req/address",
            params={
                "service": "address",
                "request": "getcoord",
                "version": "2.0",
                "crs": "epsg:4326",
                "address": address,
                "format": "json",
                "type": addr_type,
                "key": key,
            },
        )
    return resp.json()


@app.get("/api/vworld/satellite/{z}/{y}/{x}")
async def vworld_satellite(z: int, y: int, x: int):
    key = _vworld_key()
    if not key:
        return {"error": "VWORLD_API_KEY not configured"}
    url = f"https://api.vworld.kr/req/wmts/1.0.0/{key}/Satellite/{z}/{y}/{x}.jpeg"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url)
    return Response(content=resp.content, media_type="image/jpeg")


@app.get("/api/vworld/image")
async def vworld_image(
    center: str = Query(...),
    zoom: int = Query(18),
    layers: str = Query("lp_pa_cbnd_bonbun"),
    size: str = Query("1024,1024"),
    basemap: str = Query("GRAPHIC"),
):
    key = _vworld_key()
    if not key:
        return {"error": "VWORLD_API_KEY not configured"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            "https://api.vworld.kr/req/image",
            params={
                "service": "image",
                "request": "getmap",
                "basemap": basemap,
                "layers": layers,
                "center": center,
                "zoom": str(zoom),
                "crs": "EPSG:3857",
                "size": size,
                "format": "png",
                "transparent": "true",
                "key": key,
            },
        )
    ct = resp.headers.get("content-type", "image/png")
    return Response(content=resp.content, media_type=ct)


@app.get("/api/vworld/data")
async def vworld_data(
    bbox: str = Query(...),
    data: str = Query("LP_PA_CBND_BUBUN"),
    page: int = Query(1),
    size: int = Query(1000),
):
    key = _vworld_key()
    if not key:
        return {"error": "VWORLD_API_KEY not configured"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            "https://api.vworld.kr/req/data",
            params={
                "service": "data",
                "request": "GetFeature",
                "data": data,
                "key": key,
                "format": "json",
                "crs": "EPSG:3857",
                "geomFilter": f"BOX({bbox})",
                "size": str(size),
                "page": str(page),
                "domain": "minicad.dnaboy.org",
            },
        )
    return resp.json()


# ── VWorld 토지이동이력 (Land Movement History) ──

@app.get("/api/land/history")
async def land_move_history(
    pnu: str = Query(..., min_length=19, max_length=19),
    numOfRows: int = Query(1000),
    pageNo: int = Query(1),
):
    key = _vworld_key()
    if not key:
        return {"error": "VWORLD_API_KEY not configured"}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            "https://api.vworld.kr/ned/data/getLandMoveAttr",
            params={
                "key": key,
                "pnu": pnu,
                "numOfRows": str(numOfRows),
                "pageNo": str(pageNo),
                "format": "json",
                "domain": "minicad.dnaboy.org",
            },
        )
    return resp.json()


@app.get("/api/land/use")
async def land_use_plan(
    pnu: str = Query(..., min_length=19, max_length=19),
    numOfRows: int = Query(1000),
    pageNo: int = Query(1),
):
    key = _vworld_key()
    if not key:
        return {"error": "VWORLD_API_KEY not configured"}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            "https://api.vworld.kr/ned/data/getLandUseAttr",
            params={
                "key": key,
                "pnu": pnu,
                "numOfRows": str(numOfRows),
                "pageNo": str(pageNo),
                "format": "json",
                "domain": "minicad.dnaboy.org",
            },
        )
    return resp.json()


@app.get("/api/land/price")
async def land_price_history(
    pnu: str = Query(..., min_length=19, max_length=19),
    numOfRows: int = Query(1000),
    pageNo: int = Query(1),
):
    key = _vworld_key()
    if not key:
        return {"error": "VWORLD_API_KEY not configured"}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            "https://api.vworld.kr/ned/data/getIndvdLandPriceAttr",
            params={
                "key": key,
                "pnu": pnu,
                "numOfRows": str(numOfRows),
                "pageNo": str(pageNo),
                "format": "json",
                "domain": "minicad.dnaboy.org",
            },
        )
    return resp.json()
