# 3D Maps Fly-Through — London & Monaco

The same tours as [`../3d-tiles-flythrough`](../3d-tiles-flythrough), but rendered by Google's own **Photorealistic 3D Maps** web component ([`Map3DElement`](https://developers.google.com/maps/documentation/javascript/reference/3d-map), Maps JavaScript API) instead of raw 3D Tiles in Three.js.

Camera choreography uses the built-in [`flyCameraTo` / `flyCameraAround`](https://developers.google.com/maps/documentation/javascript/3d/animate-camera) animations — each stop is a look-at target (landmark) rather than a camera position, and the final landmark of each city gets a slow one-round orbit before the tour loops. Interacting with the map pauses the tour; the **Tour** button resumes it. **Labels** toggles Google's place labels (hybrid vs clean satellite mode).

## Running it

1. Get a Google Maps Platform API key with the **Maps JavaScript API** enabled — [instructions](https://developers.google.com/maps/documentation/javascript/get-api-key). (The tiles demo needs the *Map Tiles API* instead; one key can have both enabled.)
2. Open `index.html` in a browser — no build step or server needed.
3. Paste the key (stored only in localStorage; `?key=...` also works) and pick a city.

## Tiles vs Maps — why both demos exist

| | 3D Tiles + Three.js | 3D Maps (`Map3DElement`) |
|---|---|---|
| Renderer | Yours (full control) | Google's (closed) |
| Sky/atmosphere | Build it yourself | Built in |
| Camera animation | Build it yourself | `flyCameraTo`/`flyCameraAround` |
| Custom shaders, post-fx, physics, collision | Yes | No |
| Markers, polylines, glTF models | Via Three.js | Built-in elements |
| WebXR | Yes | No |
| Status / pricing | GA, metered Map Tiles API | Preview (no cost during preview; Pro SKU at GA) |

Short version: 3D Maps is the fastest, prettiest way to *look at* the world; 3D Tiles is the only way to *play in* it (physics car, collisions, custom rendering).
