# Plank Board for teams

A Cloudflare Worker that serves the Plank Board app behind one shared team password and keeps shared boards in sync live.

Setup guides (pick one):
- `GITHUB-SETUP.txt`: browser only, GitHub + Cloudflare dashboard.
- `TEAM-SETUP.txt`: with a terminal (`npm install`, `npx wrangler deploy`).

- `src/worker.js` the password page, routes, board list and backups (D1). `src/auth.js` the password check and signed cookie. `src/board.js` one Durable Object per board: applies changes in one order and broadcasts them over WebSockets, keeps activity and hourly backups.
- `shared/ops.js` the change operations, used by both the server and the app so they always agree.
- `client/team.js` the team layer of the app. `app/index.html` is the app itself. `build-app.py` joins them and writes `public/index.html` (the file that is served; it is committed, so deploying needs no build step).
- `test/` unit, server, password, two-browser, restart and login tests (`npm test` runs the quick ones; the others need `test/fresh-server.sh`).
