# Deploying Eastern Gate on Render (so nothing disappears)

## Why accounts kept disappearing

Two things, both now fixed in the code:

1. **`backend/data.json` was committed to git.** Every deploy replaced the live
   file with the copy in the repo — which had no admin, no sellers, no sales.
   It is now in `.gitignore` and removed from the repo.
2. **Render's normal filesystem is temporary.** Anything the app writes is
   erased on every deploy, restart and (on the free plan) every time the service
   goes to sleep. The only thing that survives is a **Persistent Disk**.

The server is still the source of truth and still uses `data.json` — it just has
to live on a disk that survives. That is what `DATA_DIR` does.

## One-time setup

> **A Persistent Disk requires a paid Render web service (e.g. Starter).
> The free plan cannot keep data, whatever the code does.**

1. Push this project to GitHub (the old `backend/data.json` is gone from it).
2. In Render, open your Web Service → **Disks → Add Disk**
   - Name: `eastern-gate-data`  ·  Mount path: `/var/data`  ·  Size: 1 GB
3. **Environment** tab → add:
   | Key | Value |
   |---|---|
   | `DATA_DIR` | `/var/data` |
   | `JWT_SECRET` | a long random string. Set once, **never change it** (changing it signs everyone out) |
   | `NODE_ENV` | `production` |
   | `PUBLIC_BASE_URL` | *(optional)* `https://your-site.onrender.com` — the address printed in table QR codes |
4. Build command `npm install`, start command `npm start`, root directory `backend`.
   (Or use the included `render.yaml` as a Blueprint, which sets all of this.)
5. Deploy. Open the site, register the Admin **one last time** — your previous
   data was already lost on the old setup and cannot be recovered by code.

## Check that it worked

- Open `https://your-site/api/health` → it must say `"persistent": true`.
- Log into Admin. If storage is *not* persistent, a red warning banner shows on the
  Dashboard, and the server log prints `WARNING: data is NOT stored on a persistent disk`.
- Real test: create a seller, then in Render click **Manual Deploy → Deploy latest commit**.
  Reload the site — the Admin login page must show **login** (not register) and the
  seller must still be there.

## Good to know

- **One instance only.** A Render disk attaches to a single instance, so don't scale the service to 2+.
- Every save is atomic and the previous good copy is kept as `data.json.bak`. If
  `data.json` is ever unreadable, the server moves it aside as `data.json.corrupt-<time>`
  and recovers from the backup instead of starting empty.
- Print/download QR codes from **Admin → Tables & QR** *while visiting the Admin page from your
  real website address* (not localhost), otherwise the QR codes will point to the wrong place.
- Regularly use **Reports → Export to Excel** as an extra off-server copy of your sales.

## Running locally

```
cd backend
cp .env.example .env      # then edit JWT_SECRET
npm install
npm start                 # http://localhost:3000
npm test                  # end-to-end test incl. hard restart & corrupt-file recovery
```
