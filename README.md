# LearnerAI

Every concept in Artificial Intelligence, in one connected flow. Over 26,000 topics, from linear algebra to agentic AI and AGI, laid out as a map you open stone by stone. No explanations, only the map: what exists, where it sits, and what to learn next.

## Run locally

```
npm start
```

Then open http://localhost:3000. There are no dependencies to install; Node 18 or newer is enough.

`npm start` runs two steps you can also run on their own:

```
npm run build   # turns content/*.txt into public/tree.json
npm run serve   # starts the server
```

## Using the map

- Click or tap a stone to open or close it. Shift + click opens or closes the whole branch beneath it.
- Click a leaf to mark it learned. When every leaf under a stone is learned, that stone lights up automatically. Un-ticking a leaf clears it again.
- Drag to pan. The mouse wheel zooms around the cursor; a trackpad scrolls, and pinching zooms. The mouse button in the zoom controls switches the wheel to scrolling if you prefer.
- Keyboard: `/` or Ctrl+K to search, `+` and `-` to zoom, `0` to return to the start, arrow keys to pan.
- Expand all and Collapse all are in the header.
- Progress is stored in the browser. Sign in to sync it to your account.

## How it works

- `content/*.txt` holds the concept outlines, one concept per line, indented two spaces per level. Edit or add files here, then rebuild. See `content/FORMAT.md`.
- `build.js` merges all outlines under the root "Artificial Intelligence", removes duplicate siblings, and writes `public/tree.json`.
- `server.js` is a zero-dependency static server plus a small JSON API: `/api/signup`, `/api/login`, `/api/logout`, `/api/me`, `/api/progress`, `/api/health`. Users and sessions are stored as JSON in `data/`, with scrypt-hashed passwords. Set `DATA_DIR` to store them somewhere else.
- `public/` is the single-page UI in plain HTML, CSS and JavaScript. Only the stones on screen exist in the page and the connecting lines are drawn on a canvas, so the map stays smooth even with everything expanded.

## Deploy on Render

1. Push this repository to GitHub.
2. In the Render dashboard choose **New → Web Service** and connect the repository.
3. Use these settings:
   - Language: **Node**
   - Build command: `npm run build`
   - Start command: `npm run serve`
4. Create the service. Render sets `PORT` automatically and the server reads it.

Accounts are saved to `data/users.json`. Render's free instances have a temporary disk, so accounts and synced progress are wiped on every deploy or restart. Progress still survives in each visitor's browser. To keep accounts permanently:

1. Switch the service to a paid instance type.
2. Under **Disks**, add a disk with mount path `/var/data`.
3. Under **Environment**, add `DATA_DIR` with the value `/var/data`.
