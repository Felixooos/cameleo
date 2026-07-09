/*
 * Test de fumée du mode PHOTO (tour par tour) : 3 clients, flux complet.
 * - lobby -> hide -> 3 tours (trouvé / épuisement / timeout) -> fin
 * - anti-fuite : aucun event reçu par un CHERCHEUR ne contient la position
 *   avant photo:turnEnd ; l'image du tour est un WebP tokenisé (200 puis 404).
 * Lancement : node test/photo-smoke.js
 */
process.env.PORT = process.env.PORT || "3140";
process.env.PHOTO_HIDE_MS = "60000"; // la confirmation de tous coupe court
process.env.PHOTO_TURN_MS = "2500";
process.env.PHOTO_REVEAL_MS = "300";
process.env.PHOTO_LOCK_MS = "150";

const { io: client } = require("socket.io-client");
const C = require("../shared/constants");
require("../server");

const URL = "http://localhost:" + process.env.PORT;

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
function waitFor(sock, event, pred, timeout = 8000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { sock.off(event, h); rej(new Error("timeout " + event)); }, timeout);
    function h(p) { if (!pred || pred(p)) { clearTimeout(to); sock.off(event, h); res(p); } }
    sock.on(event, h);
  });
}
function emitAck(sock, ev, payload) {
  return new Promise((r) => sock.emit(ev, payload, r));
}

(async () => {
  try {
    const A = await connect(), B = await connect(), Cc = await connect();
    const names = new Map();

    // --- Sentinelle anti-fuite : sur B (toujours chercheur au moins 2 tours),
    // aucun payload avant turnEnd ne doit exposer une position de cacheur.
    const leaks = [];
    B.onAny((ev, payload) => {
      if (ev === "photo:turnEnd" || ev === "photo:gameEnd") return;
      const s = JSON.stringify(payload || {});
      if (ev === "photo:turnStart" && s.includes("selfPlacement") &&
          payload.youAre === "seeker") {
        leaks.push(ev + " expose selfPlacement à un chercheur");
      }
      if (s.includes('"pos"')) leaks.push(ev + " contient un champ pos");
    });

    // --- Lobby ---
    const created = await emitAck(A, "createGame", { name: "Alice", mode: "photo" });
    ok("createGame mode photo", created.ok);
    const roomId = created.roomId;
    const jB = await emitAck(B, "joinGame", { name: "Bob", roomId });
    const jC = await emitAck(Cc, "joinGame", { name: "Caro", roomId });
    ok("2 joueurs rejoignent", jB.ok && jC.ok);
    const ids = { A: created.selfId, B: jB.selfId, C: jC.selfId };
    names.set(ids.A, "Alice"); names.set(ids.B, "Bob"); names.set(ids.C, "Caro");
    const sockById = { [ids.A]: A, [ids.B]: B, [ids.C]: Cc };

    const lb = await waitFor(A, "lobby", (l) => l.players.length === 3);
    ok("lobby porte la config photo", !!lb.photoConfig && !!lb.photoConfig.difficulty);
    A.emit("setPhotoConfig", { difficulty: "normal", sceneAssign: "shared" });
    const lb2 = await waitFor(A, "lobby", (l) => l.photoConfig.sceneAssign === "shared");
    ok("setPhotoConfig (hôte) appliqué", lb2.photoConfig.difficulty === "normal");

    // --- Phase cachette ---
    const hidePromises = [A, B, Cc].map((s) => waitFor(s, "photo:hideStart", null));
    A.emit("startGame");
    const hides = await Promise.all(hidePromises);
    ok("photo:hideStart reçu par les 3", hides.every((h) => h.scene && h.scene.url));
    ok("scène partagée : même id pour tous",
       new Set(hides.map((h) => h.scene.id)).size === 1);

    // Placements connus du test (jamais partagés entre clients).
    const placements = {
      [ids.A]: { x: 0.50, y: 0.55 },
      [ids.B]: { x: 0.25, y: 0.35 },
      [ids.C]: { x: 0.72, y: 0.68 },
    };
    const pA = await emitAck(A, "photo:place", { ...placements[ids.A], flip: false });
    ok("place clampé et accepté", pA.ok && Math.abs(pA.x - 0.5) < 0.01);
    await emitAck(B, "photo:place", { ...placements[ids.B], flip: true });
    await emitAck(Cc, "photo:place", { ...placements[ids.C], flip: false });

    // Confirmation de tous -> la phase se termine en avance.
    // (écouteur posé AVANT les confirms : émissions serveur synchrones)
    const turn1Promise = waitFor(A, "photo:turnStart", null, 15000);
    const progPromise = waitFor(A, "photo:hideProgress", (p) => p.confirmed >= 1, 4000)
      .catch(() => null);
    await emitAck(A, "photo:confirm", {});
    await emitAck(B, "photo:confirm", {});
    await emitAck(Cc, "photo:confirm", {});
    ok("hideProgress diffusé", !!(await progPromise));

    // ------------------------------------------------------------------
    // TOUR 1 : un chercheur rate (verrou), l'autre trouve.
    // ------------------------------------------------------------------
    const t1 = await turn1Promise;
    ok("tour 1 démarre (compositing OK)", typeof t1.imageUrl === "string");
    const hider1 = t1.hider.id;
    const seekers1 = [ids.A, ids.B, ids.C].filter((id) => id !== hider1);
    const s1a = sockById[seekers1[0]], s1b = sockById[seekers1[1]];

    // Image tokenisée : accessible pendant le tour.
    const res200 = await fetch(URL + t1.imageUrl);
    ok("image du tour servie (200, webp)",
       res200.status === 200 && (res200.headers.get("content-type") || "").includes("webp"));
    ok("image non cachable (no-store)",
       (res200.headers.get("cache-control") || "").includes("no-store"));

    // turnStart du cacheur contient SA position ; celui des chercheurs non.
    const t1hider = await new Promise((r) => {
      // le turnStart a déjà été émis ; on le recapture via un 2e listener posé avant ?
      // Non : on vérifie sur les payloads déjà reçus par la sentinelle + le champ direct.
      r(null);
    });
    ok("turnStart chercheur sans position", !("selfPlacement" in t1) || t1.youAre === "hider"
       ? !(t1.youAre === "seeker" && t1.selfPlacement) : false);

    // Mauvais clic -> miss + verrou.
    const miss = await emitAck(s1a, "photo:click", { x: 0.05, y: 0.05 });
    ok("mauvais clic -> miss + essais restants", miss.verdict === "miss" && miss.missesLeft === 2);
    const relock = await emitAck(s1a, "photo:click", { x: 0.06, y: 0.05 });
    ok("re-clic immédiat -> verrouillé", relock.verdict === "locked");

    // L'autre chercheur clique pile sur le cacheur -> hit.
    const endT1 = waitFor(A, "photo:turnEnd", null, 6000);
    const hitRes = await emitAck(s1b, "photo:click", placements[hider1]);
    ok("clic exact -> hit", hitRes.verdict === "hit");
    const e1 = await endT1;
    ok("turnEnd outcome=found + position exacte",
       e1.outcome === "found" &&
       Math.abs(e1.pos.x - placements[hider1].x) < 0.01 &&
       Math.abs(e1.pos.y - placements[hider1].y) < 0.01);
    ok("points du trouveur >= " + C.SCORE_PHOTO_FIND,
       (e1.points[seekers1[1]] || 0) >= C.SCORE_PHOTO_FIND);

    // Token invalidé après le tour.
    await wait(80);
    const res404 = await fetch(URL + t1.imageUrl);
    ok("image du tour invalidée après turnEnd (404)", res404.status === 404);

    // ------------------------------------------------------------------
    // TOUR 2 : les deux chercheurs épuisent leurs 3 essais -> all_exhausted.
    // ------------------------------------------------------------------
    const t2 = await waitFor(A, "photo:turnStart", (t) => t.turnIndex === 1, 8000);
    const hider2 = t2.hider.id;
    const seekers2 = [ids.A, ids.B, ids.C].filter((id) => id !== hider2);
    const endT2 = waitFor(A, "photo:turnEnd", (e) => e.turnIndex === 1, 10000);
    for (const sid of seekers2) {
      for (let i = 0; i < 3; i++) {
        await emitAck(sockById[sid], "photo:click", { x: 0.05 + i * 0.01, y: 0.06 });
        await wait(180); // laisse expirer le verrou (150 ms)
      }
    }
    const e2 = await endT2;
    ok("tour 2 : épuisement des essais -> all_exhausted", e2.outcome === "all_exhausted");
    ok("cacheur non trouvé marque " + C.SCORE_PHOTO_SURVIVE + "+",
       (e2.points[hider2] || 0) >= C.SCORE_PHOTO_SURVIVE);

    // ------------------------------------------------------------------
    // TOUR 3 : personne ne clique -> timeout, puis fin de partie.
    // ------------------------------------------------------------------
    const endPromise = waitFor(A, "photo:gameEnd", null, 12000);
    const e3 = await waitFor(A, "photo:turnEnd", (e) => e.turnIndex === 2, 10000);
    ok("tour 3 : timeout -> le cacheur marque", e3.outcome === "timeout");
    const fin = await endPromise;
    ok("fin de partie : classement à 3 trié", fin.ranking.length === 3 &&
       fin.ranking[0].score >= fin.ranking[1].score);

    // --- Anti-fuite ---
    ok("aucune fuite de position vers un chercheur", leaks.length === 0);
    if (leaks.length) console.log("   fuites:", leaks);

    A.close(); B.close(); Cc.close();
  } catch (e) {
    failed++;
    console.log("  ❌ Exception : " + (e && e.message));
  }
  console.log(`\n===== photo-smoke : ${passed} réussis, ${failed} échoués =====`);
  process.exit(failed === 0 ? 0 : 1);
})();
