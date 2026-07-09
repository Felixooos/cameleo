/*
 * Mode "Cache-cache photo" - client.
 * Phase cachette : place ton mannequin sur TA scène (prévisu empreinte en direct,
 * même module de rendu que le composite serveur). Puis tours de recherche :
 * l'image composite (servie par le serveur, position jamais transmise) s'affiche
 * chez les chercheurs, premier clic juste gagne, 3 essais max, verrou entre essais.
 */
(function () {
  const S = window.SHARED;
  const IM = window.MCImprint;

  let socket = null, selfId = null, bound = false, onMenu = null;
  let canvas = null, ctx = null, W = 0, H = 0;
  let active = false, rafOn = false;

  // état de partie
  let phase = null, endsAt = 0;
  let difficulty = "normal", charScale = 0.10, maxMisses = 3;
  let sceneImg = null; // image de MA scène (cachette)
  let turnImg = null; // composite du tour courant
  let placement = { x: 0.5, y: 0.6, flip: false };
  let confirmed = false, hideProgress = { confirmed: 0, total: 0 };
  let turn = null; // payload turnStart + état local
  let reveal = null; // {pos, outcome, t0, banner}
  const misses = []; // splashs {x,y,name,t0}
  let lockedUntil = 0, missesLeft = 3, exhausted = false;
  let lastPlaceSent = 0, dragging = false;
  const mouse = { x: 0, y: 0, inside: false };

  function el(id) { return document.getElementById(id); }
  function now() { return Date.now(); }
  function toast(msg, ms) {
    const t = el("photo-toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), ms || 2400);
  }

  // -------------------------------------------------------------------------
  // Viewport letterbox (jamais de crop : le clic doit correspondre au pixel)
  // -------------------------------------------------------------------------
  function fitRect() {
    const s = Math.min(W / S.PHOTO_SCENE_W, H / S.PHOTO_SCENE_H);
    const dw = S.PHOTO_SCENE_W * s, dh = S.PHOTO_SCENE_H * s;
    return { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh };
  }
  function toScene(cx, cy) {
    const f = fitRect();
    const x = (cx - f.ox) / f.dw, y = (cy - f.oy) / f.dh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  // -------------------------------------------------------------------------
  // Réseau
  // -------------------------------------------------------------------------
  function init(sk, id, opts) {
    socket = sk; selfId = id;
    onMenu = (opts && opts.onMenu) || null;
    if (bound) return;
    bound = true;

    socket.on("photo:hideStart", (p) => {
      difficulty = p.difficulty; charScale = p.charScale; maxMisses = p.maxMisses;
      phase = S.PHASE_PHOTO_HIDE; endsAt = p.endsAt;
      confirmed = false; reveal = null; turn = null; turnImg = null;
      misses.length = 0;
      hideProgress = { confirmed: 0, total: 0 };
      placement = { x: 0.5, y: 0.62, flip: false };
      sceneImg = new Image();
      sceneImg.src = p.scene.url;
      sendPlace(true); // position par défaut enregistrée côté serveur
      updateBars();
      el("photo-hint").textContent =
        "Clique ou glisse pour te placer · Miroir pour te retourner · Valide quand tu es prêt";
      toast("Cache-toi ! Tu as " + Math.round(p.hideMs / 1000) + " s", 2600);
    });

    socket.on("photo:hideProgress", (p) => {
      hideProgress = p;
      el("photo-ready-count").textContent = p.confirmed + "/" + p.total + " prêts";
    });

    socket.on("phase", (p) => {
      if (p.mode !== S.MODE_PHOTO) return;
      phase = p.phase; endsAt = p.endsAt;
      updateBars();
    });

    socket.on("photo:turnStart", (p) => {
      phase = S.PHASE_PHOTO_TURN; endsAt = p.endsAt;
      turn = p; reveal = null;
      misses.length = 0;
      lockedUntil = 0; missesLeft = p.maxMisses; exhausted = false;
      turnImg = new Image();
      turnImg.src = p.imageUrl;
      el("photo-end").classList.add("hidden");
      updateBars();
      updateScoreboard(p.scores);
      if (p.youAre === "hider") {
        toast("C'est TON tour : " + (p.turnCount - 1) + " joueurs te cherchent…", 2800);
        el("photo-hint").textContent = "Les autres cherchent ton mannequin. Croise les doigts 🤞";
      } else {
        toast("Cherche " + p.hider.name + " ! " + p.maxMisses + " essais max", 2800);
        el("photo-hint").textContent =
          "Trouve le mannequin caché de " + p.hider.name + " · clique dessus · " +
          p.maxMisses + " essais, verrou entre deux";
      }
    });

    socket.on("photo:miss", (m) => {
      misses.push({ x: m.x, y: m.y, name: m.name, t0: performance.now() });
    });

    socket.on("photo:turnEnd", (e) => {
      phase = S.PHASE_PHOTO_REVEAL; endsAt = e.nextAt;
      reveal = { ...e, t0: performance.now() };
      updateScoreboard(e.scores);
      updateBars();
      let msg;
      if (e.outcome === "found") {
        const t = (e.findTimeMs / 1000).toFixed(1);
        msg = "🎯 " + (e.foundBy ? e.foundBy.name : "?") + " a trouvé " + e.hider.name + " en " + t + " s !";
      } else if (e.outcome === "timeout") {
        msg = "⏱ Personne n'a trouvé " + e.hider.name + " : il marque !";
      } else if (e.outcome === "all_exhausted") {
        msg = "😵 Plus d'essais chez personne : " + e.hider.name + " marque !";
      } else if (e.outcome === "hider_left") {
        msg = e.hider.name + " est parti, tour annulé.";
      } else {
        msg = "Fin du tour.";
      }
      el("photo-reveal-text").textContent = msg;
      el("photo-reveal-banner").classList.remove("hidden");
      setTimeout(() => el("photo-reveal-banner").classList.add("hidden"),
                 Math.max(1500, (e.nextAt - now()) - 200));
    });

    socket.on("photo:gameEnd", (fin) => {
      phase = S.PHASE_ENDED;
      const list = el("photo-ranking");
      list.innerHTML = "";
      const medals = ["🥇", "🥈", "🥉"];
      fin.ranking.forEach((r, i) => {
        const li = document.createElement("li");
        li.textContent = (medals[i] || (i + 1) + ".") + " " + r.name + " — " + r.score + " pts";
        if (r.id === selfId) li.classList.add("me");
        list.appendChild(li);
      });
      el("photo-end").classList.remove("hidden");
      updateBars();
    });

    socket.on("toastError", (e) => toast("⚠ " + (e.error || "Erreur"), 3000));
  }

  // -------------------------------------------------------------------------
  // Démarrage / arrêt de l'écran
  // -------------------------------------------------------------------------
  function start() {
    active = true;
    canvas = el("photo-canvas");
    ctx = canvas.getContext("2d");
    resize();
    bindUI();
    if (!rafOn) { rafOn = true; requestAnimationFrame(loop); }
  }
  function stop() { active = false; }

  function resize() {
    if (!canvas) return;
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  let uiBound = false;
  function bindUI() {
    if (uiBound) return;
    uiBound = true;
    window.addEventListener("resize", resize);

    canvas.addEventListener("pointerdown", (e) => {
      const p = toScene(e.clientX, e.clientY);
      if (!p) return;
      if (phase === S.PHASE_PHOTO_HIDE) {
        dragging = true;
        placement.x = p.x; placement.y = p.y;
        sendPlace(true); // placement d'abord, capture ensuite (clics synthétiques)
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      } else if (phase === S.PHASE_PHOTO_TURN && turn && turn.youAre === "seeker") {
        tryClick(p);
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      mouse.x = e.clientX; mouse.y = e.clientY;
      mouse.inside = !!toScene(e.clientX, e.clientY);
      if (dragging && phase === S.PHASE_PHOTO_HIDE) {
        const p = toScene(e.clientX, e.clientY);
        if (p) { placement.x = p.x; placement.y = p.y; sendPlace(false); }
      }
    });
    window.addEventListener("pointerup", () => {
      if (dragging) { dragging = false; sendPlace(true); }
    });

    el("photo-flip").onclick = () => {
      placement.flip = !placement.flip;
      sendPlace(true);
    };
    el("photo-confirm").onclick = () => {
      socket.emit("photo:confirm", {}, (res) => {
        if (res && res.ok) {
          confirmed = true;
          updateBars();
          toast("Position validée ✔ En attente des autres…", 2200);
        }
      });
    };
    el("photo-again").onclick = () => socket.emit("playAgain");
    el("photo-menu").onclick = () => { if (onMenu) onMenu(); };
  }

  function sendPlace(force) {
    if (phase !== S.PHASE_PHOTO_HIDE) return;
    const t = now();
    if (!force && t - lastPlaceSent < 60) return;
    lastPlaceSent = t;
    confirmed = false;
    updateBars();
    socket.emit("photo:place", { ...placement }, (res) => {
      if (res && res.ok) { placement.x = res.x; placement.y = res.y; }
    });
  }

  function tryClick(p) {
    if (exhausted) { toast("Plus d'essais pour ce tour 😵", 1500); return; }
    if (now() < lockedUntil) return;
    socket.emit("photo:click", p, (res) => {
      if (!res) return;
      if (res.verdict === "hit") {
        toast("🎯 TROUVÉ !", 2000);
      } else if (res.verdict === "miss") {
        lockedUntil = res.lockedUntil || now() + 1500;
        missesLeft = res.missesLeft;
        toast("Raté ! " + res.missesLeft + " essai" + (res.missesLeft > 1 ? "s" : "") + " restant" + (res.missesLeft > 1 ? "s" : ""), 1600);
      } else if (res.verdict === "exhausted") {
        exhausted = true; missesLeft = 0;
        toast("Plus d'essais : spectateur pour ce tour", 2400);
      } else if (res.verdict === "locked") {
        lockedUntil = res.lockedUntil;
      }
      updateBars();
    });
  }

  // -------------------------------------------------------------------------
  // Barres / HUD DOM
  // -------------------------------------------------------------------------
  function updateBars() {
    const hideUI = phase === S.PHASE_PHOTO_HIDE;
    el("photo-hide-bar").classList.toggle("hidden", !hideUI);
    if (hideUI) {
      el("photo-confirm").textContent = confirmed ? "✔ Validé (re-cliquer la scène pour bouger)" : "✔ Je suis caché !";
      el("photo-confirm").classList.toggle("confirmed", confirmed);
    }
    const pillPhase = el("photo-phase");
    pillPhase.textContent =
      phase === S.PHASE_PHOTO_HIDE ? "CACHETTE"
      : phase === S.PHASE_PHOTO_TURN ? "RECHERCHE"
      : phase === S.PHASE_PHOTO_REVEAL ? "RÉVÉLATION"
      : phase === S.PHASE_ENDED ? "TERMINÉ" : "—";
    const turnPill = el("photo-turn-pill");
    if (turn && (phase === S.PHASE_PHOTO_TURN || phase === S.PHASE_PHOTO_REVEAL)) {
      turnPill.classList.remove("hidden");
      turnPill.textContent = "Tour " + (turn.turnIndex + 1) + "/" + turn.turnCount +
        " · cachette de " + turn.hider.name;
    } else turnPill.classList.add("hidden");
    const tries = el("photo-tries");
    if (phase === S.PHASE_PHOTO_TURN && turn && turn.youAre === "seeker") {
      tries.classList.remove("hidden");
      tries.textContent = "Essais : " + "●".repeat(missesLeft) + "○".repeat(Math.max(0, maxMisses - missesLeft));
    } else tries.classList.add("hidden");
  }

  function updateScoreboard(scores) {
    if (!scores) return;
    const me = scores.find((s) => s.id === selfId);
    el("photo-score").textContent = "Score : " + (me ? me.score : 0);
    const sb = el("photo-scores");
    sb.innerHTML = "";
    scores.slice(0, 5).forEach((s, i) => {
      const li = document.createElement("li");
      li.textContent = (i + 1) + ". " + s.name + " · " + s.score;
      if (s.id === selfId) li.classList.add("me");
      sb.appendChild(li);
    });
  }

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------
  function loop() {
    if (!rafOn) return;
    if (active) render();
    requestAnimationFrame(loop);
  }

  function render() {
    const t = performance.now();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#101318";
    ctx.fillRect(0, 0, W, H);
    const f = fitRect();

    // timer
    const remain = Math.max(0, Math.ceil((endsAt - now()) / 1000));
    el("photo-timer").textContent =
      String(Math.floor(remain / 60)).padStart(2, "0") + ":" + String(remain % 60).padStart(2, "0");

    const img = phase === S.PHASE_PHOTO_HIDE ? sceneImg : turnImg;
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, f.ox, f.oy, f.dw, f.dh);
    } else {
      ctx.fillStyle = "#2a3140";
      ctx.fillRect(f.ox, f.oy, f.dw, f.dh);
      ctx.fillStyle = "#9aa6b2";
      ctx.font = "20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Chargement de la scène…", W / 2, H / 2);
      ctx.textAlign = "left";
    }

    const sz = charScale * f.dh;

    if (phase === S.PHASE_PHOTO_HIDE && img && img.complete) {
      // prévisu empreinte = EXACTEMENT ce que verront les chercheurs
      const px = f.ox + placement.x * f.dw, py = f.oy + placement.y * f.dh;
      IM.draw(ctx, px, py, sz, difficulty, placement.flip);
      // repère discret pour le propriétaire (pulsation)
      const a = 0.25 + 0.15 * Math.sin(t / 350);
      ctx.strokeStyle = "rgba(79,209,107," + a + ")";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(px - sz * 0.35, py - sz * 0.55, sz * 0.7, sz * 1.1);
      ctx.setLineDash([]);
    }

    if ((phase === S.PHASE_PHOTO_TURN || phase === S.PHASE_PHOTO_REVEAL) && turn) {
      // le cacheur voit sa propre position (rappel discret)
      if (turn.youAre === "hider" && turn.selfPlacement && phase === S.PHASE_PHOTO_TURN) {
        const px = f.ox + turn.selfPlacement.x * f.dw, py = f.oy + turn.selfPlacement.y * f.dh;
        const a = 0.3 + 0.2 * Math.sin(t / 300);
        ctx.strokeStyle = "rgba(79,209,107," + a + ")";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, sz * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }

      // splashs de ratés (croix + nom, 2,5 s)
      for (let i = misses.length - 1; i >= 0; i--) {
        const m = misses[i];
        const age = (t - m.t0) / 2500;
        if (age >= 1) { misses.splice(i, 1); continue; }
        const a = 1 - age;
        const mx = f.ox + m.x * f.dw, my = f.oy + m.y * f.dh;
        ctx.strokeStyle = "rgba(226,59,59," + a + ")";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(mx - 10, my - 10); ctx.lineTo(mx + 10, my + 10);
        ctx.moveTo(mx + 10, my - 10); ctx.lineTo(mx - 10, my + 10);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255," + a * 0.9 + ")";
        ctx.font = "13px sans-serif";
        ctx.fillText(m.name, mx + 14, my - 8);
      }

      // révélation : anneau + mannequin qui "se matérialise"
      if (phase === S.PHASE_PHOTO_REVEAL && reveal && reveal.pos) {
        const age = Math.min(1, (t - reveal.t0) / 900);
        const px = f.ox + reveal.pos.x * f.dw, py = f.oy + reveal.pos.y * f.dh;
        ctx.save();
        ctx.globalAlpha = age * 0.9;
        IM.drawSolid(ctx, px, py, sz, reveal.pos.flip, "#f5f0e6");
        ctx.restore();
        ctx.strokeStyle = "rgba(255,215,80," + (0.9 - 0.5 * age) + ")";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px, py, sz * (0.65 + 0.25 * age), 0, Math.PI * 2);
        ctx.stroke();
      }

      // verrou : vignette rouge + compte à rebours au curseur
      if (phase === S.PHASE_PHOTO_TURN && turn.youAre === "seeker") {
        const lockRemain = lockedUntil - now();
        if (lockRemain > 0) {
          ctx.fillStyle = "rgba(180,30,30,0.12)";
          ctx.fillRect(f.ox, f.oy, f.dw, f.dh);
          if (mouse.inside) {
            ctx.fillStyle = "#ff6b6b";
            ctx.font = "bold 16px sans-serif";
            ctx.fillText((lockRemain / 1000).toFixed(1) + "s", mouse.x + 14, mouse.y - 10);
          }
        } else if (!exhausted && mouse.inside) {
          // réticule
          ctx.strokeStyle = "rgba(255,255,255,0.75)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(mouse.x, mouse.y, 12, 0, Math.PI * 2);
          ctx.moveTo(mouse.x - 18, mouse.y); ctx.lineTo(mouse.x - 6, mouse.y);
          ctx.moveTo(mouse.x + 6, mouse.y); ctx.lineTo(mouse.x + 18, mouse.y);
          ctx.moveTo(mouse.x, mouse.y - 18); ctx.lineTo(mouse.x, mouse.y - 6);
          ctx.moveTo(mouse.x, mouse.y + 6); ctx.lineTo(mouse.x, mouse.y + 18);
          ctx.stroke();
        }
        if (exhausted) {
          ctx.fillStyle = "rgba(10,12,16,0.35)";
          ctx.fillRect(f.ox, f.oy, f.dw, f.dh);
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.font = "bold 22px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("😵 Plus d'essais — spectateur", W / 2, f.oy + 40);
          ctx.textAlign = "left";
        }
      }
    }
  }

  window.MCPhoto = { init, start, stop };
})();
