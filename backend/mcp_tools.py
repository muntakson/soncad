"""SonCAD MCP server — exposes CAD drawing tools over HTTP for Claude.ai integration.

Mount on FastAPI via:  app.mount("/mcp", mcp.http_app())
"""

import asyncio
import io
import math
import uuid
from typing import Any

import httpx
from fastmcp import FastMCP
from fastmcp.utilities.types import Image as MCPImage
from PIL import Image as PILImage, ImageDraw, ImageFont

mcp = FastMCP(
    "SonCAD",
    instructions=(
        "SonCAD is a web-based CAD editor. Use these tools to create and edit "
        "2D technical drawings (DXF format). The primary workflow: extract geometry "
        "from a mechanical drawing image using your vision, then call batch_add_entities "
        "to push all entities at once. The drawing syncs live to the user's browser at "
        "soncad.dnaboy.org.\n\n"
        "IMPORTANT — after pushing entities, ALWAYS call take_screenshot to visually "
        "verify the result. If something looks wrong (e.g. an arc appears as a full "
        "circle or sweeps the wrong way), fix the geometry and re-push.\n\n"
        "ARC ANGLES: Angles are in DEGREES, counterclockwise from +X axis. "
        "An arc sweeps CCW from startAngle to endAngle. For a 90° fillet at an "
        "inner corner, the SHORT arc is the one where endAngle - startAngle = 90. "
        "Example: a fillet from the bottom (270°) to the left (180°) of the center "
        "should be startAngle=180, endAngle=270 (NOT 270→180, which would sweep 270°). "
        "Think: which 90° sector does the fillet curve occupy?"
    ),
)

BACKEND_INTERNAL = "http://localhost:3002"

_subscribers: list[asyncio.Queue] | None = None


def set_subscribers(subs: list[asyncio.Queue]):
    global _subscribers
    _subscribers = subs


def get_state() -> dict:
    return {"entities": _entities, "layers": _layers}


def set_state(entities: list, layers: list):
    global _entities, _layers, _next_id
    _entities = entities
    _layers = layers if layers else _layers
    if entities:
        max_id = 0
        for e in entities:
            try:
                max_id = max(max_id, int(e.get("id", "0")))
            except (ValueError, TypeError):
                pass
        _next_id = max_id + 1


async def _broadcast(entities: list, layers: list):
    """Push entity state to all SSE subscribers (browser live sync)."""
    if _subscribers is None:
        return
    import json
    payload = json.dumps({"entities": entities, "layers": layers})
    dead = []
    for q in _subscribers:
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _subscribers.remove(q)


# ── In-memory drawing state ──

_next_id = 1
_entities: list[dict] = []
_layers: list[dict] = [
    {"name": "0", "color": "#ffffff", "visible": True, "locked": False,
     "frozen": False, "current": True, "lineweight": 1, "plot": True},
]


def _eid() -> str:
    global _next_id
    eid = str(_next_id)
    _next_id += 1
    return eid


def _make_entity(etype: str, props: dict, layer: str = "0", color: str = "#ffffff") -> dict:
    return {
        "id": _eid(),
        "type": etype,
        "layer": layer,
        "color": color,
        "lineweight": 1,
        "linetype": "Continuous",
        "visible": True,
        "selected": False,
        **props,
    }


def _parse_entity(spec: dict) -> dict | None:
    etype = spec.get("type")
    if not etype:
        return None

    layer = spec.get("layer", "0")
    color = spec.get("color", "#ffffff")
    props: dict[str, Any] = {}

    if etype == "line":
        props = {"start": spec["start"], "end": spec["end"]}
    elif etype == "circle":
        props = {"center": spec["center"], "radius": spec["radius"]}
    elif etype == "arc":
        props = {
            "center": spec["center"], "radius": spec["radius"],
            "startAngle": math.radians(spec["startAngle"]),
            "endAngle": math.radians(spec["endAngle"]),
        }
    elif etype == "polyline":
        pts = spec["points"]
        props = {
            "points": pts,
            "bulges": spec.get("bulges", [0] * len(pts)),
            "closed": spec.get("closed", False),
        }
    elif etype == "rect":
        props = {"corner1": spec["corner1"], "corner2": spec["corner2"]}
    elif etype == "text":
        props = {
            "position": spec["position"], "text": spec["text"],
            "height": spec.get("height", 2.5), "rotation": spec.get("rotation", 0),
        }
    elif etype == "dimension":
        props = {
            "dimType": spec.get("dimType", "linear"),
            "p1": spec["p1"], "p2": spec["p2"],
            "textPos": spec.get("textPos", spec["p1"]),
        }
        if spec.get("textOverride"):
            props["textOverride"] = spec["textOverride"]
    elif etype == "point":
        props = {"position": spec["position"], "pdmode": 3, "pdsize": 5}
    elif etype == "ellipse":
        props = {
            "center": spec["center"],
            "majorX": spec["majorX"], "majorY": spec["majorY"],
            "ratio": spec.get("ratio", 1),
            "startParam": spec.get("startParam", 0),
            "endParam": spec.get("endParam", math.tau),
        }
    elif etype == "hatch":
        props = {
            "boundaries": spec["boundaries"],
            "patternName": spec.get("patternName", "SOLID"),
            "patternScale": spec.get("patternScale", 1),
            "patternAngle": spec.get("patternAngle", 0),
        }
    else:
        return None

    return _make_entity(etype, props, layer, color)


# ── Tools ──


@mcp.tool()
async def batch_add_entities(
    entities: list[dict],
    clear: bool = True,
    layers: list[dict] | None = None,
    filename: str | None = None,
) -> str:
    """Add multiple CAD entities at once — the primary tool for image-to-DXF.

    Each entity dict needs a "type" and type-specific geometry:
      line:      {start:{x,y}, end:{x,y}}
      circle:    {center:{x,y}, radius}
      arc:       {center:{x,y}, radius, startAngle, endAngle}  (degrees, CCW)
      polyline:  {points:[{x,y},...], closed?, bulges?:[]}
      text:      {position:{x,y}, text, height?, rotation?}
      dimension: {dimType, p1:{x,y}, p2:{x,y}, textPos:{x,y}, textOverride?}

    Args:
        entities: Array of entity objects
        clear: Clear existing drawing first (default True)
        layers: Optional layers to create [{name, color}]
        filename: If set, also save to cloud storage under this name
    """
    global _entities, _layers, _next_id

    if clear:
        _entities = []
        _next_id = 1
        _layers = [
            {"name": "0", "color": "#ffffff", "visible": True, "locked": False,
             "frozen": False, "current": True, "lineweight": 1, "plot": True},
        ]

    if layers:
        for l in layers:
            if not any(ll["name"] == l["name"] for ll in _layers):
                _layers.append({
                    "name": l["name"], "color": l.get("color", "#ffffff"),
                    "visible": True, "locked": False, "frozen": False,
                    "current": False, "lineweight": 1, "plot": True,
                })

    added = []
    for spec in entities:
        e = _parse_entity(spec)
        if e:
            _entities.append(e)
            added.append(e["id"])

    await _broadcast(_entities, _layers)

    cloud_msg = ""
    if filename:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                res = await client.post(
                    f"{BACKEND_INTERNAL}/api/cloud/save",
                    json={"entities": _entities, "layers": _layers, "filename": filename},
                )
                if res.status_code == 200:
                    data = res.json()
                    cloud_msg = f" | Saved to cloud: id={data['id']}, filename={data['filename']}"
        except Exception:
            pass

    return f"Added {len(added)} entities (ids: {','.join(added)}){cloud_msg}"


@mcp.tool()
async def add_circle(center_x: float, center_y: float, radius: float, layer: str = "0") -> str:
    """Draw a circle at center with radius."""
    e = _make_entity("circle", {"center": {"x": center_x, "y": center_y}, "radius": radius}, layer)
    _entities.append(e)
    await _broadcast(_entities, _layers)
    return f"Circle added (id={e['id']}): center=({center_x},{center_y}), r={radius}"


@mcp.tool()
async def add_line(start_x: float, start_y: float, end_x: float, end_y: float, layer: str = "0") -> str:
    """Draw a line from start to end point."""
    e = _make_entity("line", {"start": {"x": start_x, "y": start_y}, "end": {"x": end_x, "y": end_y}}, layer)
    _entities.append(e)
    await _broadcast(_entities, _layers)
    return f"Line added (id={e['id']}): ({start_x},{start_y}) → ({end_x},{end_y})"


@mcp.tool()
async def add_arc(
    center_x: float, center_y: float, radius: float,
    start_angle: float, end_angle: float, layer: str = "0",
) -> str:
    """Draw an arc. Angles in degrees, counterclockwise from +X axis."""
    e = _make_entity("arc", {
        "center": {"x": center_x, "y": center_y}, "radius": radius,
        "startAngle": math.radians(start_angle), "endAngle": math.radians(end_angle),
    }, layer)
    _entities.append(e)
    await _broadcast(_entities, _layers)
    return f"Arc added (id={e['id']}): center=({center_x},{center_y}), r={radius}, {start_angle}°→{end_angle}°"


@mcp.tool()
async def add_polyline(points: list[dict], closed: bool = False, layer: str = "0") -> str:
    """Draw a polyline through points [{x,y},...]. Set closed=true for polygon."""
    e = _make_entity("polyline", {
        "points": points, "bulges": [0] * len(points), "closed": closed,
    }, layer)
    _entities.append(e)
    await _broadcast(_entities, _layers)
    return f"Polyline added (id={e['id']}): {len(points)} points, closed={closed}"


@mcp.tool()
async def add_text(x: float, y: float, text: str, height: float = 2.5, rotation: float = 0, layer: str = "0") -> str:
    """Add a text label at position."""
    e = _make_entity("text", {
        "position": {"x": x, "y": y}, "text": text, "height": height, "rotation": rotation,
    }, layer)
    _entities.append(e)
    await _broadcast(_entities, _layers)
    return f"Text added (id={e['id']}): \"{text}\" at ({x},{y})"


@mcp.tool()
async def clear_drawing() -> str:
    """Clear all entities and reset layers."""
    global _entities, _layers, _next_id
    count = len(_entities)
    _entities = []
    _next_id = 1
    _layers = [
        {"name": "0", "color": "#ffffff", "visible": True, "locked": False,
         "frozen": False, "current": True, "lineweight": 1, "plot": True},
    ]
    await _broadcast(_entities, _layers)
    return f"Drawing cleared ({count} entities removed)"


@mcp.tool()
async def list_entities(layer: str | None = None, entity_type: str | None = None) -> str:
    """List all entities. Optionally filter by layer or type."""
    result = _entities
    if layer:
        result = [e for e in result if e.get("layer") == layer]
    if entity_type:
        result = [e for e in result if e.get("type") == entity_type]

    lines = []
    for e in result:
        desc = f"id={e['id']} type={e['type']} layer={e.get('layer', '0')}"
        if e["type"] == "circle":
            desc += f" center=({e['center']['x']},{e['center']['y']}) r={e['radius']}"
        elif e["type"] == "line":
            desc += f" ({e['start']['x']},{e['start']['y']})→({e['end']['x']},{e['end']['y']})"
        elif e["type"] == "arc":
            desc += f" center=({e['center']['x']},{e['center']['y']}) r={e['radius']}"
        elif e["type"] == "text":
            desc += f" \"{e['text']}\" at ({e['position']['x']},{e['position']['y']})"
        lines.append(desc)

    return f"{len(result)} entities:\n" + ("\n".join(lines) or "(empty)")


@mcp.tool()
async def cloud_save(filename: str = "drawing.dxf") -> str:
    """Save current drawing to SonCAD cloud storage. Returns the file ID."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                f"{BACKEND_INTERNAL}/api/cloud/save",
                json={"entities": _entities, "layers": _layers, "filename": filename},
            )
            if res.status_code == 200:
                data = res.json()
                return f"Saved \"{data['filename']}\" (id={data['id']}, {data['entity_count']} entities)"
            return f"Save failed: {res.status_code}"
    except Exception as exc:
        return f"Save failed: {exc}"


@mcp.tool()
async def cloud_list() -> str:
    """List all DXF files in SonCAD cloud storage."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(f"{BACKEND_INTERNAL}/api/cloud/list")
            data = res.json()
            files = data.get("files", [])
            if not files:
                return "No files in cloud storage."
            lines = [
                f"id={f['id']}  {f['filename']}  {f['entity_count']} entities  {f['uploaded_at']}"
                for f in files
            ]
            return f"{len(files)} files:\n" + "\n".join(lines)
    except Exception as exc:
        return f"Failed: {exc}"


@mcp.tool()
async def export_dxf(filename: str = "drawing.dxf") -> str:
    """Export current drawing as DXF file via the backend."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                f"{BACKEND_INTERNAL}/api/dxf/export",
                json={"entities": _entities, "layers": _layers, "filename": filename},
            )
            if res.status_code == 200:
                from pathlib import Path
                out = Path(filename)
                out.write_bytes(res.content)
                return f"DXF exported to {out.resolve()} ({len(_entities)} entities)"
            return f"Export failed: {res.status_code}"
    except Exception as exc:
        return f"Export failed: {exc}"


def _render_screenshot(width: int = 800, height: int = 600) -> bytes:
    """Render current entities to a PNG image, matching SonCAD's canvas renderer."""
    if not _entities:
        img = PILImage.new("RGB", (width, height), (30, 30, 30))
        d = ImageDraw.Draw(img)
        d.text((width // 2 - 60, height // 2), "Empty drawing", fill=(128, 128, 128))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    # Calculate bounding box
    xs, ys = [], []
    for e in _entities:
        t = e["type"]
        if t == "line":
            xs += [e["start"]["x"], e["end"]["x"]]
            ys += [e["start"]["y"], e["end"]["y"]]
        elif t == "circle":
            xs += [e["center"]["x"] - e["radius"], e["center"]["x"] + e["radius"]]
            ys += [e["center"]["y"] - e["radius"], e["center"]["y"] + e["radius"]]
        elif t == "arc":
            xs += [e["center"]["x"] - e["radius"], e["center"]["x"] + e["radius"]]
            ys += [e["center"]["y"] - e["radius"], e["center"]["y"] + e["radius"]]
        elif t == "polyline":
            for p in e["points"]:
                xs.append(p["x"]); ys.append(p["y"])
        elif t == "text":
            xs.append(e["position"]["x"]); ys.append(e["position"]["y"])
        elif t == "dimension":
            xs += [e["p1"]["x"], e["p2"]["x"]]
            ys += [e["p1"]["y"], e["p2"]["y"]]
        elif t == "rect":
            xs += [e["corner1"]["x"], e["corner2"]["x"]]
            ys += [e["corner1"]["y"], e["corner2"]["y"]]
        elif t == "point":
            xs.append(e["position"]["x"]); ys.append(e["position"]["y"])

    if not xs:
        xs, ys = [0], [0]

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    pad = 20
    w_range = max_x - min_x or 1
    h_range = max_y - min_y or 1
    scale = min((width - 2 * pad) / w_range, (height - 2 * pad) / h_range)

    def tx(x: float) -> float:
        return pad + (x - min_x) * scale

    def ty(y: float) -> float:
        return height - pad - (y - min_y) * scale

    img = PILImage.new("RGB", (width, height), (30, 30, 30))
    d = ImageDraw.Draw(img)

    for e in _entities:
        color = e.get("color", "#ffffff")
        t = e["type"]

        if t == "line":
            d.line([(tx(e["start"]["x"]), ty(e["start"]["y"])),
                     (tx(e["end"]["x"]), ty(e["end"]["y"]))], fill=color, width=1)

        elif t == "circle":
            cx, cy, r = tx(e["center"]["x"]), ty(e["center"]["y"]), e["radius"] * scale
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=1)

        elif t == "arc":
            cx, cy, r = tx(e["center"]["x"]), ty(e["center"]["y"]), e["radius"] * scale
            start_rad = e["startAngle"]
            end_rad = e["endAngle"]
            # Match canvas renderer: ctx.arc(x, y, r, -end, -start) with Y-flip
            # Pillow arc uses degrees, screen coords (Y down)
            s_deg = -math.degrees(end_rad)
            e_deg = -math.degrees(start_rad)
            if e_deg < s_deg:
                e_deg += 360
            d.arc([cx - r, cy - r, cx + r, cy + r], s_deg, e_deg, fill=color, width=2)

        elif t == "polyline":
            pts = [(tx(p["x"]), ty(p["y"])) for p in e["points"]]
            if len(pts) >= 2:
                if e.get("closed") and len(pts) >= 3:
                    d.polygon(pts, outline=color)
                else:
                    d.line(pts, fill=color, width=1)

        elif t == "text":
            px, py = tx(e["position"]["x"]), ty(e["position"]["y"])
            d.text((px, py), e.get("text", ""), fill=color)

        elif t == "dimension":
            p1x, p1y = tx(e["p1"]["x"]), ty(e["p1"]["y"])
            p2x, p2y = tx(e["p2"]["x"]), ty(e["p2"]["y"])
            d.line([(p1x, p1y), (p2x, p2y)], fill="#00ffff", width=1)
            if e.get("textOverride"):
                mx, my = (p1x + p2x) / 2, (p1y + p2y) / 2 - 10
                d.text((mx, my), e["textOverride"], fill="#00ffff")

        elif t == "rect":
            c1 = (tx(e["corner1"]["x"]), ty(e["corner1"]["y"]))
            c2 = (tx(e["corner2"]["x"]), ty(e["corner2"]["y"]))
            d.rectangle([c1, c2], outline=color, width=1)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@mcp.tool()
async def take_screenshot(width: int = 800, height: int = 600) -> MCPImage:
    """Take a screenshot of the current drawing. Use this to visually verify
    your work after adding entities. Returns a PNG image you can inspect.
    If arcs or geometry look wrong, fix and re-push.
    """
    png_data = _render_screenshot(width, height)
    return MCPImage(data=png_data, format="png")
