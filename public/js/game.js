/*
 * Contrôleur en jeu : caméra, inputs, rendu monde, tir, score, infection,
 * et PEINTURE IN-WORLD (on peint son bonhomme directement dans la vue, outils dockés).
 * Le déplacement local est prédit côté client ; le serveur reste autoritaire
 * (tir, score, fin). Le sprite peint est diffusé aux autres via le serveur.
 */
(function () {
  const S = window.SHARED;

  let socket = null, selfId = null, listenersBound = false;
  let map = null, mode = S.MODE_NORMAL;
  let canvas, ctx, W = 0, H = 0;
  let running = false, posInit = false, defaultSent = false;

  const self = {
    id: null, role: S.ROLE_HIDER, x: S.WORLD_W / 2, y: S.WORLD_H / 2,
    rot: 0, rotLocked: false, alive: true, isHunter: false, score: 0,
  };
  let phase = S.PHASE_LOBBY, endsAt = 0;
  let others = [];
  let aliveHiders = 0;

  const cam = { x: S.WORLD_W / 2, y: S.WORLD_H / 2, zoom: 1.1 };
  let freeCam = false;
  const freePos = { x: S.WORLD_W / 2, y: S.WORLD_H / 2 };

  const keys = new Set();
  const mouse = { x: 0, y: 0, down: false };
  let lastShotAt = 0;
  let posLocked = false; // verrou de position (touche L)

  const sprites = new Map(); // id -> {img, requested}
  let uiRole = null, uiPhase = null;
  const shots = [];
  let lastSendAt = 0, lastT = 0;

  // --- Peinture ---
  let paintMode = false;
  let paintTool = "brush"; // brush | eyedrop
  let paintColor = "#7fae5a";
  let paintFinish = "matte";
  let brushSize = 16; // en pixels texture
  let spriteDirty = false; // une diffusion est nécessaire

  function el(id) { return document.getElementById(id); }
  function toast(msg, ms) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), ms || 2200);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function perf() { return (window.performance && performance.now()) || 0; }

  // ---------------------------------------------------------------------
  // Réseau (listeners attachés UNE seule fois)
  // ---------------------------------------------------------------------
  function init(sk, id) {
    socket = sk; selfId = id; self.id = id;
    window.__mcSocket = sk; // exposé pour tests (inoffensif)
    if (listenersBound) return;
    listenersBound = true;

    socket.on("state", (st) => {
      phase = st.phase; endsAt = st.endsAt; aliveHiders = st.aliveHiders;
      others = st.others || [];
      if (st.self) {
        self.role = st.self.role;
        self.isHunter = st.self.isHunter;
        self.score = st.self.score;
        const wasAlive = self.alive;
        self.alive = st.self.alive;
        if (!posInit) {
          self.x = st.self.x; self.y = st.self.y; posInit = true;
          cam.x = self.x; cam.y = self.y;
        }
        if (wasAlive && !self.alive) onLocalDeath();
      }
      // Diffuse une fois le camouflage par défaut (bonhomme) dès qu'on est cacheur placé.
      if (!defaultSent && posInit && self.role === S.ROLE_HIDER) {
        defaultSent = true;
        broadcastSprite();
      }
      // Sort du mode peinture si on n'est plus un cacheur vivant.
      if (paintMode && (!self.alive || self.role !== S.ROLE_HIDER)) exitPaint();
      for (const o of others) {
        if (o.hasSprite && !sprites.has(o.id)) requestSprite(o.id);
      }
      if (self.role !== uiRole || phase !== uiPhase) {
        uiRole = self.role; uiPhase = phase;
        refreshActions();
      }
      updateHUD();
    });

    socket.on("phase", (p) => {
      phase = p.phase; endsAt = p.endsAt; if (p.mode) mode = p.mode;
      if (phase === S.PHASE_HUNT) {
        freeCam = false;
        toast(self.isHunter ? "CHASSE ! Traque les cacheurs."
                            : "La chasse commence — reste camouflé et fuis !", 2600);
      }
      refreshActions();
    });

    socket.on("shot", (sh) => {
      shots.push({ x: sh.x, y: sh.y, aim: sh.aim, range: sh.range, hit: sh.hit, t0: perf() });
    });

    socket.on("eliminated", ({ id, infected }) => {
      if (id === selfId) {
        if (paintMode) exitPaint();
        if (infected) { toast("Touché ! Tu rejoins les CHASSEURS.", 3000); freeCam = false; }
        else { toast("Éliminé ! Tu passes en spectateur.", 3000); }
      } else {
        sprites.delete(id); // forcera un re-fetch si le joueur réapparaît
      }
    });

    socket.on("scores", () => updateHUD());
    socket.on("ended", (res) => { running = false; showEnd(res); });

    // Re-paint d'un autre joueur : on force le rechargement de son sprite.
    socket.on("paintUpdate", ({ id }) => {
      if (id === selfId) return;
      sprites.delete(id);
      requestSprite(id);
    });
  }

  function requestSprite(id) {
    const cur = sprites.get(id);
    if (cur && cur.img) return; // déjà chargé
    sprites.set(id, { img: cur ? cur.img : null, requested: true });
    socket.emit("getSprite", { id }, (res) => {
      if (res && res.ok && res.sprite) {
        const img = new Image();
        img.onload = () => sprites.set(id, { img, requested: true });
        img.src = res.sprite;
      } else {
        sprites.delete(id); // pas dispo (prép) : on retentera plus tard
      }
    });
  }

  function onLocalDeath() {
    if (mode === S.MODE_INFECTED) return; // infection gérée par 'eliminated'
    toast("Éliminé !", 2500);
  }

  // ---------------------------------------------------------------------
  // Boucle de jeu
  // ---------------------------------------------------------------------
  function start(mp, md) {
    map = mp; mode = md || mode;
    posInit = false; defaultSent = false; running = true;
    sprites.clear(); shots.length = 0;
    paintMode = false; paintTool = "brush"; paintColor = "#7fae5a"; paintFinish = "matte";
    posLocked = false;
    window.MCPaint.init(paintColor, paintFinish);
    canvas = el("game-canvas");
    ctx = canvas.getContext("2d");
    resize();
    bindOnce();
    setPaintBar(false);
    syncToolUI();
    refreshActions();
    lastT = perf();
    requestAnimationFrame(loop);
  }

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function loop() {
    if (!running) return;
    const t = perf();
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    update(dt, t);
    render(t);
    requestAnimationFrame(loop);
  }

  function canControl() {
    return self.alive && !paintMode && (phase === S.PHASE_PREP || phase === S.PHASE_HUNT);
  }
  function canFreeCam() {
    return self.alive && self.role === S.ROLE_HIDER && !paintMode;
  }
  function isHider() { return self.role === S.ROLE_HIDER; }
  function panMode() {
    if (paintMode) return false;
    if (phase === S.PHASE_PREP && self.role === S.ROLE_HUNTER) return true;
    return freeCam && canFreeCam();
  }

  function update(dt, t) {
    const aim = Math.atan2(mouse.y - H / 2, mouse.x - W / 2);

    if (panMode()) {
      const sp = 600 * dt / cam.zoom;
      if (keys.has("ArrowUp") || keys.has("KeyW")) freePos.y -= sp;
      if (keys.has("ArrowDown") || keys.has("KeyS")) freePos.y += sp;
      if (keys.has("ArrowLeft") || keys.has("KeyA")) freePos.x -= sp;
      if (keys.has("ArrowRight") || keys.has("KeyD")) freePos.x += sp;
      freePos.x = clamp(freePos.x, 0, S.WORLD_W);
      freePos.y = clamp(freePos.y, 0, S.WORLD_H);
    } else if (canControl()) {
      const base = (phase === S.PHASE_PREP ? S.PREP_SPEED
                    : self.role === S.ROLE_HUNTER ? S.HUNTER_SPEED : S.HIDER_SPEED);
      const speed = base / cam.zoom; // plus on zoome, plus on va lentement (précision)
      if (!posLocked) {
        let dx = 0, dy = 0;
        if (keys.has("ArrowUp") || keys.has("KeyW")) dy -= 1;
        if (keys.has("ArrowDown") || keys.has("KeyS")) dy += 1;
        if (keys.has("ArrowLeft") || keys.has("KeyA")) dx -= 1;
        if (keys.has("ArrowRight") || keys.has("KeyD")) dx += 1;
        if (dx || dy) {
          const l = Math.hypot(dx, dy);
          self.x = clamp(self.x + (dx / l) * speed * dt, S.PLAYER_RADIUS, S.WORLD_W - S.PLAYER_RADIUS);
          self.y = clamp(self.y + (dy / l) * speed * dt, S.PLAYER_RADIUS, S.WORLD_H - S.PLAYER_RADIUS);
        }
      }
      // Orientation : le bonhomme et le chasseur regardent la souris.
      // R fige l'orientation du cacheur sur l'angle courant.
      if (self.role === S.ROLE_HUNTER) self.rot = aim;
      else if (isHider() && !self.rotLocked) self.rot = aim;
    }

    // Peinture continue tant que le bouton souris est maintenu (pinceau).
    if (paintMode && mouse.down && paintTool === "brush") paintAtCursor();

    const tx = panMode() ? freePos.x : self.x;
    const ty = panMode() ? freePos.y : self.y;
    const k = paintMode ? 1 : Math.min(1, dt * 10); // recentrage instantané en peinture
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;

    if (canControl() && t - lastSendAt > 50) {
      lastSendAt = t;
      socket.emit("move", { x: self.x, y: self.y, rot: self.rot, rotLocked: self.rotLocked });
    }
  }

  function tryShoot() {
    if (paintMode) return;
    if (self.role !== S.ROLE_HUNTER || phase !== S.PHASE_HUNT) return;
    const t = perf();
    if (t - lastShotAt < S.SHOOT_COOLDOWN_MS) return;
    lastShotAt = t;
    const aim = Math.atan2(mouse.y - H / 2, mouse.x - W / 2);
    socket.emit("shoot", { aim });
  }

  // ---------------------------------------------------------------------
  // Peinture in-world
  // ---------------------------------------------------------------------
  function screenToWorld(sxp, syp) {
    const z = cam.zoom;
    return { x: (sxp - W / 2) / z + cam.x, y: (syp - H / 2) / z + cam.y };
  }
  // Convertit un point écran en coordonnées texture [0..SPRITE_SIZE] du bonhomme.
  function screenToTexture(sxp, syp) {
    const w = screenToWorld(sxp, syp);
    const dx = w.x - self.x, dy = w.y - self.y;
    const A = self.rot + Math.PI / 2;
    const ca = Math.cos(A), sa = Math.sin(A);
    const lx = dx * ca + dy * sa;
    const ly = -dx * sa + dy * ca;
    const WS = S.CHAR_WORLD_SIZE;
    return {
      u: (lx + WS / 2) / WS * S.SPRITE_SIZE,
      v: (ly + WS / 2) / WS * S.SPRITE_SIZE,
    };
  }

  function paintAtCursor() {
    const { u, v } = screenToTexture(mouse.x, mouse.y);
    // On peint sans condition : le rendu final découpe à la silhouette, donc
    // effleurer un bord (ex. les pieds) en venant de l'extérieur fonctionne.
    window.MCPaint.stroke(u, v, brushSize, paintColor);
    spriteDirty = true;
  }

  function eyedropAtCursor() {
    // Vraie pipette "écran" : prend la couleur RÉELLEMENT affichée sous le
    // curseur (ombres, dégradés, n'importe quel objet), pas la couleur de base.
    const x = clamp(Math.round(mouse.x), 0, W - 1);
    const y = clamp(Math.round(mouse.y), 0, H - 1);
    try {
      const d = ctx.getImageData(x, y, 1, 1).data;
      paintColor = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    } catch (e) { /* canvas illisible : on garde la couleur courante */ }
    window.MCPaint.setColor(paintColor);
    syncToolUI();
    paintTool = "brush"; // revient au pinceau après prélèvement
    el("pt-eyedrop").classList.remove("active");
  }

  function broadcastSprite() {
    const sprite = window.MCPaint.exportSprite();
    socket.emit("paint", { color: paintColor, finish: paintFinish, sprite });
    spriteDirty = false;
  }

  function enterPaint() {
    if (!isHider() || !self.alive) return;
    paintMode = true;
    freeCam = false;
    self.rotLocked = true; // fige le perso pendant la peinture
    cam.zoom = Math.max(cam.zoom, 3.5);
    setPaintBar(true);
    refreshActions();
    el("hud-hint").textContent =
      "Peins ton bonhomme · 💧 Pipette = prélève une couleur du sol · molette = zoom · « Terminer »";
  }

  function exitPaint() {
    if (!paintMode) return;
    paintMode = false;
    self.rotLocked = false; // le bonhomme re-suit la souris
    setPaintBar(false);
    if (spriteDirty || !defaultSent) broadcastSprite();
    refreshActions();
    el("hud-hint").textContent = hintText();
  }

  function setPaintBar(show) {
    el("paint-bar").classList.toggle("hidden", !show);
  }

  function syncToolUI() {
    el("pt-color").value = toHex6(paintColor);
    el("pt-swatch").style.background = paintColor;
    el("pt-brush").value = brushSize;
    el("pt-finish").checked = paintFinish === "glossy";
    el("pt-finishlbl").textContent = paintFinish === "glossy" ? "Brillant" : "Mat";
  }
  function toHex6(c) {
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
    return "#7fae5a";
  }

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  function render(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#2b2b2b";
    ctx.fillRect(0, 0, W, H);

    const z = cam.zoom;
    ctx.setTransform(z, 0, 0, z, W / 2 - cam.x * z, H / 2 - cam.y * z);
    const hw = W / (2 * z), hh = H / (2 * z);
    const view = { x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh };
    window.MCMap.drawMap(ctx, map, view, t);

    if (self.role === S.ROLE_HUNTER && phase === S.PHASE_HUNT && !freeCam) {
      ctx.strokeStyle = "rgba(255,70,70,0.35)";
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.arc(self.x, self.y, S.SHOOT_RANGE, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (phase === S.PHASE_HUNT || phase === S.PHASE_ENDED) {
      for (const o of others) drawPlayer(o);
    }
    drawSelf();

    drawShots(t);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (paintMode) drawBrushCursor();
    else if (self.role === S.ROLE_HUNTER && phase === S.PHASE_HUNT && !freeCam) drawCrosshair();
  }

  // Dessine un personnage bonhomme (sprite) à une position/rotation données.
  function drawCharacter(x, y, rot, img) {
    const size = S.CHAR_WORLD_SIZE;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rot || 0) + Math.PI / 2);
    if (img) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
    } else {
      // fallback discret (bonhomme sombre), JAMAIS un simple rond
      ctx.fillStyle = "rgba(40,40,35,0.9)";
      ctx.beginPath();
      ctx.ellipse(0, size * 0.05, size * 0.2, size * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, -size * 0.22, size * 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawPlayer(p) {
    if (p.role === S.ROLE_HUNTER) { drawHunter(p); return; }
    if (!p.alive) return; // cacheur éliminé : invisible (mode normal)
    const sp = sprites.get(p.id);
    drawCharacter(p.x, p.y, p.rot, sp && sp.img);
  }

  function drawSelf() {
    if (phase === S.PHASE_PREP && self.role === S.ROLE_HUNTER) return;
    if (self.role === S.ROLE_HUNTER) {
      drawHunter({ x: self.x, y: self.y, rot: self.rot });
      return;
    }
    if (!self.alive) return;
    // notre propre bonhomme = rendu live depuis le moteur de peinture
    drawCharacter(self.x, self.y, self.rot, window.MCPaint.build());
    // marqueur "moi"
    const z = cam.zoom;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(self.x, self.y - S.CHAR_WORLD_SIZE * 0.62, 4 / z, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHunter(p) {
    const z = cam.zoom;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot || 0);
    ctx.fillStyle = "#2a2f3a";
    ctx.beginPath(); ctx.arc(0, 0, S.PLAYER_RADIUS * 1.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#e23b3b";
    ctx.beginPath(); ctx.arc(0, 0, S.PLAYER_RADIUS * 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#1a1d24";
    ctx.fillRect(0, -4, S.PLAYER_RADIUS * 1.8, 8);
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.beginPath(); ctx.arc(0, 0, S.PLAYER_RADIUS * 1.2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function drawShots(t) {
    const z = cam.zoom;
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      const age = (t - s.t0) / 260;
      if (age >= 1) { shots.splice(i, 1); continue; }
      const a = 1 - age;
      ctx.strokeStyle = "rgba(255,220,90," + a + ")";
      ctx.lineWidth = 4 / z;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(s.aim) * s.range, s.y + Math.sin(s.aim) * s.range);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,240,180," + a + ")";
      ctx.beginPath();
      ctx.arc(s.x, s.y, 8 / z * (1 + age), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBrushCursor() {
    // rayon écran du pinceau = rayon texture * (taille monde / taille texture) * zoom
    const r = brushSize * (S.CHAR_WORLD_SIZE / S.SPRITE_SIZE) * cam.zoom;
    ctx.strokeStyle = paintTool === "eyedrop" ? "rgba(90,180,255,0.9)" : "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, Math.max(4, r), 0, Math.PI * 2);
    ctx.stroke();
    if (paintTool === "eyedrop") {
      ctx.fillStyle = "rgba(90,180,255,0.9)";
      ctx.font = "16px sans-serif";
      ctx.fillText("💧", mouse.x + 10, mouse.y - 10);
    }
  }

  function drawCrosshair() {
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, 10, 0, Math.PI * 2);
    ctx.moveTo(mouse.x - 16, mouse.y); ctx.lineTo(mouse.x - 6, mouse.y);
    ctx.moveTo(mouse.x + 6, mouse.y); ctx.lineTo(mouse.x + 16, mouse.y);
    ctx.moveTo(mouse.x, mouse.y - 16); ctx.lineTo(mouse.x, mouse.y - 6);
    ctx.moveTo(mouse.x, mouse.y + 6); ctx.lineTo(mouse.x, mouse.y + 16);
    ctx.stroke();
  }

  // ---------------------------------------------------------------------
  // HUD / actions
  // ---------------------------------------------------------------------
  function updateHUD() {
    const remain = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const mm = String(Math.floor(remain / 60)).padStart(2, "0");
    const ss = String(remain % 60).padStart(2, "0");
    el("hud-timer").textContent = mm + ":" + ss;
    el("hud-phase").textContent =
      phase === S.PHASE_PREP ? "PRÉPARATION" : phase === S.PHASE_HUNT ? "CHASSE" : "—";
    el("hud-role").textContent =
      self.role === S.ROLE_HUNTER ? "🔴 CHASSEUR" : self.alive ? "🦎 CACHEUR" : "💀 SPECTATEUR";
    el("hud-alive").textContent = "Cacheurs en vie : " + aliveHiders;
    el("hud-score").textContent = "Score : " + (self.score || 0);
    el("hud-mode").textContent = mode === S.MODE_INFECTED ? "Mode INFECTÉ" : "Mode NORMAL";
  }

  // Affiche la barre d'actions du cacheur (prép ET chasse), l'attente du chasseur en prép.
  function refreshActions() {
    const hider = isHider();
    const playing = phase === S.PHASE_PREP || phase === S.PHASE_HUNT;
    el("prep-actions").classList.toggle("hidden", !(hider && self.alive && playing && !paintMode));
    el("hunter-wait").classList.toggle("hidden", !(phase === S.PHASE_PREP && self.role === S.ROLE_HUNTER));
    if (!paintMode) el("hud-hint").textContent = hintText();
    reflectLocks();
  }

  function reflectLocks() {
    const lp = el("btn-lockpos"), lr = el("btn-lockrot");
    if (lp) lp.classList.toggle("active", posLocked);
    if (lr) lr.classList.toggle("active", self.rotLocked);
  }

  function hintText() {
    if (!self.alive) return "💀 Spectateur — tu observes la fin de la partie.";
    if (self.role === S.ROLE_HUNTER) {
      return phase === S.PHASE_PREP
        ? "Patiente… (« Survoler la carte » pour explorer)"
        : "Souris : viser · Clic / Espace : tirer (recharge 2 s)";
    }
    // cacheur
    return phase === S.PHASE_PREP
      ? "Flèches : bouger (lent si zoomé) · souris : orienter · L : verrou position · R : figer orientation · 🎨 P · molette : zoom"
      : "Flèches : fuir · souris : orienter · L : verrou position · 🎨 P (re-camouflage) · molette : zoom (×12)";
  }

  // ---------------------------------------------------------------------
  // Fin de partie
  // ---------------------------------------------------------------------
  function showEnd(res) {
    if (paintMode) exitPaint();
    let title, sub;
    if (res.outcome === "hiders_survived") { title = "LES CACHEURS RÉSISTENT"; sub = "Au moins un caméléon a survécu !"; }
    else if (res.outcome === "hunter_wins") { title = "LE CHASSEUR GAGNE"; sub = "Tous les cacheurs ont été éliminés."; }
    else if (res.outcome === "all_infected") { title = "INFECTION TOTALE"; sub = "Tout le monde a été infecté."; }
    else { title = "PARTIE TERMINÉE"; sub = ""; }
    el("end-title").textContent = title;
    el("end-outcome").textContent = sub + " (" + frReason(res.reason) + ")";
    const list = el("end-ranking");
    list.innerHTML = "";
    res.ranking.forEach((r, i) => {
      const li = document.createElement("li");
      const tag = r.role === S.ROLE_HUNTER ? "🔴" : r.alive ? "🦎" : "💀";
      li.textContent = `${i + 1}. ${tag} ${r.name} — ${r.score} pts`;
      if (r.id === selfId) li.classList.add("me");
      list.appendChild(li);
    });
    el("end-overlay").classList.remove("hidden");
  }
  function frReason(r) {
    return { timeout: "temps écoulé", all_hiders_down: "tous éliminés",
             player_left: "joueur parti" }[r] || r;
  }

  // ---------------------------------------------------------------------
  // Inputs (attachés une seule fois)
  // ---------------------------------------------------------------------
  function bindOnce() {
    if (bindOnce._done) return; bindOnce._done = true;

    window.addEventListener("resize", resize);

    window.addEventListener("keydown", (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab"].includes(e.code))
        e.preventDefault();
      keys.add(e.code);
      if (e.code === "Escape" && paintMode) exitPaint();
      if (e.code === "KeyP" && isHider() && self.alive) paintMode ? exitPaint() : enterPaint();
      if (paintMode) return;
      if (e.code === "KeyR" && isHider() && canControl()) {
        self.rotLocked = !self.rotLocked;
        toast(self.rotLocked ? "Orientation figée 🧭" : "Orientation libre (suit la souris)", 1300);
        reflectLocks();
      }
      if (e.code === "KeyC" && canFreeCam()) {
        freeCam = !freeCam;
        if (freeCam) { freePos.x = self.x; freePos.y = self.y; }
        toast(freeCam ? "Caméra libre 🎥" : "Caméra suivie", 1200);
      }
      if (e.code === "KeyL" && isHider() && canControl()) {
        posLocked = !posLocked;
        toast(posLocked ? "Position verrouillée 📍" : "Position libérée", 1200);
        reflectLocks();
      }
      if (e.code === "Space") tryShoot();
    });
    window.addEventListener("keyup", (e) => keys.delete(e.code));

    canvas.addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.down = true;
      if (paintMode) {
        if (paintTool === "eyedrop") eyedropAtCursor();
        else paintAtCursor();
      } else {
        tryShoot();
      }
    });
    window.addEventListener("mouseup", () => {
      if (mouse.down && paintMode && spriteDirty) broadcastSprite();
      mouse.down = false;
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      cam.zoom = clamp(cam.zoom * (e.deltaY < 0 ? 1.12 : 0.89), S.MIN_ZOOM, S.MAX_ZOOM);
    }, { passive: false });

    // Boutons d'action cacheur
    el("btn-paint").onclick = () => { if (isHider() && self.alive) paintMode ? exitPaint() : enterPaint(); };
    el("btn-freecam").onclick = () => {
      if (!canFreeCam()) return;
      freeCam = !freeCam;
      if (freeCam) { freePos.x = self.x; freePos.y = self.y; }
    };
    el("btn-lockpos").onclick = () => {
      if (isHider() && canControl()) {
        posLocked = !posLocked;
        toast(posLocked ? "Position verrouillée 📍" : "Position libérée", 1200);
        reflectLocks();
      }
    };
    el("btn-lockrot").onclick = () => {
      if (isHider()) {
        self.rotLocked = !self.rotLocked;
        toast(self.rotLocked ? "Orientation figée 🧭" : "Orientation libre (suit la souris)", 1300);
        reflectLocks();
      }
    };
    el("btn-survol").onclick = () => {
      el("hunter-wait").classList.add("hidden");
      freePos.x = S.WORLD_W / 2; freePos.y = S.WORLD_H / 2;
    };

    // Barre d'outils de peinture
    el("pt-eyedrop").onclick = () => {
      paintTool = paintTool === "eyedrop" ? "brush" : "eyedrop";
      el("pt-eyedrop").classList.toggle("active", paintTool === "eyedrop");
    };
    el("pt-color").oninput = (e) => { paintColor = e.target.value; window.MCPaint.setColor(paintColor); el("pt-swatch").style.background = paintColor; };
    el("pt-brush").oninput = (e) => { brushSize = +e.target.value; };
    el("pt-finish").onchange = (e) => {
      paintFinish = e.target.checked ? "glossy" : "matte";
      el("pt-finishlbl").textContent = paintFinish === "glossy" ? "Brillant" : "Mat";
      window.MCPaint.setFinish(paintFinish);
      spriteDirty = true;
    };
    el("pt-fill").onclick = () => { window.MCPaint.fill(paintColor); spriteDirty = true; };
    el("pt-done").onclick = () => exitPaint();
  }

  function selfPos() { return { x: self.x, y: self.y }; }
  function debug() {
    return {
      phase, role: self.role, alive: self.alive, paintMode,
      self: { x: Math.round(self.x), y: Math.round(self.y) },
      others: others.map((o) => ({ id: o.id, x: o.x, y: o.y, role: o.role, alive: o.alive, hasSprite: o.hasSprite })),
    };
  }

  window.MCGame = { init, start, selfPos, debug };
})();
