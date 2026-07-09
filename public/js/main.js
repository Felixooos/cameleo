/*
 * Shell applicatif : connexion socket, menu, lobby, bascule vers le jeu
 * (mode carte "Mecha" ou mode photo tour par tour).
 */
(function () {
  const S = window.SHARED;
  const socket = io();
  let selfId = null;
  let roomId = null;
  let isHost = false;
  let myRole = S.ROLE_HIDER;
  let mapBuilt = null;
  let started = false;
  let currentMode = S.MODE_PHOTO;

  function el(id) { return document.getElementById(id); }
  function show(screen) {
    for (const s of ["menu", "lobby", "game", "photo"]) {
      el("screen-" + s).classList.toggle("active", s === screen);
    }
    if (window.MCPhoto) {
      if (screen === "photo") window.MCPhoto.start();
      else window.MCPhoto.stop();
    }
  }

  function setStatus(msg) {
    const e = el("menu-status");
    if (e) e.textContent = msg || "";
  }

  function initModules() {
    window.MCGame.init(socket, selfId);
    window.MCPhoto.init(socket, selfId, {
      onMenu: () => { socket.emit("leaveGame"); resetToMenu(); },
    });
  }

  // ---------------- Menu ----------------
  el("btn-create").onclick = () => {
    const name = el("inp-name").value.trim() || "Hôte";
    const mode = el("inp-mode").value;
    socket.emit("createGame", { name, mode }, (res) => {
      if (!res || !res.ok) return setStatus("Échec de création.");
      selfId = res.selfId; roomId = res.roomId; isHost = true; myRole = S.ROLE_HUNTER;
      initModules();
      show("lobby");
    });
  };

  el("btn-join").onclick = () => {
    const name = el("inp-name").value.trim() || "Joueur";
    const rid = el("inp-room").value.trim().toUpperCase();
    if (!rid) return setStatus("Entre un code de partie.");
    socket.emit("joinGame", { name, roomId: rid }, (res) => {
      if (!res || !res.ok) return setStatus(res && res.error ? res.error : "Échec.");
      selfId = res.selfId; roomId = res.roomId; isHost = false; myRole = S.ROLE_HIDER;
      initModules();
      show("lobby");
    });
  };

  // ---------------- Lobby ----------------
  socket.on("lobby", (lb) => {
    roomId = lb.roomId;
    isHost = lb.hostId === selfId;
    currentMode = lb.mode;

    // Retour au salon après une partie (rejouer / reset) : ré-afficher le lobby.
    if (el("screen-game").classList.contains("active") ||
        el("screen-photo").classList.contains("active")) {
      started = false;
      el("end-overlay").classList.add("hidden");
      el("photo-end").classList.add("hidden");
      show("lobby");
    }
    el("lobby-code").textContent = lb.roomId;
    el("lobby-mode").textContent =
      lb.mode === S.MODE_INFECTED ? "INFECTÉ" : lb.mode === S.MODE_PHOTO ? "📸 PHOTO" : "NORMAL";
    el("lobby-mode-select").value = lb.mode;
    el("lobby-mode-select").disabled = !isHost;

    // Réglages photo : visibles en mode photo, éditables par l'hôte.
    const isPhoto = lb.mode === S.MODE_PHOTO;
    el("photo-config").classList.toggle("hidden", !isPhoto);
    if (isPhoto && lb.photoConfig) {
      el("photo-difficulty").value = lb.photoConfig.difficulty;
      el("photo-sceneassign").value = lb.photoConfig.sceneAssign;
      el("photo-difficulty").disabled = !isHost;
      el("photo-sceneassign").disabled = !isHost;
    }
    // Pas de rôles en mode photo (tout le monde cache et cherche).
    el("role-row").classList.toggle("hidden", isPhoto);

    const me = lb.players.find((p) => p.id === selfId);
    if (me) myRole = me.role;
    el("role-hider").classList.toggle("sel", myRole === S.ROLE_HIDER);
    el("role-hunter").classList.toggle("sel", myRole === S.ROLE_HUNTER);

    const ul = el("lobby-players");
    ul.innerHTML = "";
    let hunters = 0, hiders = 0;
    lb.players.forEach((p) => {
      if (p.role === S.ROLE_HUNTER) hunters++; else hiders++;
      const li = document.createElement("li");
      const tag = isPhoto ? "📸" : p.role === S.ROLE_HUNTER ? "🔴 Chasseur" : "🦎 Cacheur";
      li.innerHTML = `<span>${p.isHost ? "👑 " : ""}${escapeHtml(p.name)}</span>` +
                     `<span class="rtag">${tag} ${p.ready ? "✅" : ""}</span>`;
      ul.appendChild(li);
    });

    if (isPhoto) {
      const n = lb.players.length;
      el("btn-start").disabled = !(isHost && n >= 2);
      el("lobby-need").textContent =
        n < 2 ? "Il faut au moins 2 joueurs."
        : isHost ? "Prêt à lancer !" : "En attente de l'hôte…";
    } else {
      el("btn-start").disabled = !(isHost && hunters >= 1 && hiders >= 1);
      el("lobby-need").textContent =
        hunters < 1 ? "Il faut au moins 1 chasseur." :
        hiders < 1 ? "Il faut au moins 1 cacheur." :
        isHost ? "Prêt à lancer !" : "En attente de l'hôte…";
    }
    el("btn-start").classList.toggle("hidden", !isHost);
  });

  el("role-hider").onclick = () => socket.emit("setRole", { role: S.ROLE_HIDER });
  el("role-hunter").onclick = () => socket.emit("setRole", { role: S.ROLE_HUNTER });
  el("lobby-mode-select").onchange = (e) => socket.emit("setMode", { mode: e.target.value });
  el("photo-difficulty").onchange = (e) => socket.emit("setPhotoConfig", { difficulty: e.target.value });
  el("photo-sceneassign").onchange = (e) => socket.emit("setPhotoConfig", { sceneAssign: e.target.value });
  el("btn-ready").onclick = () => socket.emit("toggleReady");
  el("btn-start").onclick = () => {
    const b = el("btn-start");
    if (b.disabled) return; // anti double-clic
    b.disabled = true;
    setTimeout(() => { b.disabled = false; }, 1500);
    socket.emit("startGame");
  };
  el("btn-leave").onclick = () => { socket.emit("leaveGame"); resetToMenu(); };
  el("lobby-copy").onclick = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(roomId).catch(() => {});
    el("lobby-copy").textContent = "Copié !";
    setTimeout(() => (el("lobby-copy").textContent = "Copier"), 1200);
  };

  // ---------------- Bascule vers le jeu ----------------
  socket.on("phase", (p) => {
    if (started) return;
    if (p.mode === S.MODE_PHOTO && p.phase === S.PHASE_PHOTO_HIDE) {
      started = true;
      show("photo");
    } else if (p.phase === S.PHASE_PREP || p.phase === S.PHASE_HUNT) {
      started = true;
      if (!mapBuilt) mapBuilt = window.MCMap.generateMap(S.MAP_SEED);
      show("game");
      window.MCGame.start(mapBuilt, p.mode);
    }
  });

  socket.on("ended", () => {
    // l'overlay de fin est géré par MCGame ; Rejouer réservé à l'hôte.
    el("btn-again").classList.toggle("hidden", !isHost);
  });
  socket.on("photo:gameEnd", () => {
    el("photo-again").classList.toggle("hidden", !isHost);
  });

  // Boutons fin de partie (présents dans l'écran jeu).
  el("btn-again").onclick = () => {
    if (!isHost) return; // seul l'hôte relance ; le retour au lobby vient de l'event 'lobby'
    socket.emit("playAgain");
  };
  el("btn-menu").onclick = () => { socket.emit("leaveGame"); resetToMenu(); };

  function resetToMenu() {
    started = false; roomId = null; isHost = false;
    el("end-overlay").classList.add("hidden");
    el("photo-end").classList.add("hidden");
    show("menu");
  }

  socket.on("connect", () => setStatus(""));
  socket.on("disconnect", () => setStatus("Déconnecté du serveur."));

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  show("menu");
})();
