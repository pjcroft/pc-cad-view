# PC CAD View

Browser-based 3D CAD viewer for the pjcroft web tools, aimed at sheet metal assemblies.
Files are processed in the visitor's browser; nothing is uploaded.

## Screenshots

**3D view: sheet metal part with file properties (material, thickness, flat blank)**
![3D view with sheet metal data](mockup/2-3d-sheet-metal.png)

**Nesting: how many blanks fit on one sheet**
![Nesting, fill one sheet](mockup/3-nesting-fill-sheet.png)

**Nesting: sheets needed for a production run**
![Nesting, quantity run](mockup/4-nesting-quantity-run.png)

**Inch-drawn model: detected automatically, shown in inches**
![Inch model in 3D view](mockup/6-inch-model-3d.png)

<table>
<tr>
<td width="50%"><b>Inch nesting on a 120 × 60 in sheet</b><br><img src="mockup/7-inch-nesting.png" alt="Inch nesting"></td>
<td width="50%"><b>Face down: upside-down part flipped flanges-up</b><br><img src="mockup/8-face-down-flanges-up.png" alt="Face down"></td>
</tr>
<tr>
<td><b>Where the orientation buttons are</b><br><img src="mockup/9-where-are-the-buttons.png" alt="Orientation buttons"></td>
<td><b>Section view</b><br><img src="mockup/5-section-view.png" alt="Section view"></td>
</tr>
<tr>
<td><b>Start screen</b><br><img src="mockup/1-start.png" alt="Start screen"></td>
<td><b>Shortcuts &amp; controls (? button or ? key)</b><br><img src="mockup/10-shortcuts-help.png" alt="Shortcuts help"></td>
</tr>
<tr>
<td><b>Loading dialog (240-part assembly)</b><br><img src="mockup/11-loading-dialog.png" alt="Loading dialog"></td>
<td><b>Nesting: click a blank, rotate it (45° shown)</b><br><img src="mockup/12-nesting-rotate-45.png" alt="Nesting rotation"></td>
</tr>
</table>

## Features (v0.1)
- Open **STEP / IGES / BREP** (OpenCascade WASM) and **STL / OBJ / glTF / 3MF**
- Assembly tree + parts list with quantities; filter, show/hide, isolate
- **Normal To** (look straight at a clicked face), **Face down / Face up** (re-orient the model so a face sits
  on the floor — fixes sheet metal drawn upside down), flip 180°, reset orientation
- **Loading dialog** that blocks the app until the model is fully ready: step checklist, progress bar,
  elapsed time, parts counter (big assemblies can finish the sheet metal check in the background)
- **Shortcuts & controls** cheat sheet: keyboard button in the header or press **?**
- Section plane, explode, point-to-point measure, edges / wireframe / X-ray, PNG screenshot
- **STEP metadata**: material, density, thickness, part number, SolidWorks/Inventor custom properties, source CAD system
- **Sheet metal**: auto thickness detection, thickness at a clicked point, flat blank X × Y
  (from the file's flat-pattern properties, else automatic unfold with K-factor)
- **Metric / imperial**: detects the unit a STEP model was drawn in (mm or inch) and switches the display to
  match; mm | inch toggle (key U) converts every length, input and sheet preset. STL/OBJ follow the current unit.
- **Nesting part rotation**: click a blank on the sheet → Auto / 0–90° presets / any angle / ★ Best (tries
  every angle); all copies of that part re-nest at the angle, with a before/after count
- **Nesting**: "how many fit on one sheet" and "sheets for N sets", 90° rotation with per-part lock,
  margin/gap, sheet presets, layout PNG export

## Develop
```
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
node --experimental-strip-types test/unfold.test.mts                          # unfold accuracy (mm parts)
node --experimental-strip-types test/unfold.test.mts samples/inch-bracket.step # unfold accuracy (inch part)
node --experimental-strip-types test/nest.test.mts     # nesting checks
```

## Deploy on the Debian box (static files only)
Copy `dist/` to the web root, e.g. `/var/www/pjcroft/pc-cad-view/`. With Caddy:
```
pjcroft.ddnsfree.com {
    root * /var/www/pjcroft
    encode zstd gzip
    file_server
}
```
`.wasm` is served as `application/wasm` by Caddy/nginx by default. The app uses relative paths,
so it works from any sub-folder. Add a card to the tools home page linking to `pc-cad-view/`.

## Limits
- SolidWorks / NX / Creo / CATIA native files need a server-side converter (planned); export STEP for now.
- Unfold is an estimate (straight bends, no reliefs/bend tables); file flat-pattern properties win when present.
- Nesting packs rectangles; true-shape CAM nesting can fit a few more irregular parts. Because each blank is
  already squared to its tightest rectangle, angled placements rarely beat Auto here — use them to force an
  orientation (e.g. grain); ★ Best confirms the optimum.
