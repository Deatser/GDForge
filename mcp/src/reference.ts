// Quick reference for building playable classic sections. The physics numbers
// were measured in-game with automated test runs by GD AI Bridge (RibomDev,
// MIT, see THIRD_PARTY.md): cube, normal gravity, level units (30 = 1 block).

export const REFERENCE = {
  commonObjectIds: {
    blocks: "1 default block",
    hazards: "8 spike, 39 small spike",
    pads: "35 yellow, 140 pink, 67 blue (gravity)",
    orbs: "36 yellow, 141 pink, 84 blue (gravity)",
    gamemodePortals: "12 cube, 13 ship, 47 ball, 111 ufo, 660 wave, 745 robot, 1331 spider, 1933 swing",
    otherPortals: "10 gravity normal, 11 gravity flip, 45 mirror on, 46 mirror off, 99 normal size, 101 mini",
    speed: "200 slow, 201 normal, 202 fast, 203 faster, 1334 fastest",
    triggers: "899 color, 901 move, 1006 pulse, 1007 alpha, 1049 toggle, 1268 spawn, 1346 rotate",
    misc: "31 start position",
  },
  // Lengths are takeoff to landing on flat ground; heights are above the ground
  physics: {
    cubeJump: "height ~64 at every speed; length: slow 106, normal 136, fast 176, faster 206, fastest 252",
    pads: "yellow pad: height 131, length 189; pink pad: height 55, length 124 (normal speed, triggered ~25 before its centre)",
    orbs: "yellow orb: same arc as a normal jump (64 / 130); pink orb: height 33, length 91 (normal speed)",
    ship:
      "holding from the ground at normal speed: +2 after 15 units, +24 after 60, +90 after 120, +131 after 150; " +
      "after releasing it keeps rising ~70 more over ~120 units before falling",
    timingTip: "to clear one spike at normal speed, tap ~60 units before its x; the player hitbox is about one block",
  },
};
