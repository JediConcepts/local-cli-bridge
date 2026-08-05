# Monaco Drive — driving on Google Photorealistic 3D Tiles

Proof that you can *drive* the streamed photogrammetry mesh, not just fly over it. An arcade car spawns on Boulevard Albert 1er and laps the Grand Prix corners as checkpoint rings: Sainte-Dévote → Beau Rivage → Casino Square → Fairmont Hairpin → Portier → Nouvelle Chicane → Piscine → La Rascasse → finish, with a lap timer.

**Controls:** W/S throttle & brake · A/D steer · C camera (chase / close / hood) · R reset to the start line.

## How the driving works

- The car's state is a position in Earth-centered (ECEF) coordinates plus a compass heading; each frame the local east/north/up frame is rebuilt from the ellipsoid, a bicycle-model step advances the car, and a **downward raycast against the streamed tile mesh** (`raycaster.firstHitOnly`, tiles BVH fast path) clamps it to the road surface.
- Checkpoint rings ground-clamp themselves lazily, raycasting once their tiles stream in.
- The mesh has **no road semantics** — the start line had to be found empirically. `window.__probe(lat, lon)` is exposed as a dev helper: it returns the mesh's ellipsoid height at a coordinate, which is how the road corridor (~52–54 m here) was separated from rooftops (60–105 m) when tuning the spawn.

## Honest limitations (what "possible" means)

- **No walls**: the car passes through buildings and barriers. Track limits would need an authored corridor (e.g. OSM road centerlines widened into invisible guardrails).
- **The tunnel is a hill**: aerial photogrammetry has no interiors, so the famous tunnel section is a solid lump — the car drives over its roof.
- **Street-level melt**: parked cars, trees, and railings are baked into the mesh as blobs; this data looks best from 30 m+ up.
- **Simplified physics**: ground clamping with smoothing, not rigid-body dynamics. The production path is Rapier with trimesh colliders built per streamed tile.

Same setup as the fly-through demo: open `index.html`, paste a Map Tiles API key (stored in localStorage, `?key=` also works), Drive Monaco. Street-level driving pulls high-LOD tiles aggressively, so it consumes noticeably more Map Tiles quota than the fly-over.
