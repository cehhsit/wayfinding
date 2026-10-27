# Touchscreen Wayfinding for Appspace / BrightSign

A self-contained HTML wayfinding app for landscape touchscreen signs. Visitors search or browse a directory, and the screen shows an animated route from **You are here** to the room on your floorplan images, with turn-by-turn directions across floors and buildings. Staff build and maintain the maps in a browser-based editor; nobody has to hand-edit JSON.

There is no backend, database or build step. You copy the folder to any web server.

```
wayfinding/
├── index.html          ← kiosk app (what the signs load)
├── admin.html          ← map editor (staff only)
├── css/  js/           ← app code (js/vendor = pdf.js + JSZip, bundled so there are no CDN calls)
└── data/
    ├── config.json     ← the map: floors, rooms, hallways, signs, settings
    ├── config.js       ← same data, used as a fallback when fetch() isn't available
    └── floors/         ← floorplan images
```

The `data/` folder ships with a demo map (two buildings, three floors) so you can try everything right away.

---

## 1. Try it locally (2 minutes)

```bash
cd wayfinding
python3 -m http.server 8080
```

* Kiosk: <http://localhost:8080/index.html?sign=lobby-kiosk>
* Second demo sign (floor 2): <http://localhost:8080/index.html?sign=floor2-elevator-kiosk>
* Editor: <http://localhost:8080/admin.html>

Opening `index.html` straight from disk also works, because it falls back to `data/config.js`. Use a web server for real deployments.

## 2. Deploy to your web server

Copy the whole `wayfinding/` folder to any static web host: IIS, Apache, nginx, or a campus web space. Requirements:

* It must serve `.json`, `.js`, `.svg`, `.png` and `.jpg` files with the normal MIME types. On IIS, add a MIME map for `.json` (`application/json`) if one isn't there already.
* Use **HTTPS** if Appspace or your players require it.
* **Protect `admin.html`** with web-server authentication (or keep it off the public server). It can't change anything on the server by itself, but it doesn't need to be public.
* Tell the server not to cache `data/config.json` for long, so map updates reach the signs (for example `Cache-Control: no-cache` on `/data/`).

## 3. Point each Appspace display at its sign

Every physical screen is a **sign** in the map, and the sign sets the *You are here* point. Each display loads the kiosk URL with its own sign ID:

```
https://YOUR-SERVER/wayfinding/index.html?sign=lobby-kiosk&cursor=0
```

In Appspace, add this URL as web content (the **Web View** card, which Appspace lists as supported on BrightSign) and assign it to the channel for that display. Each display location needs its own URL/channel, or its own card with a different `?sign=`. The editor shows the exact URL for each sign (select a sign → *Kiosk URL for this display* → Copy).

> ⚠️ **Test touch first.** Appspace documents that interactivity is *not* supported on BrightSign for some of its own interactive cards (room booking, schedule board). Before you map the whole building, load the demo URL on one of your BrightSign/Appspace players and confirm that taps, scrolling and pinch-zoom reach the page.
>
> If touch does not pass through Appspace on your players, these fallbacks need no changes to the app:
> 1. **BrightSign natively:** in BrightAuthor:connected, create a presentation with an **HTML widget** pointed at the same URL, with touch/mouse events enabled. You can schedule it alongside or instead of Appspace on those units.
> 2. **A different player for the touch screens** (a small Windows/ChromeOS/Android player running Appspace or plain Chrome in kiosk mode), keeping BrightSign for the non-interactive signage.

### URL options

| Parameter | Example | Purpose |
|---|---|---|
| `sign` | `sign=lobby-kiosk` | Which sign this screen is. Required for each display. |
| `cursor` | `cursor=0` | Hides the mouse pointer (recommended on touchscreens). |
| `idle` | `idle=60` | Seconds of inactivity before returning to the home screen (overrides the map setting). |
| `config` | `config=/maps/east/config.json` | Load a different map file (for example, one per building). |

If a display has no `?sign=` and the map has no default sign, the kiosk asks which location it is and remembers the answer on that device. To change it later, **press and hold the title for 4 seconds**.

## 4. Build your own map in the editor

Open `admin.html` in Chrome or Edge on a desktop.

> **Your map saves itself into this folder.** The first time you open `admin.html` (in Edge or Chrome), choose this wayfinding folder. From then on, every change is written to `data/` within a second: `config.json`, `config.js` and the floorplan images. A timestamped copy goes into `data/backups/` every 10 minutes and before any big change, and the last 40 are kept. The header shows "✓ All changes saved". After a browser restart, click **Reconnect** once; the browser requires that before the editor can write to the folder again. Because the map lives in the folder, opening `index.html` from the same folder always shows the latest map, and copying the whole folder to the web server deploys it. A copy of the folder in OneDrive also gets OneDrive's version history. **Save copy…** downloads a single-file backup whenever you want one.

1. **Floors tab → Add floor.** Upload a PNG, JPG, SVG or **PDF** floorplan (PDFs are rendered to a ~3000 px image; you pick the page). Set the floor's name, building and level number on the right.
2. **Scale (M).** Click both ends of something with a known length and enter its length in feet. Directions then say "walk about 120 ft". Without a scale, directions leave out distances.
3. **Path (P).** Trace the walkable hallways. With **Center in hallway** on (the default), each click snaps to the middle of the white hallway between the walls, so you don't need to click precisely; hold **Alt** to place a point exactly where you click. For paths drawn earlier, select the floor and click **Center paths in hallways** (undo with Ctrl+Z). Centering reads the floorplan image: it works best when hallways are white or near-white and rooms are colored or walled off. Open areas wider than a hallway (lobbies, courtyards) are left alone. Each click adds a point joined to the last one. Clicking near an existing point or line joins it (snaps within a few pixels). Hold **Shift** to snap to 45°, and press **Esc** to finish a line. Give important points a landmark name (*the Main Lobby*, *the Atrium*) so directions can say "turn left at the Atrium".
4. **Room (R).** Click at each room's door. The room connects itself to the nearest hallway. Then fill in its name, number, category and search keywords.
5. **Sign (S).** Click where each display is mounted. Set **Viewer faces** to the direction someone is looking while reading the screen, so the first step can say "head to your left" instead of just "follow the route".
6. **Connector (C).** Mark elevators, stairs, escalators, ramps, skybridges and building doors on **every floor they serve**, and put them in the **same group** on each floor. Choose the group from the dropdown, or pick *+ New group…* the first time. A new connector suggests the closest matching group of the same type, and the editor flags any group that mixes stairs with an elevator. Stairs and escalators are skipped when a visitor turns on *Accessible route*. To flag a single hallway segment with steps, select it and tick *Not wheelchair accessible*.
7. **Test.** Select any room and click **Show route** to see the path and the exact wording. **Preview kiosk** opens the real kiosk UI with your unsaved draft.
   > **"No route" in preview?** A room or the sign isn't joined to the hallway lines, or two hallway lines look like they meet but don't. Unconnected places show a **red dashed ring** in the editor. The **Check** tab lists them and has a one-click *Connect them to the nearest hallway* fix. It also warns when a floor's hallways are in separate pieces.
8. **Check tab.** Finds rooms that a sign can't reach, connectors with no matching floor, unscaled floors and similar problems. Click an issue to jump to it.
9. **Deploy.** Copy the whole folder to the web server, or use **Export package (.zip)** and unzip it into the server's `data/` folder, replacing `config.json`, `config.js` and `floors/`. The signs pick up the new map automatically (Settings → *check for updates every N minutes*) when nobody is using them, without restarting the player.

To edit the live map later, open `admin.html` on the server and click **Load from server**. You can also **Open…** a previously exported zip or JSON.

Shortcuts: `V P R S C L X M` switch tools · `Ctrl+Z / Ctrl+Y` undo/redo · `Delete` removes the selection · drag on empty space or hold `Space` to pan · scroll to zoom.

## 5. How routing works

* The map is a graph. Hallway points, rooms, signs and connectors are nodes, and the lines you draw are edges. Routes use Dijkstra's shortest path, weighted by real distance when the floor has a scale.
* **Stairs first:** by default, routes between floors use the stairs that give the shortest overall trip, and elevators appear only when the visitor taps *Accessible route*. If a place can only be reached by elevator, the elevator route is shown with a note. Turn this off in Settings (*Route between floors by stairs*) to let the router choose freely between stairs and elevators. Accessible mode skips stairs, escalators and any segment marked *not accessible*.
* Directions come from the route geometry: turns of 30–60° become "bear left/right", turns of 60–145° become "turn left/right", and anything larger is "turn around". Tiny jogs in the path are ignored. The last step tells visitors which side of the hallway the door is on.

## 6. Kiosk behaviour

* Designed for 1920×1080 landscape. Everything scales with the screen width.
* On-screen keyboard, category filters, large touch targets, and pinch/drag zoom on the map.
* Multi-floor routes are split into stages with a **Next** button. If the visitor stops touching the screen, the kiosk moves to the next stage on its own.
* Resets to the home screen after the idle timeout (90 s by default).
* The JavaScript is written to ES2017 and avoids newer CSS, so it runs on older BrightSign Chromium builds.

## 7. Ideas for next steps

* **"Take it with you" QR code:** a phone-friendly copy of the route reached by scanning the screen (add a QR library and a `?from=&to=` deep link).
* **Room schedules:** show what's on in a room today by pulling from your calendar/Appspace room data.
* **Search analytics:** log what people search for and don't find, to improve keywords and signage.
* **Multiple languages** and an **attract loop** for when the screen is idle.
