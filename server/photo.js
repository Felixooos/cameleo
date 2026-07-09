/*
 * Mode "Cache-cache photo, tour par tour" - logique serveur autoritaire.
 *
 * Anti-triche par construction :
 *  - la position du cacheur ne quitte JAMAIS le serveur avant la fin du tour
 *    (seul event porteur de position : photo:turnEnd, après résolution) ;
 *  - l'empreinte est CUITE dans l'image servie aux chercheurs (compositing
 *    @napi-rs/canvas via le module partagé shared/imprint.js), le client ne
 *    reçoit qu'un WebP ;
 *  - le clic est validé côté serveur (hitTest sur le masque silhouette).
 */
const path = require("path");
const crypto = require("crypto");
const C = require("../shared/constants");
const Imprint = require("../shared/imprint");
const MANIFEST = require("../shared/scenes/manifest.json");

const { createCanvas, loadImage } = require("@napi-rs/canvas");
Imprint.init((w, h) => createCanvas(w, h));

const W = C.PHOTO_SCENE_W, H = C.PHOTO_SCENE_H;

/** Images de scènes décodées (cache), clé = sceneId. */
const sceneImages = new Map();
async function getSceneImage(sceneId) {
  if (sceneImages.has(sceneId)) return sceneImages.get(sceneId);
  const meta = MANIFEST.scenes.find((s) => s.id === sceneId);
  if (!meta) throw new Error("scène inconnue : " + sceneId);
  const img = await loadImage(path.join(__dirname, "..", "public", meta.file));
  sceneImages.set(sceneId, img);
  return img;
}

/** Composites servis par token (mémoire, no-store). token -> Buffer webp */
const served = new Map();
function newToken(buf) {
  const t = crypto.randomBytes(12).toString("hex");
  served.set(t, buf);
  return t;
}
function dropToken(t) { served.delete(t); }
function getServed(t) { return served.get(t) || null; }

function now() { return Date.now(); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function charSizePx(cfg) { return C.PHOTO_CHAR_SCALE[cfg.difficulty] * H; }

function clampPlacement(cfg, x, y) {
  const sz = charSizePx(cfg);
  const hx = sz / 2 / W, hy = sz / 2 / H;
  return {
    x: clamp(x, 0.03 + hx, 0.97 - hx),
    y: clamp(y, 0.03 + hy, 0.97 - hy),
  };
}

function defaultConfig() {
  return {
    hideMs: C.PHOTO_HIDE_MS,
    turnMs: C.PHOTO_TURN_MS,
    revealMs: C.PHOTO_REVEAL_MS,
    lockMs: C.PHOTO_LOCK_MS,
    maxMisses: C.PHOTO_MAX_MISSES,
    difficulty: "normal", // easy | normal | hard
    sceneAssign: "perPlayer", // perPlayer | shared
  };
}

function publicConfig(room) {
  return room.photo ? { ...room.photo.cfg } : defaultConfig();
}

function setConfig(room, patch) {
  if (!room.photoCfg) room.photoCfg = defaultConfig();
  const cfg = room.photoCfg;
  if (patch.difficulty && ["easy", "normal", "hard"].includes(patch.difficulty))
    cfg.difficulty = patch.difficulty;
  if (patch.sceneAssign && ["perPlayer", "shared"].includes(patch.sceneAssign))
    cfg.sceneAssign = patch.sceneAssign;
  if (typeof patch.hideMs === "number") cfg.hideMs = clamp(patch.hideMs, 20000, 180000);
  if (typeof patch.turnMs === "number") cfg.turnMs = clamp(patch.turnMs, 15000, 120000);
  return cfg;
}

// ---------------------------------------------------------------------------
// Démarrage : phase cachette
// ---------------------------------------------------------------------------
function startHide(room, io) {
  const players = [...room.players.values()];
  if (room.phase !== C.PHASE_LOBBY) return { ok: false, error: "déjà en partie" };
  if (players.length < C.PHOTO_MIN_PLAYERS)
    return { ok: false, error: "Il faut au moins " + C.PHOTO_MIN_PLAYERS + " joueurs." };
  if (players.length > C.PHOTO_MAX_PLAYERS)
    return { ok: false, error: "Maximum " + C.PHOTO_MAX_PLAYERS + " joueurs." };

  const cfg = { ...(room.photoCfg || defaultConfig()) };
  // Attribution des scènes
  const pool = MANIFEST.scenes.map((s) => s.id);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const scenes = new Map();
  players.forEach((p, i) => {
    scenes.set(p.id, cfg.sceneAssign === "shared" ? shuffled[0] : shuffled[i % shuffled.length]);
  });

  // Ordre de passage aléatoire
  const order = players.map((p) => p.id).sort(() => Math.random() - 0.5);

  room.photo = {
    cfg,
    scenes,
    placements: new Map(), // id -> {x,y,flip,confirmed}
    order,
    turnIndex: -1,
    turn: null,
    composites: new Map(), // id -> Buffer webp
    results: [],
    scores: new Map(players.map((p) => [p.id, 0])),
  };
  room.phase = C.PHASE_PHOTO_HIDE;
  room.phaseEndsAt = now() + cfg.hideMs;

  io.to(room.id).emit("phase", { phase: room.phase, endsAt: room.phaseEndsAt, mode: C.MODE_PHOTO });

  // Envoi individuel : chaque joueur reçoit SA scène.
  for (const p of players) {
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) continue;
    const sceneId = scenes.get(p.id);
    const meta = MANIFEST.scenes.find((s) => s.id === sceneId);
    socket.emit("photo:hideStart", {
      endsAt: room.phaseEndsAt,
      scene: { id: sceneId, url: meta.file, w: W, h: H },
      charScale: C.PHOTO_CHAR_SCALE[cfg.difficulty],
      difficulty: cfg.difficulty,
      hideMs: cfg.hideMs,
      turnMs: cfg.turnMs,
      maxMisses: cfg.maxMisses,
    });
  }

  clearTimeout(room.photoTimer);
  room.photoTimer = setTimeout(() => endHide(room, io), cfg.hideMs);
  return { ok: true };
}

function place(room, id, { x, y, flip } = {}) {
  if (!room.photo || room.phase !== C.PHASE_PHOTO_HIDE) return { ok: false };
  if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y))
    return { ok: false };
  const cl = clampPlacement(room.photo.cfg, x, y);
  room.photo.placements.set(id, { x: cl.x, y: cl.y, flip: !!flip, confirmed: false });
  return { ok: true, x: cl.x, y: cl.y };
}

function confirm(room, id, io) {
  if (!room.photo || room.phase !== C.PHASE_PHOTO_HIDE) return { ok: false };
  const pl = room.photo.placements.get(id);
  if (!pl) return { ok: false, error: "place-toi d'abord" };
  pl.confirmed = true;
  const total = room.photo.order.length;
  const confirmed = [...room.photo.placements.values()].filter((p) => p.confirmed).length;
  io.to(room.id).emit("photo:hideProgress", { confirmed, total });
  // Fin anticipée si tout le monde a confirmé.
  if (confirmed >= total) {
    clearTimeout(room.photoTimer);
    endHide(room, io);
  }
  return { ok: true };
}

async function endHide(room, io) {
  if (!room.photo || room.phase !== C.PHASE_PHOTO_HIDE) return;
  const ph = room.photo;

  // Placement aléatoire pour les retardataires.
  for (const id of ph.order) {
    if (!ph.placements.has(id)) {
      const cl = clampPlacement(ph.cfg, 0.1 + Math.random() * 0.8, 0.25 + Math.random() * 0.65);
      ph.placements.set(id, { x: cl.x, y: cl.y, flip: Math.random() < 0.5, confirmed: false });
    }
  }

  // Pré-composition de tous les tours (vérité anti-triche).
  const sz = charSizePx(ph.cfg);
  const preset = ph.cfg.difficulty === "normal" ? "normal" : ph.cfg.difficulty;
  for (const id of ph.order) {
    const img = await getSceneImage(ph.scenes.get(id));
    const pl = ph.placements.get(id);
    const c = createCanvas(W, H);
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0, W, H);
    Imprint.draw(x, pl.x * W, pl.y * H, sz, preset, pl.flip);
    ph.composites.set(id, c.toBuffer("image/webp", 82));
  }

  nextTurn(room, io);
}

// ---------------------------------------------------------------------------
// Tours de recherche
// ---------------------------------------------------------------------------
function nextTurn(room, io) {
  const ph = room.photo;
  if (!ph) return;
  ph.turnIndex++;

  // Saute les cacheurs partis.
  while (ph.turnIndex < ph.order.length && !room.players.has(ph.order[ph.turnIndex])) {
    ph.turnIndex++;
  }
  if (ph.turnIndex >= ph.order.length) return endPhoto(room, io, "photo_complete");

  const hiderId = ph.order[ph.turnIndex];
  const token = newToken(ph.composites.get(hiderId));
  const seekers = new Map();
  for (const p of room.players.values()) {
    if (p.id !== hiderId) seekers.set(p.id, { misses: 0, lockedUntil: 0, exhausted: false });
  }

  room.phase = C.PHASE_PHOTO_TURN;
  room.phaseEndsAt = now() + ph.cfg.turnMs;
  ph.turn = {
    hiderId, token, seekers,
    startedAt: now(), endsAt: room.phaseEndsAt,
    resolved: false,
  };

  io.to(room.id).emit("phase", { phase: room.phase, endsAt: room.phaseEndsAt, mode: C.MODE_PHOTO });

  const hider = room.players.get(hiderId);
  const orderView = ph.order
    .filter((id) => room.players.has(id))
    .map((id, i) => ({ id, name: room.players.get(id).name, played: i < ph.turnIndex, current: id === hiderId }));

  for (const p of room.players.values()) {
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) continue;
    const isHider = p.id === hiderId;
    const payload = {
      turnIndex: ph.turnIndex,
      turnCount: ph.order.filter((id) => room.players.has(id)).length,
      hider: { id: hiderId, name: hider.name },
      imageUrl: "/photo/img/" + token,
      w: W, h: H,
      endsAt: ph.turn.endsAt,
      youAre: isHider ? "hider" : "seeker",
      maxMisses: ph.cfg.maxMisses,
      lockMs: ph.cfg.lockMs,
      order: orderView,
      scores: scoresView(room),
    };
    if (isHider) {
      const pl = ph.placements.get(hiderId);
      payload.selfPlacement = { x: pl.x, y: pl.y, flip: pl.flip }; // au cacheur SEUL
    }
    socket.emit("photo:turnStart", payload);
  }

  clearTimeout(room.photoTimer);
  room.photoTimer = setTimeout(() => resolveTurn(room, io, "timeout", null), ph.cfg.turnMs);
}

function click(room, id, { x, y } = {}, io) {
  const ph = room.photo;
  if (!ph || room.phase !== C.PHASE_PHOTO_TURN || !ph.turn || ph.turn.resolved)
    return { verdict: "out_of_phase" };
  if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y))
    return { verdict: "out_of_phase" };
  const t = ph.turn;
  if (id === t.hiderId) return { verdict: "not_seeker" };
  const sk = t.seekers.get(id);
  if (!sk) return { verdict: "not_seeker" };
  if (sk.exhausted) return { verdict: "exhausted" };
  const tNow = now();
  if (tNow < sk.lockedUntil) return { verdict: "locked", lockedUntil: sk.lockedUntil };

  const pl = ph.placements.get(t.hiderId);
  const sz = charSizePx(ph.cfg);
  const tol = C.PHOTO_TOLERANCE_PX[ph.cfg.difficulty];
  const hit = Imprint.hitTest(x * W, y * H, pl.x * W, pl.y * H, sz, pl.flip, tol);

  if (hit) {
    resolveTurn(room, io, "found", id);
    return { verdict: "hit" };
  }

  sk.misses++;
  sk.lockedUntil = tNow + ph.cfg.lockMs;
  if (sk.misses >= ph.cfg.maxMisses) sk.exhausted = true;
  const player = room.players.get(id);
  io.to(room.id).emit("photo:miss", {
    by: id, name: player ? player.name : "?",
    x, y,
    missesLeft: Math.max(0, ph.cfg.maxMisses - sk.misses),
    exhausted: sk.exhausted,
  });

  // Tous les chercheurs épuisés -> le cacheur gagne le tour immédiatement.
  const allOut = [...t.seekers.values()].every((s) => s.exhausted);
  if (allOut) {
    resolveTurn(room, io, "all_exhausted", null);
    return { verdict: sk.exhausted ? "exhausted" : "miss", missesLeft: 0 };
  }

  return {
    verdict: sk.exhausted ? "exhausted" : "miss",
    lockedUntil: sk.lockedUntil,
    missesLeft: Math.max(0, ph.cfg.maxMisses - sk.misses),
  };
}

function resolveTurn(room, io, outcome, foundBy) {
  const ph = room.photo;
  if (!ph || !ph.turn || ph.turn.resolved) return;
  const t = ph.turn;
  t.resolved = true;
  clearTimeout(room.photoTimer);
  dropToken(t.token);

  const hiderId = t.hiderId;
  const pl = ph.placements.get(hiderId);
  const elapsed = now() - t.startedAt;
  const points = {};
  const add = (id, pts) => {
    if (!ph.scores.has(id)) ph.scores.set(id, 0);
    ph.scores.set(id, ph.scores.get(id) + pts);
    points[id] = (points[id] || 0) + pts;
  };

  const totalMisses = [...t.seekers.values()].reduce((a, s) => a + s.misses, 0);
  const missBonus = Math.min(C.SCORE_PHOTO_MISS_CAP, totalMisses * C.SCORE_PHOTO_PER_MISS);

  let findTimeMs = null;
  if (outcome === "found" && foundBy) {
    findTimeMs = elapsed;
    const remain = Math.max(0, t.endsAt - now());
    add(foundBy, C.SCORE_PHOTO_FIND + Math.round(C.SCORE_PHOTO_SPEED_MAX * (remain / ph.cfg.turnMs)));
    if (room.players.has(hiderId)) {
      add(hiderId, Math.round(C.SCORE_PHOTO_TENURE_MAX * (elapsed / ph.cfg.turnMs)) + missBonus);
    }
  } else if (outcome === "timeout" || outcome === "all_exhausted") {
    if (room.players.has(hiderId)) add(hiderId, C.SCORE_PHOTO_SURVIVE + missBonus);
  }
  // hider_left : personne ne marque.

  ph.results.push({ hiderId, outcome, foundBy: foundBy || null, findTimeMs, misses: totalMisses });

  // Prochain cacheur encore présent ?
  let nextHider = null;
  for (let i = ph.turnIndex + 1; i < ph.order.length; i++) {
    if (room.players.has(ph.order[i])) {
      const p = room.players.get(ph.order[i]);
      nextHider = { id: p.id, name: p.name };
      break;
    }
  }

  room.phase = C.PHASE_PHOTO_REVEAL;
  room.phaseEndsAt = now() + ph.cfg.revealMs;
  io.to(room.id).emit("phase", { phase: room.phase, endsAt: room.phaseEndsAt, mode: C.MODE_PHOTO });

  const hider = room.players.get(hiderId);
  io.to(room.id).emit("photo:turnEnd", {
    turnIndex: ph.turnIndex,
    outcome,
    hider: { id: hiderId, name: hider ? hider.name : "(parti)" },
    foundBy: foundBy ? { id: foundBy, name: (room.players.get(foundBy) || {}).name } : null,
    findTimeMs,
    pos: { x: pl.x, y: pl.y, flip: pl.flip }, // SEULE émission de la position
    points,
    scores: scoresView(room),
    nextHider,
    nextAt: room.phaseEndsAt,
  });

  room.photoTimer = setTimeout(() => nextTurn(room, io), ph.cfg.revealMs);
}

function scoresView(room) {
  const ph = room.photo;
  return [...ph.scores.entries()]
    .filter(([id]) => room.players.has(id))
    .map(([id, score]) => ({ id, name: room.players.get(id).name, score }))
    .sort((a, b) => b.score - a.score);
}

function endPhoto(room, io, reason) {
  const ph = room.photo;
  if (!ph) return;
  clearTimeout(room.photoTimer);
  room.phase = C.PHASE_ENDED;
  const ranking = scoresView(room).map((s) => ({ ...s, role: "hider", alive: true }));
  io.to(room.id).emit("photo:gameEnd", {
    reason,
    ranking,
    results: ph.results,
  });
  // token cleanup
  for (const id of ph.composites.keys()) ph.composites.delete(id);
}

// ---------------------------------------------------------------------------
// Départs en cours de partie
// ---------------------------------------------------------------------------
function onLeave(room, id, io) {
  const ph = room.photo;
  if (!ph) return;
  if (room.phase === C.PHASE_PHOTO_HIDE) {
    ph.placements.delete(id);
    ph.order = ph.order.filter((x) => x !== id);
    ph.scores.delete(id);
    if (ph.order.length < C.PHOTO_MIN_PLAYERS) {
      clearTimeout(room.photoTimer);
      endPhoto(room, io, "not_enough_players");
    }
    return;
  }
  if (room.phase === C.PHASE_PHOTO_TURN && ph.turn && !ph.turn.resolved) {
    if (id === ph.turn.hiderId) {
      resolveTurn(room, io, "hider_left", null); // tour avorté
    } else {
      ph.turn.seekers.delete(id);
      const left = [...ph.turn.seekers.values()];
      if (left.length === 0) resolveTurn(room, io, "timeout", null);
      else if (left.every((s) => s.exhausted)) resolveTurn(room, io, "all_exhausted", null);
    }
  }
  const remaining = [...room.players.keys()].filter((x) => x !== id);
  if (remaining.length < C.PHOTO_MIN_PLAYERS &&
      room.phase !== C.PHASE_ENDED && room.phase !== C.PHASE_LOBBY) {
    clearTimeout(room.photoTimer);
    endPhoto(room, io, "not_enough_players");
  }
}

function cleanup(room) {
  clearTimeout(room.photoTimer);
  if (room.photo) {
    if (room.photo.turn) dropToken(room.photo.turn.token);
    room.photo = null;
  }
}

module.exports = {
  startHide, place, confirm, click, onLeave, cleanup,
  setConfig, publicConfig, defaultConfig, getServed,
};
