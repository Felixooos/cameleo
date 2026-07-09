/*
 * Constantes partagées serveur <-> client.
 * Chargé en CommonJS (server) ET en <script> classique (navigateur).
 */
(function (root, factory) {
  const C = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = C; // Node / server
  } else {
    root.SHARED = C; // navigateur -> window.SHARED
  }
})(typeof self !== "undefined" ? self : this, function () {
  const C = {
    // Monde (unités = pixels monde). Carré pour simplifier la caméra.
    WORLD_W: 3200,
    WORLD_H: 3200,

    // Joueurs
    PLAYER_RADIUS: 18, // rayon du bonhomme en unités monde
    MAX_HIDERS: 10,
    HIDER_SPEED: 230, // px/s en phase de chasse
    PREP_SPEED: 320, // déplacement plus rapide pendant le placement
    HUNTER_SPEED: 250,

    // Phases (ms)
    PREP_TIME_MS: 120000, // 2 min de préparation
    HUNT_TIME_MS: 180000, // 3 min de chasse
    SCORE_INTERVAL_MS: 15000, // maj des points toutes les 15 s

    // Tir
    SHOOT_COOLDOWN_MS: 2000, // recharge 2 s
    SHOOT_RANGE: 360, // portée du tir (le "range" autour du chasseur)
    SHOOT_CONE_DEG: 22, // demi-angle du cône de tir (tolérance de visée)

    // Score : plus on est proche du chasseur, plus on marque
    SCORE_MAX_DIST: 900, // au-delà : 0 point ce tick
    SCORE_MAX_POINTS: 100, // collé au chasseur : 100 points / tick
    SCORE_SURVIVE_BONUS: 10, // bonus de survie par tick pour tout cacheur vivant

    // Réseau
    TICK_RATE: 20, // broadcasts d'état par seconde

    // Rendu / camouflage
    OUTLINE_WIDTH: 2.5, // contour minimal toujours visible (lisibilité)
    SPRITE_SIZE: 160, // résolution du sprite peint (px) — assez fin pour peindre en zoomant
    CHAR_WORLD_SIZE: 48, // taille du bonhomme en unités monde (côté du sprite)
    MIN_ZOOM: 0.5,
    MAX_ZOOM: 12.0, // zoom molette max (pour peindre fin / zoomer sur soi)

    // Modes
    MODE_NORMAL: "normal",
    MODE_INFECTED: "infected",
    MODE_PHOTO: "photo", // cache-cache photo, tour par tour

    // --- Mode photo ---
    PHASE_PHOTO_HIDE: "photo_hide",
    PHASE_PHOTO_TURN: "photo_turn",
    PHASE_PHOTO_REVEAL: "photo_reveal",
    PHOTO_HIDE_MS: 60000, // placement + camouflage
    PHOTO_TURN_MS: 45000, // durée max d'un tour de recherche
    PHOTO_REVEAL_MS: 6000, // révélation + scoreboard entre les tours
    PHOTO_LOCK_MS: 1500, // verrou curseur après un mauvais clic
    PHOTO_MAX_MISSES: 3, // essais max par tour, ensuite spectateur
    PHOTO_TOLERANCE_PX: { easy: 20, normal: 14, hard: 9 }, // en espace scène
    PHOTO_SCENE_W: 1920,
    PHOTO_SCENE_H: 1080,
    PHOTO_CHAR_SCALE: { easy: 0.13, normal: 0.10, hard: 0.075 }, // hauteur perso / hauteur scène
    PHOTO_MIN_PLAYERS: 2,
    PHOTO_MAX_PLAYERS: 8,
    // Scoring photo
    SCORE_PHOTO_FIND: 100, // premier clic juste
    SCORE_PHOTO_SPEED_MAX: 50, // bonus proportionnel au temps restant
    SCORE_PHOTO_SURVIVE: 120, // cacheur jamais trouvé
    SCORE_PHOTO_PER_MISS: 5, // par raté adverse (cap ci-dessous)
    SCORE_PHOTO_MISS_CAP: 25,
    SCORE_PHOTO_TENURE_MAX: 40, // cacheur trouvé : prorata du temps tenu

    // Phases serveur
    PHASE_LOBBY: "lobby",
    PHASE_PREP: "prep",
    PHASE_HUNT: "hunt",
    PHASE_ENDED: "ended",

    // Rôles
    ROLE_HIDER: "hider",
    ROLE_HUNTER: "hunter",

    MAP_SEED: 1337, // graine de génération (identique partout)
  };
  // Overrides côté serveur (Node) via variables d'environnement — utile pour
  // les tests automatisés (préparation/chasse raccourcies). Sans effet en navigateur.
  if (typeof process !== "undefined" && process && process.env) {
    const env = process.env;
    if (env.PREP_MS) C.PREP_TIME_MS = +env.PREP_MS;
    if (env.HUNT_MS) C.HUNT_TIME_MS = +env.HUNT_MS;
    if (env.SCORE_MS) C.SCORE_INTERVAL_MS = +env.SCORE_MS;
    if (env.PHOTO_HIDE_MS) C.PHOTO_HIDE_MS = +env.PHOTO_HIDE_MS;
    if (env.PHOTO_TURN_MS) C.PHOTO_TURN_MS = +env.PHOTO_TURN_MS;
    if (env.PHOTO_REVEAL_MS) C.PHOTO_REVEAL_MS = +env.PHOTO_REVEAL_MS;
    if (env.PHOTO_LOCK_MS) C.PHOTO_LOCK_MS = +env.PHOTO_LOCK_MS;
  }
  C.SCORE_TICK_MS = C.SCORE_INTERVAL_MS;
  return C;
});
