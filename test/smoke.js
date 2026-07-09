/*
 * Test de fumée automatisé : prouve la logique réseau de bout en bout
 * (lobby -> start -> prép -> peinture -> chasse -> score -> tir -> élimination -> fin),
 * plus la conversion en mode infecté. Aucun navigateur requis.
 *
 * Lancement : npm test
 */
process.env.PORT = process.env.PORT || "3100";
process.env.PREP_MS = "700"; // préparation courte
process.env.HUNT_MS = "20000";
process.env.SCORE_MS = "350"; // scoring rapide

const { io: client } = require("socket.io-client");
const C = require("../shared/constants");
require("../server"); // démarre le serveur sur PORT

const URL = "http://localhost:" + process.env.PORT;
const TINY_SPRITE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((res, rej) => {
    const s = client(URL, { transports: ["websocket"], forceNew: true });
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
    setTimeout(() => rej(new Error("timeout connect")), 4000);
  });
}
function waitFor(sock, event, pred, timeout = 6000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { sock.off(event, h); rej(new Error("timeout " + event)); }, timeout);
    function h(p) { if (!pred || pred(p)) { clearTimeout(to); sock.off(event, h); res(p); } }
    sock.on(event, h);
  });
}

async function scenario(mode) {
  const infected = mode === C.MODE_INFECTED;
  console.log(`\n--- Scénario mode ${mode.toUpperCase()} ---`);
  const hunter = await connect();
  const hider = await connect();
  // En mode infecté : un 2e cacheur survit (loin) pour que la partie continue
  // après la conversion, afin d'observer le changement de rôle côté client.
  const survivor = infected ? await connect() : null;

  // 1) Création + jonction
  const created = await new Promise((r) => hunter.emit("createGame", { name: "Chasseur", mode }, r));
  ok("createGame ok", created && created.ok && created.roomId);
  const roomId = created.roomId;

  const joined = await new Promise((r) => hider.emit("joinGame", { name: "Cacheur", roomId }, r));
  ok("joinGame ok", joined && joined.ok);
  const hiderId = joined.selfId;

  let survivorId = null;
  if (survivor) {
    const j2 = await new Promise((r) => survivor.emit("joinGame", { name: "Survivant", roomId }, r));
    survivorId = j2.selfId;
  }

  // 2) Lobby reflète les joueurs : 1 chasseur, >=1 cacheur
  const expected = infected ? 3 : 2;
  const lb = await waitFor(hunter, "lobby", (l) => l.players.length === expected);
  const hunters = lb.players.filter((p) => p.role === C.ROLE_HUNTER).length;
  const hiders = lb.players.filter((p) => p.role === C.ROLE_HIDER).length;
  ok("lobby: 1 chasseur + cacheurs", hunters === 1 && hiders >= 1);

  // 3) Démarrage -> phase prép
  const prepPromise = waitFor(hider, "phase", (p) => p.phase === C.PHASE_PREP);
  hunter.emit("startGame");
  await prepPromise;
  ok("phase = prép après start", true);

  // 4) En prép, position propre reçue + anti-triche (aucun autre visible)
  const stPrep = await waitFor(hider, "state", (s) => s.phase === C.PHASE_PREP);
  ok("prép: position propre reçue", typeof stPrep.self.x === "number");
  ok("prép: aucun autre joueur visible (anti-triche)", stPrep.others.length === 0);

  // 5) Peinture du camouflage
  hider.emit("paint", { color: "#123456", finish: "glossy", sprite: TINY_SPRITE });

  // 6) Rapproche le cacheur du chasseur (centre) ; éloigne le survivant
  const cx = C.WORLD_W / 2, cy = C.WORLD_H / 2;
  const moveHider = () => hider.emit("move", { x: cx + 120, y: cy, rot: 0, rotLocked: false });
  const moveSurvivor = () => survivor && survivor.emit("move", { x: 80, y: 80, rot: 0 });
  moveHider(); moveSurvivor();

  // 7) Passage en chasse
  await waitFor(hider, "phase", (p) => p.phase === C.PHASE_HUNT, 4000);
  ok("phase = chasse après la prép", true);
  moveHider(); moveSurvivor();

  // 8) En chasse, le chasseur voit le cacheur (sprite dispo)
  const stHunt = await waitFor(hunter, "state",
    (s) => s.phase === C.PHASE_HUNT && s.others.some((o) => o.id === hiderId), 4000);
  const seen = stHunt.others.find((o) => o.id === hiderId);
  ok("chasse: le chasseur voit le cacheur", !!seen);
  ok("chasse: sprite peint disponible", seen && seen.hasSprite === true);

  // 9) Récupération du sprite
  const sp = await new Promise((r) => hunter.emit("getSprite", { id: hiderId }, r));
  ok("getSprite renvoie le PNG", sp && sp.ok && typeof sp.sprite === "string");

  // 10) Scoring : le cacheur proche marque des points
  const scoreEvt = await waitFor(hunter, "scores",
    (s) => { const e = s.scores.find((x) => x.id === hiderId); return e && e.score > 0; }, 4000);
  const hiderScore = scoreEvt.scores.find((x) => x.id === hiderId).score;
  ok("scoring: cacheur proche marque des points (" + hiderScore + ")", hiderScore > 0);

  // 11) Tir -> élimination (écouteurs pré-enregistrés, émissions synchrones serveur)
  const elimPromise = waitFor(hunter, "eliminated", (e) => e.id === hiderId, 4000);
  const endedPromise = waitFor(hunter, "ended", null, 5000);
  const convPromise = infected
    ? waitFor(hider, "state", (s) => s.self.role === C.ROLE_HUNTER, 4000)
    : null;
  moveHider();
  await wait(120);
  hunter.emit("shoot", { aim: 0 });
  const elim = await elimPromise;
  ok("tir touche le cacheur dans la portée", elim.id === hiderId);

  if (infected) {
    ok("infecté: élimination marquée 'infected'", elim.infected === true);
    const stInf = await convPromise;
    ok("infecté: le mort devient CHASSEUR", stInf.self.role === C.ROLE_HUNTER);
    survivor.close(); // le survivant part -> fin de partie
    await endedPromise.catch(() => {});
  } else {
    ok("normal: élimination définitive (non infectée)", elim.infected === false);
    const ended = await endedPromise;
    ok("normal: fin = victoire du chasseur", ended.outcome === "hunter_wins");
  }

  hunter.close();
  hider.close();
  if (survivor) survivor.close();
  await wait(80);
}

// Prouve le correctif critique : après une manche INFECTÉE, "Rejouer" restaure
// les rôles d'origine (l'ex-cacheur infecté redevient cacheur) -> partie relançable.
async function replayAfterInfected() {
  console.log(`\n--- Scénario REJOUER après INFECTÉ ---`);
  const hunter = await connect();
  const hider = await connect();

  const created = await new Promise((r) => hunter.emit("createGame", { name: "Hote", mode: C.MODE_INFECTED }, r));
  const roomId = created.roomId;
  const joined = await new Promise((r) => hider.emit("joinGame", { name: "Proie", roomId }, r));
  const hiderId = joined.selfId;
  await waitFor(hunter, "lobby", (l) => l.players.length === 2);

  // Manche 1 : démarrage -> chasse -> infection -> fin (0 cacheur restant).
  const prep = waitFor(hider, "phase", (p) => p.phase === C.PHASE_PREP);
  hunter.emit("startGame");
  await prep;
  const cx = C.WORLD_W / 2, cy = C.WORLD_H / 2;
  hider.emit("move", { x: cx + 100, y: cy, rot: 0 });
  await waitFor(hider, "phase", (p) => p.phase === C.PHASE_HUNT, 4000);
  hider.emit("move", { x: cx + 100, y: cy, rot: 0 });
  const ended = waitFor(hunter, "ended", null, 5000);
  await wait(150);
  hunter.emit("shoot", { aim: 0 });
  await ended;
  ok("rejouer: manche infectée terminée", true);

  // Rejouer : l'hôte relance -> 'lobby' doit montrer les rôles restaurés.
  const lobbyBack = waitFor(hunter, "lobby", (l) => l.phase === C.PHASE_LOBBY, 4000);
  hunter.emit("playAgain");
  const lb = await lobbyBack;
  const hiderP = lb.players.find((p) => p.id === hiderId);
  ok("rejouer: l'ex-infecté est redevenu CACHEUR", hiderP && hiderP.role === C.ROLE_HIDER);
  const hunters = lb.players.filter((p) => p.role === C.ROLE_HUNTER).length;
  const hiders = lb.players.filter((p) => p.role === C.ROLE_HIDER).length;
  ok("rejouer: composition relançable (1 chasseur + 1 cacheur)", hunters === 1 && hiders === 1);

  // La 2e manche démarre bien (le garde-fou ne bloque plus).
  const prep2 = waitFor(hider, "phase", (p) => p.phase === C.PHASE_PREP, 4000);
  hunter.emit("startGame");
  await prep2;
  ok("rejouer: la 2e manche démarre (plus de soft-lock)", true);

  hunter.close();
  hider.close();
  await wait(80);
}

(async () => {
  try {
    await scenario(C.MODE_NORMAL);
    await scenario(C.MODE_INFECTED);
    await replayAfterInfected();
  } catch (e) {
    failed++;
    console.log("  ❌ Exception : " + (e && e.message));
  }
  console.log(`\n===== Résultat : ${passed} réussis, ${failed} échoués =====`);
  process.exit(failed === 0 ? 0 : 1);
})();
