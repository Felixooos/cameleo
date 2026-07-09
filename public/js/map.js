/*
 * Génération + rendu de la carte "tapis d'enfant vu du dessus".
 * 100% vectoriel : dessiné à chaque frame avec la transform caméra
 * => aucun pixel visible, quel que soit le zoom.
 * Déterministe (même graine partout) pour que la pipette soit cohérente.
 */
(function () {
  const S = window.SHARED;

  // PRNG déterministe (mulberry32).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FIELD_PALETTE = [
    "#9bc56a", "#8cbb5e", "#a8cf73", "#7fae5a", "#b6d27e",
    "#c8b773", "#d9c98a", "#bcd98c", "#94c060", "#aac77a",
  ];
  const ROOF_PALETTE = ["#c0492f", "#d96a3a", "#b8553e", "#8a5a3b", "#4f6f8a", "#c9803a", "#7a4b8c"];
  const CAR_COLORS = ["#e23b3b", "#3b6fe2", "#f2c33b", "#46c06a", "#e2e2e2", "#222", "#e87fb0"];

  function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  function generateMap(seed) {
    const rng = mulberry32(seed || S.MAP_SEED);
    const W = S.WORLD_W, H = S.WORLD_H;

    // ----- Champs (patchwork de cellules) -----
    const cell = 200;
    const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
    const fields = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        fields.push({
          x: c * cell, y: r * cell, w: cell, h: cell,
          color: pick(rng, FIELD_PALETTE),
          rows: rng() < 0.35, // hachures de cultures
          rowAngle: rng() < 0.5 ? 0 : Math.PI / 2,
        });
      }
    }

    // ----- Eau : un lac + une rivière sinueuse -----
    const lakes = [
      { x: W * 0.72, y: H * 0.26, rx: 320, ry: 230 },
      { x: W * 0.22, y: H * 0.74, rx: 240, ry: 180 },
    ];
    const river = [];
    {
      let x = -50, y = H * 0.45;
      while (x < W + 50) {
        river.push({ x, y });
        x += 120;
        y += (rng() - 0.5) * 220;
        y = Math.max(150, Math.min(H - 150, y));
      }
    }

    // ----- Routes : grille de routes principales + rues -----
    const roads = [];
    const mainV = [W * 0.33, W * 0.66];
    const mainH = [H * 0.3, H * 0.62, H * 0.85];
    for (const vx of mainV) roads.push({ pts: [{ x: vx, y: 0 }, { x: vx, y: H }], width: 46 });
    for (const hy of mainH) roads.push({ pts: [{ x: 0, y: hy }, { x: W, y: hy }], width: 46 });
    // quelques rues secondaires
    for (let i = 0; i < 10; i++) {
      const horiz = rng() < 0.5;
      const p = 150 + rng() * (W - 300);
      const a = 150 + rng() * (W - 600);
      const b = a + 250 + rng() * 500;
      roads.push(
        horiz
          ? { pts: [{ x: a, y: p }, { x: Math.min(b, W), y: p }], width: 26 }
          : { pts: [{ x: p, y: a }, { x: p, y: Math.min(b, H) }], width: 26 }
      );
    }

    // ----- Maisons : un village dense + maisons éparses -----
    const houses = [];
    function addHouse(x, y, sz) {
      houses.push({
        x, y, w: sz, h: sz * (0.8 + rng() * 0.5),
        roof: pick(rng, ROOF_PALETTE),
        rot: rng() < 0.5 ? 0 : (rng() - 0.5) * 0.5,
      });
    }
    // village (cluster)
    const vcx = W * 0.5, vcy = H * 0.5;
    for (let i = 0; i < 60; i++) {
      const a = rng() * Math.PI * 2;
      const d = rng() * 520;
      addHouse(vcx + Math.cos(a) * d, vcy + Math.sin(a) * d, 36 + rng() * 34);
    }
    // hameaux éparses
    for (let i = 0; i < 70; i++) {
      addHouse(120 + rng() * (W - 240), 120 + rng() * (H - 240), 30 + rng() * 30);
    }

    // ----- Arbres -----
    const trees = [];
    for (let i = 0; i < 420; i++) {
      trees.push({
        x: 60 + rng() * (W - 120),
        y: 60 + rng() * (H - 120),
        r: 12 + rng() * 16,
        tone: rng() < 0.5 ? "#3f7d3a" : "#357032",
      });
    }

    // ----- Voitures animées (le côté "vivant") -----
    const cars = [];
    const driveRoads = roads.filter((r) => r.width >= 26);
    for (let i = 0; i < 26; i++) {
      const road = driveRoads[Math.floor(rng() * driveRoads.length)];
      cars.push({
        road,
        t: rng(),
        speed: (0.02 + rng() * 0.04) * (rng() < 0.5 ? 1 : -1),
        color: pick(rng, CAR_COLORS),
        lane: rng() < 0.5 ? -1 : 1,
      });
    }

    return { W, H, cell, fields, lakes, river, roads, houses, trees, cars,
             waterColor: "#5fa8d6", roadColor: "#9a9a9a" };
  }

  // ---- Requête analytique de couleur (pour la pipette) ----
  function pointInRect(px, py, x, y, w, h) {
    return px >= x && px <= x + w && py >= y && py <= y + h;
  }
  function distToSeg(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((px - a.x) * dx + (py - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function mapColorAt(map, x, y) {
    // Du dessus vers le dessous : arbres > maisons > routes > eau > champs.
    for (const t of map.trees) {
      if (Math.hypot(x - t.x, y - t.y) <= t.r) return t.tone;
    }
    for (const h of map.houses) {
      if (pointInRect(x, y, h.x - h.w / 2, h.y - h.h / 2, h.w, h.h)) return h.roof;
    }
    for (const rd of map.roads) {
      for (let i = 0; i < rd.pts.length - 1; i++) {
        if (distToSeg(x, y, rd.pts[i], rd.pts[i + 1]) <= rd.width / 2) return map.roadColor;
      }
    }
    for (const l of map.lakes) {
      const dx = (x - l.x) / l.rx, dy = (y - l.y) / l.ry;
      if (dx * dx + dy * dy <= 1) return map.waterColor;
    }
    for (let i = 0; i < map.river.length - 1; i++) {
      if (distToSeg(x, y, map.river[i], map.river[i + 1]) <= 55) return map.waterColor;
    }
    // champ
    const c = Math.floor(x / map.cell), r = Math.floor(y / map.cell);
    const cols = Math.ceil(map.W / map.cell);
    const f = map.fields[r * cols + c];
    return f ? f.color : "#9bc56a";
  }

  // ---- Rendu (en coordonnées MONDE ; la transform caméra est déjà posée) ----
  function drawMap(ctx, map, view, timeMs) {
    const { x0, y0, x1, y1 } = view; // bornes monde visibles
    const vis = (bx, by, bw, bh) => bx <= x1 && bx + bw >= x0 && by <= y1 && by + bh >= y0;

    // Champs
    for (const f of map.fields) {
      if (!vis(f.x, f.y, f.w, f.h)) continue;
      ctx.fillStyle = f.color;
      ctx.fillRect(f.x, f.y, f.w, f.h);
      if (f.rows) {
        ctx.strokeStyle = "rgba(0,0,0,0.06)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (f.rowAngle === 0) {
          for (let yy = f.y + 12; yy < f.y + f.h; yy += 16) { ctx.moveTo(f.x, yy); ctx.lineTo(f.x + f.w, yy); }
        } else {
          for (let xx = f.x + 12; xx < f.x + f.w; xx += 16) { ctx.moveTo(xx, f.y); ctx.lineTo(xx, f.y + f.h); }
        }
        ctx.stroke();
      }
    }

    // Bords de cellules (clôtures discrètes)
    ctx.strokeStyle = "rgba(80,110,60,0.25)";
    ctx.lineWidth = 1.5;
    for (const f of map.fields) {
      if (!vis(f.x, f.y, f.w, f.h)) continue;
      ctx.strokeRect(f.x, f.y, f.w, f.h);
    }

    // Rivière (avec culling vertical : on saute si sa bande n'est pas visible)
    let rMinY = Infinity, rMaxY = -Infinity;
    for (const p of map.river) { if (p.y < rMinY) rMinY = p.y; if (p.y > rMaxY) rMaxY = p.y; }
    const shimmer = 0.5 + 0.5 * Math.sin(timeMs / 600);
    if (vis(-60, rMinY - 60, map.W + 120, rMaxY - rMinY + 120)) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = map.waterColor;
      ctx.lineWidth = 110;
      ctx.beginPath();
      ctx.moveTo(map.river[0].x, map.river[0].y);
      for (const p of map.river) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255," + (0.12 + 0.10 * shimmer) + ")";
      ctx.lineWidth = 30;
      ctx.stroke();
    }

    // Lacs
    for (const l of map.lakes) {
      if (!vis(l.x - l.rx, l.y - l.ry, l.rx * 2, l.ry * 2)) continue;
      ctx.fillStyle = map.waterColor;
      ctx.beginPath();
      ctx.ellipse(l.x, l.y, l.rx, l.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255," + (0.10 + 0.08 * shimmer) + ")";
      ctx.beginPath();
      ctx.ellipse(l.x - l.rx * 0.2, l.y - l.ry * 0.2, l.rx * 0.5, l.ry * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Routes (asphalte + liseré + bande centrale)
    for (const rd of map.roads) {
      const a = rd.pts[0], b = rd.pts[rd.pts.length - 1];
      if (!vis(Math.min(a.x, b.x) - rd.width, Math.min(a.y, b.y) - rd.width,
               Math.abs(b.x - a.x) + rd.width * 2, Math.abs(b.y - a.y) + rd.width * 2)) continue;
      ctx.strokeStyle = "#6f6f6f";
      ctx.lineWidth = rd.width + 6;
      strokePts(ctx, rd.pts);
      ctx.strokeStyle = map.roadColor;
      ctx.lineWidth = rd.width;
      strokePts(ctx, rd.pts);
      if (rd.width >= 40) {
        ctx.strokeStyle = "#f4e04d";
        ctx.lineWidth = 3;
        ctx.setLineDash([22, 20]);
        strokePts(ctx, rd.pts);
        ctx.setLineDash([]);
      }
    }

    // Maisons (ombre + murs + toit)
    for (const h of map.houses) {
      if (!vis(h.x - h.w, h.y - h.h, h.w * 2, h.h * 2)) continue;
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(h.rot);
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(-h.w / 2 + 4, -h.h / 2 + 5, h.w, h.h);
      ctx.fillStyle = "#efe7d8";
      ctx.fillRect(-h.w / 2, -h.h / 2, h.w, h.h);
      ctx.fillStyle = h.roof;
      ctx.fillRect(-h.w / 2, -h.h / 2, h.w, h.h * 0.55);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-h.w / 2, -h.h / 2, h.w, h.h);
      ctx.beginPath();
      ctx.moveTo(-h.w / 2, -h.h / 2 + h.h * 0.55);
      ctx.lineTo(h.w / 2, -h.h / 2 + h.h * 0.55);
      ctx.stroke();
      ctx.restore();
    }

    // Voitures (animées)
    for (const car of map.cars) {
      const pts = car.road.pts;
      const a = pts[0], b = pts[pts.length - 1];
      let t = (car.t + (timeMs / 1000) * car.speed) % 1;
      if (t < 0) t += 1;
      const horiz = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      const off = car.lane * (car.road.width * 0.22);
      const px = horiz ? cx : cx + off;
      const py = horiz ? cy + off : cy;
      if (!vis(px - 20, py - 20, 40, 40)) continue;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(horiz ? 0 : Math.PI / 2);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(-13, -7, 26, 14);
      ctx.fillStyle = car.color;
      ctx.fillRect(-14, -8, 28, 16);
      ctx.fillStyle = "rgba(180,220,255,0.85)";
      ctx.fillRect(-6, -6, 11, 12);
      ctx.restore();
    }

    // Arbres (couronne + ombre)
    for (const t of map.trees) {
      if (!vis(t.x - t.r, t.y - t.r, t.r * 2, t.r * 2)) continue;
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.beginPath();
      ctx.ellipse(t.x + 3, t.y + 4, t.r, t.r * 0.92, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = t.tone;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function strokePts(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  window.MCMap = { generateMap, drawMap, mapColorAt };
})();
