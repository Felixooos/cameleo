/*
 * Mecha Cameleo - serveur autoritatif.
 * Express sert les fichiers statiques, Socket.IO gère les rooms et la logique de jeu.
 * Le serveur est la SEULE source de vérité : phases, tir, score, infection, fin de partie.
 */
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const C = require("./shared/constants");
const Photo = require("./server/photo");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use("/shared", express.static(path.join(__dirname, "shared")));
app.use(express.static(path.join(__dirname, "public")));

// Composite du tour courant (mode photo) : WebP en mémoire, jeton à usage
// temporaire, jamais mis en cache (anti-triche).
app.get("/photo/img/:token", (req, res) => {
  const buf = Photo.getServed(req.params.token);
  if (!buf) return res.status(404).end();
  res.set("Content-Type", "image/webp");
  res.set("Cache-Control", "no-store");
  res.send(buf);
});

const PORT = process.env.PORT || 4000; // 3000 souvent pris (projet MMAD) -> 4000 par défaut

/** @type {Map<string, Room>} */
const rooms = new Map();

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
function genRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // pas de I/O/0/1 ambigus
  let id;
  do {
    id = "";
    for (let i = 0; i < 4; i++) {
      id += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(id));
  return id;
}

function now() {
  return Date.now();
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function makePlayer(id, name) {
  return {
    id,
    name: (name || "Joueur").slice(0, 16),
    role: C.ROLE_HIDER,
    originalRole: C.ROLE_HIDER, // rôle choisi au lobby (restauré entre les manches)
    ready: false,
    x: C.WORLD_W / 2,
    y: C.WORLD_H / 2,
    rot: 0,
    rotLocked: false,
    color: "#7fae5a",
    finish: "matte", // matte | glossy
    sprite: null, // dataURL du bonhomme peint
    painted: false,
    alive: true,
    isHunter: false,
    score: 0,
    lastShotAt: 0,
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    x: Math.round(p.x),
    y: Math.round(p.y),
    rot: +p.rot.toFixed(3),
    alive: p.alive,
    isHunter: p.isHunter,
    color: p.color,
    finish: p.finish,
    score: p.score,
    hasSprite: !!p.sprite,
  };
}

function lobbyView(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    mode: room.mode,
    phase: room.phase,
    photoConfig: room.photoCfg || Photo.defaultConfig(),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      ready: p.ready,
      isHost: p.id === room.hostId,
    })),
  };
}

function emitLobby(room) {
  io.to(room.id).emit("lobby", lobbyView(room));
}

function countAliveHiders(room) {
  let n = 0;
  for (const p of room.players.values()) {
    if (p.role === C.ROLE_HIDER && p.alive) n++;
  }
  return n;
}

function countHunters(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.role === C.ROLE_HUNTER) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Cycle de vie d'une partie
// ---------------------------------------------------------------------------
function startGame(room) {
  if (room.phase !== C.PHASE_LOBBY) return;
  if (countHunters(room) < 1 || countAliveHiders(room) < 1) return;

  // Place les cacheurs aléatoirement (espacés des bords).
  const margin = 250;
  for (const p of room.players.values()) {
    p.score = 0;
    p.alive = true;
    p.painted = false;
    p.sprite = null;
    p.rotLocked = false;
    p.lastShotAt = 0;
    p.isHunter = p.role === C.ROLE_HUNTER;
    if (p.role === C.ROLE_HIDER) {
      p.x = margin + Math.random() * (C.WORLD_W - 2 * margin);
      p.y = margin + Math.random() * (C.WORLD_H - 2 * margin);
    } else {
      // chasseur : en attente, position centrale (révélée à la chasse)
      p.x = C.WORLD_W / 2;
      p.y = C.WORLD_H / 2;
    }
  }

  room.phase = C.PHASE_PREP;
  room.phaseEndsAt = now() + C.PREP_TIME_MS;
  io.to(room.id).emit("phase", {
    phase: room.phase,
    endsAt: room.phaseEndsAt,
    mode: room.mode,
  });

  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(() => beginHunt(room), C.PREP_TIME_MS);

  startLoop(room);
}

function beginHunt(room) {
  if (room.phase !== C.PHASE_PREP) return;
  room.phase = C.PHASE_HUNT;
  room.phaseEndsAt = now() + C.HUNT_TIME_MS;
  room.lastScoreAt = now();

  // (Re)place les chasseurs au centre, prêts à chasser.
  for (const p of room.players.values()) {
    if (p.role === C.ROLE_HUNTER) {
      p.x = C.WORLD_W / 2;
      p.y = C.WORLD_H / 2;
    }
  }

  io.to(room.id).emit("phase", {
    phase: room.phase,
    endsAt: room.phaseEndsAt,
    mode: room.mode,
  });

  clearTimeout(room.phaseTimer);
  room.phaseTimer = setTimeout(() => endGame(room, "timeout"), C.HUNT_TIME_MS);
}

function endGame(room, reason) {
  if (room.phase === C.PHASE_ENDED) return;
  room.phase = C.PHASE_ENDED;
  clearTimeout(room.phaseTimer);
  stopLoop(room);

  const survivors = [...room.players.values()].filter(
    (p) => p.role === C.ROLE_HIDER && p.alive
  );
  const ranking = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score, role: p.role, alive: p.alive }))
    .sort((a, b) => b.score - a.score);

  let outcome;
  if (room.mode === C.MODE_INFECTED) {
    outcome = survivors.length > 0 ? "hiders_survived" : "all_infected";
  } else {
    outcome = survivors.length > 0 ? "hiders_survived" : "hunter_wins";
  }

  io.to(room.id).emit("ended", {
    reason,
    outcome,
    survivors: survivors.map((p) => p.id),
    ranking,
  });
}

function resetToLobby(room) {
  stopLoop(room);
  clearTimeout(room.phaseTimer);
  Photo.cleanup(room); // purge l'état photo (timers, tokens, composites)
  room.phase = C.PHASE_LOBBY;
  for (const p of room.players.values()) {
    p.ready = false;
    p.alive = true;
    p.score = 0;
    p.painted = false;
    p.sprite = null;
    p.role = p.originalRole; // restaure le rôle (annule l'infection de la manche)
    p.isHunter = p.role === C.ROLE_HUNTER;
  }
  emitLobby(room);
}

// ---------------------------------------------------------------------------
// Boucle temps réel : broadcast d'état filtré + scoring
// ---------------------------------------------------------------------------
function startLoop(room) {
  stopLoop(room);
  const interval = Math.round(1000 / C.TICK_RATE);
  room.loop = setInterval(() => tick(room), interval);
}

function stopLoop(room) {
  if (room.loop) {
    clearInterval(room.loop);
    room.loop = null;
  }
}

function tick(room) {
  // Scoring pendant la chasse, toutes les SCORE_INTERVAL_MS.
  if (room.phase === C.PHASE_HUNT && now() - room.lastScoreAt >= C.SCORE_INTERVAL_MS) {
    room.lastScoreAt = now();
    applyScoring(room);
  }

  const all = [...room.players.values()];
  const hunters = all.filter((p) => p.role === C.ROLE_HUNTER);

  for (const [sid, p] of room.players) {
    const socket = io.sockets.sockets.get(sid);
    if (!socket) continue;

    let others;
    if (room.phase === C.PHASE_PREP) {
      // Personne ne voit personne d'autre pendant la préparation.
      others = [];
    } else if (room.phase === C.PHASE_HUNT || room.phase === C.PHASE_ENDED) {
      others = all.filter((o) => o.id !== p.id).map(publicPlayer);
    } else {
      others = [];
    }

    socket.emit("state", {
      t: now(),
      phase: room.phase,
      endsAt: room.phaseEndsAt,
      self: publicPlayer(p),
      others,
      hunterCount: hunters.length,
      aliveHiders: countAliveHiders(room),
    });
  }
}

function applyScoring(room) {
  const hunters = [...room.players.values()].filter((p) => p.role === C.ROLE_HUNTER);
  for (const p of room.players.values()) {
    if (p.role !== C.ROLE_HIDER || !p.alive) continue;
    let best = Infinity;
    for (const h of hunters) {
      const d = Math.hypot(p.x - h.x, p.y - h.y);
      if (d < best) best = d;
    }
    let pts = C.SCORE_SURVIVE_BONUS;
    if (best < C.SCORE_MAX_DIST) {
      pts += Math.round(C.SCORE_MAX_POINTS * (1 - best / C.SCORE_MAX_DIST));
    }
    p.score += pts;
  }
  io.to(room.id).emit("scores", {
    scores: [...room.players.values()].map((p) => ({ id: p.id, score: p.score })),
  });
}

// ---------------------------------------------------------------------------
// Tir du chasseur
// ---------------------------------------------------------------------------
function handleShoot(room, shooter, aim) {
  if (room.phase !== C.PHASE_HUNT) return;
  if (shooter.role !== C.ROLE_HUNTER) return;
  const t = now();
  if (t - shooter.lastShotAt < C.SHOOT_COOLDOWN_MS) return; // recharge
  shooter.lastShotAt = t;

  const cone = (C.SHOOT_CONE_DEG * Math.PI) / 180;
  let target = null;
  let bestDist = Infinity;

  for (const p of room.players.values()) {
    if (p.id === shooter.id) continue;
    if (p.role !== C.ROLE_HIDER || !p.alive) continue;
    const dx = p.x - shooter.x;
    const dy = p.y - shooter.y;
    const dist = Math.hypot(dx, dy);
    if (dist > C.SHOOT_RANGE) continue;
    const ang = Math.atan2(dy, dx);
    let diff = Math.abs(ang - aim);
    diff = Math.atan2(Math.sin(ang - aim), Math.cos(ang - aim)); // diff signé [-pi,pi]
    if (Math.abs(diff) > cone) continue;
    if (dist < bestDist) {
      bestDist = dist;
      target = p;
    }
  }

  // Notifie le tir à tout le monde (visuel : flash / ligne).
  io.to(room.id).emit("shot", {
    by: shooter.id,
    x: Math.round(shooter.x),
    y: Math.round(shooter.y),
    aim: +aim.toFixed(3),
    range: C.SHOOT_RANGE,
    hit: target ? target.id : null,
  });

  if (!target) return;

  // Élimination.
  target.alive = false;
  let infected = false;
  if (room.mode === C.MODE_INFECTED) {
    // Le mort devient chasseur, à sa position actuelle.
    target.role = C.ROLE_HUNTER;
    target.isHunter = true;
    target.alive = true;
    target.lastShotAt = 0;
    infected = true;
  }

  io.to(room.id).emit("eliminated", {
    id: target.id,
    by: shooter.id,
    infected,
  });

  if (countAliveHiders(room) === 0) {
    endGame(room, "all_hiders_down");
  }
}

// ---------------------------------------------------------------------------
// Connexions Socket.IO
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
  let roomId = null;

  function currentRoom() {
    return roomId ? rooms.get(roomId) : null;
  }

  function leaveRoom() {
    const room = currentRoom();
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(room.id);

    if (room.players.size === 0) {
      stopLoop(room);
      clearTimeout(room.phaseTimer);
      Photo.cleanup(room);
      rooms.delete(room.id);
    } else {
      if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value; // nouveau host
      }
      if (room.mode === C.MODE_PHOTO) {
        Photo.onLeave(room, socket.id, io);
      } else if (
        // Si la partie est en cours et qu'il n'y a plus de chasseur ou de cacheur, on termine.
        (room.phase === C.PHASE_PREP || room.phase === C.PHASE_HUNT) &&
        (countHunters(room) === 0 || countAliveHiders(room) === 0)
      ) {
        endGame(room, "player_left");
      }
      emitLobby(room);
    }
    roomId = null;
  }

  socket.on("createGame", ({ name, mode } = {}, cb) => {
    leaveRoom();
    const id = genRoomId();
    const room = {
      id,
      hostId: socket.id,
      mode: mode === C.MODE_INFECTED ? C.MODE_INFECTED
          : mode === C.MODE_PHOTO ? C.MODE_PHOTO : C.MODE_NORMAL,
      phase: C.PHASE_LOBBY,
      players: new Map(),
      phaseEndsAt: 0,
      lastScoreAt: 0,
      loop: null,
      phaseTimer: null,
      photoTimer: null,
      photoCfg: null,
      photo: null,
    };
    const p = makePlayer(socket.id, name);
    p.role = C.ROLE_HUNTER; // le créateur démarre chasseur par défaut (modifiable)
    p.originalRole = C.ROLE_HUNTER;
    room.players.set(socket.id, p);
    rooms.set(id, room);
    roomId = id;
    socket.join(id);
    if (cb) cb({ ok: true, roomId: id, selfId: socket.id });
    emitLobby(room);
  });

  socket.on("joinGame", ({ name, roomId: rid } = {}, cb) => {
    const room = rooms.get((rid || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, error: "Room introuvable." });
    if (room.phase !== C.PHASE_LOBBY)
      return cb && cb({ ok: false, error: "Partie déjà lancée." });
    leaveRoom();
    const p = makePlayer(socket.id, name);
    p.role = C.ROLE_HIDER;
    p.originalRole = C.ROLE_HIDER;
    room.players.set(socket.id, p);
    roomId = room.id;
    socket.join(room.id);
    if (cb) cb({ ok: true, roomId: room.id, selfId: socket.id, mode: room.mode });
    emitLobby(room);
  });

  socket.on("setRole", ({ role } = {}) => {
    const room = currentRoom();
    if (!room || room.phase !== C.PHASE_LOBBY) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (role === C.ROLE_HUNTER) {
      // 1 seul chasseur au départ.
      if (countHunters(room) >= 1 && p.role !== C.ROLE_HUNTER) return;
      p.role = C.ROLE_HUNTER;
    } else {
      p.role = C.ROLE_HIDER;
    }
    p.originalRole = p.role; // le choix du lobby fait foi pour les futures manches
    p.isHunter = p.role === C.ROLE_HUNTER;
    emitLobby(room);
  });

  socket.on("setMode", ({ mode } = {}) => {
    const room = currentRoom();
    if (!room || room.phase !== C.PHASE_LOBBY) return;
    if (socket.id !== room.hostId) return;
    room.mode = mode === C.MODE_INFECTED ? C.MODE_INFECTED
              : mode === C.MODE_PHOTO ? C.MODE_PHOTO : C.MODE_NORMAL;
    emitLobby(room);
  });

  // Réglages du mode photo (hôte, au lobby) : difficulté, attribution des scènes.
  socket.on("setPhotoConfig", (patch = {}) => {
    const room = currentRoom();
    if (!room || room.phase !== C.PHASE_LOBBY) return;
    if (socket.id !== room.hostId) return;
    Photo.setConfig(room, patch);
    emitLobby(room);
  });

  socket.on("toggleReady", () => {
    const room = currentRoom();
    if (!room || room.phase !== C.PHASE_LOBBY) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !p.ready;
    emitLobby(room);
  });

  socket.on("startGame", (arg, cb) => {
    const room = currentRoom();
    if (!room || socket.id !== room.hostId) return;
    if (room.mode === C.MODE_PHOTO) {
      const res = Photo.startHide(room, io);
      if (cb) cb(res);
      if (!res.ok) socket.emit("toastError", { error: res.error });
    } else {
      startGame(room);
    }
  });

  // --- Events du mode photo ---
  socket.on("photo:place", (payload, cb) => {
    const room = currentRoom();
    if (!room) return cb && cb({ ok: false });
    const res = Photo.place(room, socket.id, payload || {});
    if (cb) cb(res);
  });

  socket.on("photo:confirm", (arg, cb) => {
    const room = currentRoom();
    if (!room) return cb && cb({ ok: false });
    const res = Photo.confirm(room, socket.id, io);
    if (cb) cb(res);
  });

  socket.on("photo:click", (payload, cb) => {
    const room = currentRoom();
    if (!room) return cb && cb({ verdict: "out_of_phase" });
    const res = Photo.click(room, socket.id, payload || {}, io);
    if (cb) cb(res);
  });

  socket.on("playAgain", () => {
    const room = currentRoom();
    if (!room || socket.id !== room.hostId) return;
    if (room.phase === C.PHASE_ENDED) resetToLobby(room);
  });

  // Mouvement : le client envoie sa position, le serveur clampe au monde.
  socket.on("move", ({ x, y, rot, rotLocked } = {}) => {
    const room = currentRoom();
    if (!room) return;
    if (room.phase !== C.PHASE_PREP && room.phase !== C.PHASE_HUNT) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    if (typeof x === "number" && typeof y === "number" && isFinite(x) && isFinite(y)) {
      p.x = clamp(x, C.PLAYER_RADIUS, C.WORLD_W - C.PLAYER_RADIUS);
      p.y = clamp(y, C.PLAYER_RADIUS, C.WORLD_H - C.PLAYER_RADIUS);
    }
    if (typeof rot === "number" && isFinite(rot)) p.rot = rot;
    if (typeof rotLocked === "boolean") p.rotLocked = rotLocked;
  });

  // Peinture du bonhomme (camouflage). Diffusé une fois (sprite = image).
  socket.on("paint", ({ color, finish, sprite } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (typeof color === "string") p.color = color.slice(0, 24);
    if (finish === "glossy" || finish === "matte") p.finish = finish;
    if (typeof sprite === "string" && sprite.length < 200000) p.sprite = sprite;
    p.painted = true;
    // On informe les autres qu'un sprite est dispo (récupéré à la demande).
    socket.to(room.id).emit("paintUpdate", { id: p.id });
  });

  // Un client demande le sprite peint d'un joueur (pendant la chasse).
  socket.on("getSprite", ({ id } = {}, cb) => {
    const room = currentRoom();
    if (!room || !cb) return;
    // On ne révèle les sprites que pendant la chasse / fin (pas en prép).
    if (room.phase !== C.PHASE_HUNT && room.phase !== C.PHASE_ENDED)
      return cb({ ok: false });
    const p = room.players.get(id);
    if (!p) return cb({ ok: false });
    cb({ ok: true, id, sprite: p.sprite, color: p.color, finish: p.finish });
  });

  socket.on("shoot", ({ aim } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (typeof aim !== "number" || !isFinite(aim)) return;
    handleShoot(room, p, aim);
  });

  socket.on("leaveGame", () => leaveRoom());
  socket.on("disconnect", () => leaveRoom());
});

server.listen(PORT, () => {
  console.log(`\n  Mecha Cameleo -> http://localhost:${PORT}\n`);
});

module.exports = { app, server, io, rooms };
