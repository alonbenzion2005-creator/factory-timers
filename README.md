# ⏱ Factory Timers

A shared, real-time timer board for two (or more) phones. Start / pause / reset
and set up timers on one phone — the other phone updates instantly. Dark mode,
a different color per timer, big readable digits, and an alarm (beep + vibrate)
when a timer hits zero.

---

## What's in the box

| File | What it does |
|------|--------------|
| `server.js` | Server + real-time sync. Saves to Postgres when `DATABASE_URL` is set, else to a local file |
| `index.html` | The page |
| `styles.css` | Dark theme + colors |
| `app.js` | Timer UI + countdown logic |
| `backend.js` | Sync layer — auto-picks the server or Firebase |
| `config.js` | Firebase keys (only needed for the optional Firebase mode) |
| `package.json` | Dependencies (`pg`) + `npm start`, for hosting |
| `render.yaml` | Render blueprint — how Render builds & runs the app |

There are two ways to run it. **Start with the local network one — it works
right now with no accounts.**

| Mode | Reaches | Needs |
|------|---------|-------|
| **Local network** (start here) | Both phones on the **same WiFi** | Node on this Mac. No internet, no accounts. |
| **Firebase** (later) | Phones **anywhere**, any network | A free Firebase project + hosting. |

The app auto-detects which one is available — you don't change any code to
switch. When the local server (`server.js`) is running, it uses that. Otherwise
it falls back to Firebase (if `config.js` is filled in).

---

## ▶ Local network — quick start (no accounts)

**Requirements:** this Mac and both phones on the **same WiFi**, and Node
installed (check with `node -v`; if missing, get it from nodejs.org).

1. Open Terminal in this folder and run:
   ```
   node server.js
   ```
2. It prints something like:
   ```
   On the phones (same WiFi), open:
      →  http://192.168.1.88:8080
   ```
3. Open that `http://192.168.1.xx:8080` address on **both phones**.
   Add it to the Home Screen if you want it to feel like an app.
4. Create a timer on one phone — it appears and counts down on the other
   instantly. Leave the Terminal window running; closing it stops the sync.

That's the whole local setup. Timers are saved to `.timers-data.json`, so
restarting the server keeps them. The rest of this README (Firebase) is only
for when you want the timers reachable from outside the factory's WiFi.

> **Note:** the two phones must reach this Mac. Some workplace/guest WiFi
> networks block device-to-device traffic ("client isolation"). If a phone
> can't load the page, that's usually why — a normal home/office router or a
> phone hotspot works fine.

---

## 🌐 Put it online — GitHub → Neon → Render

This hosts the app at a public `https://…onrender.com` link that works from
**any network** (mobile data included), with timers saved permanently in a free
Postgres database. No code changes needed — `server.js` automatically uses
Postgres once Render gives it a `DATABASE_URL`.

Everything here is free. You'll need accounts on **GitHub**, **Neon**, and
**Render** (sign into all three with your Google/GitHub login to keep it quick).

### 1. Push the code to a private GitHub repo
From this folder:
```
git init
git add .
git commit -m "Factory Timers"
```
Create an **empty private repo** on github.com (no README/.gitignore — this
folder already has them), then run the two lines GitHub shows you, e.g.:
```
git remote add origin https://github.com/<you>/factory-timers.git
git branch -M main
git push -u origin main
```
> Safe to commit: `config.js` only has empty placeholders, and `.gitignore`
> keeps `node_modules` and the local data file out. Your database password is
> **not** in the repo — it lives only in Render's settings (step 4).

### 2. Create a free Neon Postgres database
1. Go to **https://neon.tech** → sign up → **Create project** (any name).
2. On the project dashboard, find **Connection string** and copy it. It looks
   like:
   ```
   postgresql://user:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require
   ```
   Keep it handy for step 4. (The app creates its table automatically on first
   run — you don't need to make any tables in Neon.)

### 3. Create the app on Render from the repo
1. Go to **https://render.com** → sign in with GitHub.
2. **New +** → **Blueprint**.
3. Pick your `factory-timers` repo. Render detects `render.yaml` and shows a
   service named **factory-timers** on the **Free** plan.
4. Click **Apply** / **Create**.

### 4. Give Render the database connection string
Because `render.yaml` marks `DATABASE_URL` as “set this yourself”, Render asks
for it during creation (or set it after):
1. On the **factory-timers** service → **Environment** tab.
2. Add / confirm the variable:
   - **Key:** `DATABASE_URL`
   - **Value:** the Neon connection string from step 2.
3. **Save Changes** — Render redeploys automatically.

### 5. Open the live link
When the deploy finishes (first build takes a couple of minutes), Render shows a
URL like **`https://factory-timers.onrender.com`**. Open it on both phones —
from any network — and add it to the Home Screen. Done.

#### Good to know on Render's free plan
- **One instance** (which is exactly what the live-sync needs) and it **sleeps
  after ~15 min of no traffic**. The next visit takes ~30s to wake up, then it's
  instant again. Your timers are safe in Neon across sleeps and redeploys.
- To **update** the app later: `git push` — Render redeploys automatically.
- Same as before, the **room name** is the shared key. Anyone who opens the URL
  *and* knows your room name shares your timers; pick a non-obvious room name if
  that matters.

---

## Firebase — reach the phones from anywhere (optional alternative)

This removes the need for your Mac to be on and lets the phones sync over any
network (mobile data included). Setup is ~5 minutes, free, no credit card.

### 1. Create a free Firebase project
1. Go to **https://console.firebase.google.com** and sign in with a Google account.
2. Click **Add project**, give it a name (e.g. `factory-timers`), continue.
   You can disable Google Analytics — it's not needed. Click **Create project**.

### 2. Turn on the Realtime Database
1. In the left menu: **Build → Realtime Database**.
2. Click **Create database** → pick the location closest to you → **Next**.
3. Choose **Start in test mode** → **Enable**.
   - Test mode lets the phones read/write for 30 days. To keep it working
     afterward, see **"Keep it working past 30 days"** below.

### 3. Get your config keys
1. Click the **⚙ (gear) → Project settings** (top-left).
2. Scroll to **Your apps** → click the **`</>`** (Web) icon.
3. Give it a nickname, click **Register app**.
4. Firebase shows a snippet with `const firebaseConfig = { ... }`. Keep it open.

### 4. Paste the keys into `config.js`
Open `config.js` and replace every `PASTE_…` value with the matching value from
Firebase. It should end up looking like:

```js
export const firebaseConfig = {
  apiKey: "AIzaSyD...your-real-key...",
  authDomain: "factory-timers.firebaseapp.com",
  databaseURL: "https://factory-timers-default-rtdb.firebaseio.com",
  projectId: "factory-timers",
  storageBucket: "factory-timers.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:1234...:web:abc123",
};
```

> If your Firebase snippet has **no** `databaseURL` line, copy the URL shown at
> the top of the Realtime Database page (looks like
> `https://...-default-rtdb.firebaseio.com`).

Save the file. You're done with setup.

---

## Put it on the two phones (free hosting)

Both phones just need to open the **same URL**. Easiest free option:

### Option A — Netlify Drop (no account drag-and-drop)
1. Go to **https://app.netlify.com/drop**.
2. Drag this whole folder onto the page.
3. It gives you a URL like `https://shiny-name-123.netlify.app`.
4. Open that URL on both phones. Optionally "Add to Home Screen" so it feels
   like an app.

### Option B — Vercel
1. Install once: `npm i -g vercel`
2. In this folder, run: `vercel` (follow the prompts). It returns a URL.

### Option C — GitHub Pages
1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Deploy from branch → main / root**.
3. Use the `https://USERNAME.github.io/REPO/` URL it gives you.

---

## How to use it

- **+** (bottom-right): add a timer — name it, set hours/min/sec, pick a color.
- **Start / Pause**: toggle the countdown. Both phones stay in sync.
- **Reset**: back to the set duration.
- **✎**: edit name, duration, color, or delete the timer.
- **room chip** (top-right): the shared channel name. **Both phones must use the
  same room name.** Change it to keep separate sets of timers (e.g. `line-a`,
  `line-b`). The default is `factory`.
- When a timer reaches zero it flashes, beeps, and vibrates. (Tap the screen
  once after loading so the phone allows sound.)

Timers keep running on the server clock, so closing and reopening the page — or
a phone going to sleep — won't lose time. The countdown is corrected for clock
differences between the two phones.

---

## Keep it working past 30 days

Test mode rules expire after 30 days. To keep it running, set simple rules.
In **Realtime Database → Rules**, replace with:

```json
{
  "rules": {
    "rooms": {
      ".read": true,
      ".write": true
    }
  }
}
```

This is fine for a small private tool. The **room name acts as your password** —
anyone who doesn't know it can't see your timers. For stronger security you'd
add Firebase Authentication, but for a two-phone factory tool this is enough.

---

## Troubleshooting

- **A setup screen appears instead of the timers** → `config.js` still has
  `PASTE_…` placeholders. Finish step 4.
- **Timers don't sync between phones** → make sure both phones show the **same
  room name** in the top-right chip, and that both have a green status dot.
- **No sound** → mobile browsers block audio until you tap the page once. Tap
  anywhere after it loads. Vibration still works.
- **Red status dot** → no connection to Firebase; check the `databaseURL` in
  `config.js` and your internet.
