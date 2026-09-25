# VTOL Mission Simulator

A browser-based simulator and operator trainer for a "4+1" VTOL aircraft: four lift rotors plus a pusher propeller. It takes off and lands vertically and flies its route like an airplane. The interface follows a ground control station (GCS): a map with satellite imagery, a 3D view of the aircraft, telemetry and instruments.

The in-app interface is in Russian.

## Missions

- **Transfer A → B** (default) — take off at the airfield, fly your own waypoints, land at point B; point B can be dragged on the map.
- **Aerial survey** — survey lines from the required GSD and overlaps, photo frames, area coverage, shutter speed and lighting. The area can be drawn from scratch on the map; vertices can be dragged, added and removed.
- **Delivery** — fly out with cargo, land and unload, fly back.
- **Route flight** — your own waypoints; heights above terrain (terrain following), above sea level or relative to the takeoff point; the route can be edited in flight.
- **Search and rescue** — search lines over an area with a thermal camera; missing people are among bears, wolves, moose and deer that are warm too. Click a hot spot in the thermal window to mark a find.
- **Forest fire patrol** — patrol a zone, spot smoke columns that are visible for kilometres and report them from the 3D view, then confirm the fire with the thermal camera and mark hot spots: smouldering spots inside the burn, spot fires beyond the edge and lone smouldering trees with almost no smoke. Sun-heated rock fields and a cabin with a burning stove are decoys.

Regions with different terrain are selected in the top bar: Moscow region (Oka valley), Elbrus area (the high Baksan valley, airfield at 1,900 m), Khibiny (mountains up to 1,200 m and Lake Imandra), Lake Baikal (Maloye More and Olkhon Island), Kuturchin Belogorye (Eastern Sayan taiga and bald peaks up to 1,640 m) Lake Shotozero in southern Karelia (a lake with islands, pine and spruce forests and bogs; the airfield at Salmenitsa) and the city of Irkutsk (takeoff from the Sibexpocentre car park; about 48,000 buildings, bridges over the Angara, the hydro dam and the reservoir, the international airport 3 km away). Each region has its own buildings, roads, car parks and water from OpenStreetMap and radio relays on the ridges or masts.

The flight procedure follows a real aircraft: optional pre-flight checks (power — the navigation lights come on after it; the data link; servo checks — the ailerons and V-tail surfaces move on the model; air data — blowing into the pitot tube shows in telemetry; lift rotor controllers, lights and the pusher motor), then ARM and takeoff; after touchdown — DISARM. DISARM in flight is possible too: the motors stop and the aircraft glides or falls, which is how a failure is practised.

Takeoff and landing are into the wind: a departure leg with acceleration, a three-point final approach, braking with the pusher off and a descent in copter mode. The landing approach course can also be set by hand when the site can only be approached from one side; the pre-flight checks then show the tailwind and crosswind on that course, and RETURN lands home on the same course. Pre-flight checks cover wind, temperature, cloud base, mass and line of sight to the GCS.

## Trainer

- **Emergencies** — the Instructor window: failures of the data link, GNSS, airspeed sensor, control surfaces, pusher and lift motors, power and more; an alert panel with the checklist; "Failsafe" — manual control from a gamepad, the keyboard or on-screen RC sticks dragged with the mouse.
- **Manual control** — course set with a compass dial; "Orbit point" — click the map and the aircraft flies there and circles. A real RC transmitter works over USB in joystick mode (EdgeTX/OpenTX) or any gamepad: the RC window under ⚙ maps axes to sticks, inverts them and calibrates the travel; the mapping is saved per transmitter.
- **Gimbal camera** — a camera window that can go full screen: pan and tilt by dragging, zoom with the wheel, click to track a point or a moving target. From the keyboard: arrows or IJKL pan and tilt (a tap is a small step, holding slews at a rate that follows the field of view, so it is slow and precise when zoomed in; Shift is faster), +/− zoom, Enter tracks whatever is under the crosshair, R fires the rangefinder, V switches thermal/day, F goes full screen, Home resets. In manual flight (FAILSAFE) from the keyboard the arrows belong to the stick and the gimbal keeps IJKL. Thermal and day channels in search and rescue and in the fire patrol; a day camera in the other missions. The video comes over the radio link as it does on a real GCS: latency grows with a weak signal, the codec drops resolution and breaks into blocks, the picture stutters with packet loss and freezes with "NO VIDEO" when the link is lost. An on-screen display shows recording time, mode, link and latency, height, speed, heading, gimbal angles, zoom and the coordinates of the frame centre.
- **Batteries** — the crew has several batteries, each with its own charge, temperature, cycle count and wear: swap the battery on the ground, put the spent one on the two-slot charger (constant current to ~80 %, then tapering), keep spares warm in the car in winter — Li-ion is charged only between 0 and +45 °C, and a cold battery has less capacity. The plan and the pre-flight checks use the charge of the installed battery; "Wait 15 min" lets ground time pass. The battery park is kept in the browser.
- **Link-loss reaction** — set per mission: return home, continue the mission or land in place, after 5–120 s without the link.
- **Weather** — from the mission, the actual weather now (Open-Meteo) or presets: gusts, rain, snow, fog, low cloud; turbulence, including in the lee of hills. Weather can also change in flight: a cold front (a squall line, then a stronger wind veered to the right, showers and low cloud) or a thunderstorm cell (downdraft and heavy rain under the core, gusts out of it for 6 km, severe turbulence) that the plan did not account for. Both are shown on the map, weather service updates arrive in the GCS console, and deciding whether to continue or return is up to the operator.
- **Seasons** — the region's date or winter, spring thaw, summer or autumn: snow on the ground by cover and above the snow line in the mountains, snow on spruces and roofs, ice on lakes, bare birches, snow blown up by the rotors; battery capacity follows the cold. Departure time covers the whole day, with lit villages, streetlights and green lights around the landing pads at night.
- **Modes** — from training to an exam with random failures. After landing: a one-paragraph flight summary, a score and a debrief with charts, events, a 3D replay and instructor remarks — where the aircraft went above or below the plan or off track and on which leg, how fast the operator reacted to each failure, where the link was lost; a remark jumps the replay to its moment. Every attempt gets a ticket number: it fixes the failures, the missing people and fire spots, and the weather change in flight; typing the number from a protocol into the task window replays the same session. "Protocol (PDF)" in the debrief prints an operator check protocol: flight details, points per item, remarks, track, flight charts, the pass/fail verdict (70 points, no crash, no gross violations) and signature lines. After a survey the debrief builds an orthophoto from the frames: each frame is projected onto the terrain, motion blur and under-exposure show up, and gaps in coverage stay empty. "Frames for Metashape (ZIP)" re-shoots every survey frame at 2000 px with the payload camera and saves them with GPS position, altitude, focal length and sensor size in EXIF plus a reference.csv — Agisoft Metashape, Pix4D or OpenDroneMap build a point cloud, DEM and orthomosaic from them like from a real survey. Flights are saved to a file. A recording with a flight location opens where it was flown: the region is built from the recording — terrain, imagery, wind and route — so the same flight can be replayed on the model.
- **Zones and electronic warfare** — the Zones window: no-fly zones, GNSS jamming and spoofing, data-link jamming; drawn on the map or loaded from GeoJSON/KML. The pre-flight check warns about crossings, and the score penalises entering a no-fly zone. The repository has no real zones — only what the instructor draws or loads.
- **Terrain and the data link** — behind a ridge the GCS link drops and telemetry arrives with gaps or freezes; signal indicator in the top bar, radio shadow on the map, relays (a mast or a relay aircraft).
- **Sound and voice** — rotors, pusher, airflow, GCS signals; voice callouts ("Link lost", "Battery thirty percent"). Settings are under ⚙.

## Autopilot and physics

Wing polar with induced drag in turns, hover from momentum theory, climb and descent limited by vertical speed, wind with height shear that depends on air stability (weak on a sunny afternoon, strong on a clear calm night) and the wind triangle, terrain following, battery capacity by temperature. The planner and the live flight share the same physics, so in-flight consumption matches the plan. In a crosswind the aircraft crabs: the nose turns into the wind by the drift angle and the wings stay level, as an autopilot flies it; on top of that the airframe has a small constant asymmetry (a slight bank with the nose a little off the airflow) that is there in calm air too. The pre-flight checks show the wind at flight height and the largest crab angle it gives.

The route planner follows the terrain along the route. If the slope beyond the takeoff site is steeper than the aircraft can climb along the way, the plan adds climb orbits over the site (and descent orbits before landing) instead of cutting through the slope; the orbits show on the map and count in the energy budget. In flight, if a downdraft still leaves the aircraft short of height before a slope, it climbs in an orbit and then continues the route.

Wind near terrain: updrafts on windward slopes, downdrafts and rotor turbulence behind ridges, speed-up over crests and saddles, valley winds and daytime thermals over sunlit slopes. Air density follows height and temperature: hover costs more in the mountains and turns are wider. If the terrain at the site is steeper than the maximum climb, the transition to airplane mode happens higher; RETURN climbs to a safe height above terrain on the way home.

## Measuring tools

"Ruler" (Map group): two clicks on the map give distance, azimuth and back azimuth, the terrain profile and line of sight between antennas at the chosen heights, with Earth curvature and refraction (k = 4/3); the chart shows where terrain blocks the line. "Rangefinder" on the gimbal camera measures slant and horizontal range to the point under the crosshair, its coordinates and elevation; the reading goes to the console, onto the map and into the video overlay.

## Training course

"Course" (Trainer group) is a structured operator course: 13 exercises in six modules — basics, route and wind, abnormal situations (link loss, GNSS loss, pusher failure), tasks (survey, search and rescue, fire patrol), difficult conditions and a final check. Each exercise has a goal, a short theory section and admission questions; the flight button unlocks only when every answer is right, and the next exercise opens only after the previous one is passed (score threshold, no crash, required assessment items). Starting an exercise sets the task, mode, weather and scheduled failures by itself. Progress and a flight logbook (date, exercise, task, region, mode, airborne time, distance, landings, failures, score, result) are kept per student in the browser; the logbook exports to CSV for Excel, and a student's file can be carried to the instructor's computer.

## Instructor station

"Instructor" → "Instructor station in a separate window" opens a console for a second monitor: a map with the plan, the true position of the aircraft and the position the GCS sees (they drift apart without GNSS), aircraft state and an event feed. Failures can be injected at once, after a delay, or on a condition — on the transition to airplane mode, on the landing approach, below 50 m on landing — and link or GNSS can be restored. Messages from the flight director appear on the operator's GCS as an alert; instructor remarks are written with the flight time and show up in the debrief and in the check protocol.

## Graphics

- Terrain with satellite imagery; buildings, roads, water and forests from OpenStreetMap.
- Sky and haze from one scattering model (Rayleigh and Mie): a blue zenith, a bright horizon, a halo around the sun, and distant ridges fading into aerial perspective by distance and height. Haze density follows the visibility in the weather.
- Time of day: the sun reddens near the horizon, skylight turns blue at twilight, exposure adapts.
- Volumetric clouds with self-shadowing and a silver lining against the sun; cloud shadows on the ground match the clouds.
- Taiga spruces and birches; broadleaf trees turn yellow in autumn according to the region's date. Beyond the near trees the forest continues to the horizon as simple silhouettes; near the ground there are grass tufts and bushes along forest edges.
- Water reflects the shores, forest and clouds (a planar mirror at the level of the nearest lake, Fresnel-weighted).
- Weather you can see: a thunderstorm cell as a towering cloud with a dark base, a rain shaft and lightning flashes, a grey shelf cloud along a cold front, a rainbow opposite the sun after a shower, morning fog in the lowlands on calm clear mornings.
- People and vehicles on the ground: the crew at the GCS; in search and rescue a rescue team drives to each mark and walks the last stretch, in the fire patrol a fire crew goes to each smoke report.
- Rotor dust near the ground, smoke columns and flames of forest fires.

Quality is set in the top bar (low / medium / high); choose low on weak laptops and phones.

When the gimbal camera is on, the right side splits in half: the 3D view on top, the camera picture below (⤢ gives the camera the whole side). ⚙ → "Second screen" opens the gimbal video (with its on-screen display) or the 3D view in a separate browser window for a second monitor. ⚙ → "Theme" switches the GCS to a dark theme for night flights (auto — dark after sunset).

## Working offline

🗺 "Regions and maps" → "Download region" saves the region in the browser: terrain, Sentinel-2 cloudless imagery (10 m per pixel, zoom 8–14) and the region's buildings and forest — about 15–40 MB per region; "Download all regions" queues the rest. The region you open is also saved in the background (can be switched off in the same window); tiles already saved are not downloaded again. Online the 3D view and the map use the more detailed Esri imagery; without a network, or when Esri does not answer, they use the saved Sentinel-2 imagery. The published build installs a service worker, so the app itself also starts without a network. `?offline=1` in the address simulates having no network.

The chase camera turns with the mouse, the wheel moves it closer or farther, a double click puts it back behind the tail. The tail camera is mounted on the tail and looks forward, so the horizon banks with the aircraft. There are also a free orbit camera, a view from the pad and a "cinema" mode that switches angles.

## Running locally

```bash
npm ci
npm run dev
```

Tests: `npm test`; type check: `npm run typecheck`.

A desktop app with installers for macOS, Windows and Linux is described in [desktop/README.md](desktop/README.md).

## Aircraft profile

Aircraft parameters, the standard camera and the mission regions live in a profile (`src/sim/profile.ts`). The repository contains the demo profile `src/profile-demo`: a generic aircraft whose numbers are plausible but do not describe any specific model. A custom profile goes into `private/profile/index.ts` (the folder is not in the repository) and is picked up automatically; `PROFILE=demo` forces the demo profile.

## Data and licences

Satellite imagery — Esri World Imagery (online only, never stored). Offline imagery — Sentinel-2 cloudless 2017: EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2017), licensed under CC BY 4.0. Terrain — Terrain Tiles (Terrarium) from AWS Open Data. Buildings, roads, water, forests and runways — © OpenStreetMap contributors, ODbL. Actual weather — Open-Meteo.com. The 3D aircraft model is generic.

GCS voice — Silero TTS v5.5 (speaker xenia), licensed CC BY-NC-SA 4.0: the files are in `public/voice` (with `LICENSE.txt`); rebuild with `scripts/voice-pack.ts`. Phrases that are not recorded are spoken by the browser's speech synthesis.
