# 3D Tiles Fly-Through — London & Monaco

A single-file Three.js demo that streams [Google Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/3d-tiles-overview) and flies a cinematic camera along:

- **London** — the Thames from Tower Bridge past The Shard, St Paul's, the London Eye and Big Ben to Buckingham Palace.
- **Monaco** — the Grand Prix line: Sainte-Dévote, the Beau Rivage climb, Casino Square, the Fairmont Hairpin, the tunnel section, Piscine and La Rascasse.

Drag / right-drag / scroll at any time to take over the camera (globe controls); the **Tour** button resumes the fly-through. This is the "track view" groundwork for a driving game — the same tileset a physics car would drive through.

## Running it

1. Get a Google Maps Platform API key with the **Map Tiles API** enabled — [instructions](https://developers.google.com/maps/documentation/tile/get-api-key).
2. Open `index.html` in a browser (double-clicking the file works; no build step or server needed).
3. Paste the key (stored only in your browser's localStorage; you can also pass `?key=...` in the URL).
4. Pick **Fly London** or **Fly Monaco**.

## How it works

- [`3d-tiles-renderer`](https://github.com/NASA-AMMOS/3DTilesRendererJS) (NASA-AMMOS) streams and LODs the global tileset; `GoogleCloudAuthPlugin` handles the Map Tiles API session.
- Waypoints are lat/lon/ellipsoid-height triples converted to ECEF via `WGS84_ELLIPSOID`, joined into a centripetal Catmull-Rom spline; the camera moves along it at constant speed with a look-ahead focus point.
- `GlobeControls` provides free navigation against the actual globe when the tour is paused.
- Draco decoding, tile compression, fade-in LOD transitions and tile unloading are enabled via the library's plugins.
- Everything loads from CDN via an import map — no dependencies to install.

Note: tile streaming is metered by Google's Map Tiles API pricing; casual exploration fits comfortably in the free monthly credit, but keep the key restricted (HTTP referrer) if you deploy this anywhere public.
