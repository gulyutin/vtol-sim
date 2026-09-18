# VTOL Mission Simulator

A browser-based simulator and operator trainer for a "4+1" VTOL aircraft: four lift rotors plus a pusher propeller. It takes off and lands vertically and flies its route like an airplane. The interface follows a ground control station (GCS): a map with satellite imagery, a 3D view of the aircraft, telemetry and instruments.

**Play:** https://gulyutin.github.io/vtol-sim/

The in-app interface is in Russian.

## Missions

- **Transfer A → B** (default) — take off at the airfield, fly your own waypoints, land at point B; point B can be dragged on the map.
- **Aerial survey** — survey lines from the required GSD and overlaps, photo frames, area coverage, shutter speed and lighting. The area can be drawn from scratch on the map; vertices can be dragged, added and removed.
- **Delivery** — fly out with cargo, land and unload, fly back.
- **Route flight** — your own waypoints; heights above terrain (terrain following), above sea level or relative to the takeoff point; the route can be edited in flight.
- **Search and rescue** — search lines over an area with a thermal camera; missing people are among bears, wolves, moose and deer that are warm too. Click a hot spot in the thermal window to mark a find.
- **Forest fire patrol** — patrol a zone, spot smoke columns that are visible for kilometres and report them from the 3D view, then confirm the fire with the thermal camera and mark hot spots: smouldering spots inside the burn, spot fires beyond the edge and lone smouldering trees with almost no smoke. Sun-heated rock fields and a cabin with a burning stove are decoys.

Regions with different terrain are selected in the top bar: Moscow region (Oka valley), Elbrus area (the high Baksan valley, airfield at 1,900 m), Khibiny (mountains up to 1,200 m and Lake Imandra), Lake Baikal (Maloye More and Olkhon Island), Kuturchin Belogorye (Eastern Sayan taiga and bald peaks up to 1,640 m) and Lake Shotozero in southern Karelia (a lake with islands, pine and spruce forests and bogs; the airfield at Salmenitsa). Each region has its own buildings, roads and water from OpenStreetMap and radio relays on the ridges.

The flight procedure follows a real aircraft: optional pre-flight checks (power — the navigation lights come on after it; the data link; servo checks — the ailerons and V-tail surfaces move on the model; air data — blowing into the pitot tube shows in telemetry; lift rotor controllers, lights and the pusher motor), then ARM and takeoff; after touchdown — DISARM. DISARM in flight is possible too: the motors stop and the aircraft glides or falls, which is how a failure is practised.

Takeoff and landing are into the wind: a departure leg with acceleration, a three-point final approach, braking with the pusher off and a descent in copter mode. The landing approach course can also be set by hand when the site can only be approached from one side; the pre-flight checks then show the tailwind and crosswind on that course, and RETURN lands home on the same course. Pre-flight checks cover wind, temperature, cloud base, mass and line of sight to the GCS.

## Trainer

- **Emergencies** — the Instructor window: failures of the data link, GNSS, airspeed sensor, control surfaces, pusher and lift motors, power and more; an alert panel with the checklist; "Failsafe" — manual control from a gamepad, the keyboard or on-screen RC sticks dragged with the mouse.
- **Manual control** — course set with a compass dial; "Orbit point" — click the map and the aircraft flies there and circles. A real RC transmitter works over USB in joystick mode (EdgeTX/OpenTX) or any gamepad: the RC window under ⚙ maps axes to sticks, inverts them and calibrates the travel; the mapping is saved per transmitter.
- **Gimbal camera** — a camera window that can go full screen: pan and tilt by dragging, zoom with the wheel, click to track a point or a moving target. Thermal and day channels in search and rescue and in the fire patrol; a day camera in the other missions. The video comes over the radio link as it does on a real GCS: latency grows with a weak signal, the codec drops resolution and breaks into blocks, the picture stutters with packet loss and freezes with "NO VIDEO" when the link is lost. An on-screen display shows recording time, mode, link and latency, height, speed, heading, gimbal angles, zoom and the coordinates of the frame centre.
- **Batteries** — the crew has several batteries, each with its own charge, temperature, cycle count and wear: swap the battery on the ground, put the spent one on the two-slot charger (constant current to ~80 %, then tapering), keep spares warm in the car in winter — Li-ion is charged only between 0 and +45 °C, and a cold battery has less capacity. The plan and the pre-flight checks use the charge of the installed battery; "Wait 15 min" lets ground time pass. The battery park is kept in the browser.
- **Link-loss reaction** — set per mission: return home, continue the mission or land in place, after 5–120 s without the link.
- **Weather** — from the mission, the actual weather now (Open-Meteo) or presets: gusts, rain, snow, fog, low cloud; turbulence, including in the lee of hills. Weather can also change in flight: a cold front (a squall line, then a stronger wind veered to the right, showers and low cloud) or a thunderstorm cell (downdraft and heavy rain under the core, gusts out of it for 6 km, severe turbulence) that the plan did not account for. Both are shown on the map, weather service updates arrive in the GCS console, and deciding whether to continue or return is up to the operator.
- **Seasons** — the region's date or winter, spring thaw, summer or autumn: snow on the ground by cover and above the snow line in the mountains, snow on spruces and roofs, ice on lakes, bare birches, snow blown up by the rotors; battery capacity follows the cold. Departure time covers the whole day, with lit villages, streetlights and green lights around the landing pads at night.
- **Modes** — from training to an exam with random failures. After landing: a one-paragraph flight summary, a score and a debrief with charts, events, a 3D replay and instructor remarks — where the aircraft went above or below the plan or off track and on which leg, how fast the operator reacted to each failure, where the link was lost; a remark jumps the replay to its moment. After a survey the debrief builds an orthophoto from the frames: each frame is projected onto the terrain, motion blur and under-exposure show up, and gaps in coverage stay empty. Flights are saved to a file. A recording with a flight location opens where it was flown: the region is built from the recording — terrain, imagery, wind and route — so the same flight can be replayed on the model.
- **Zones and electronic warfare** — the Zones window: no-fly zones, GNSS jamming and spoofing, data-link jamming; drawn on the map or loaded from GeoJSON/KML. The pre-flight check warns about crossings, and the score penalises entering a no-fly zone. The repository has no real zones — only what the instructor draws or loads.
- **Terrain and the data link** — behind a ridge the GCS link drops and telemetry arrives with gaps or freezes; signal indicator in the top bar, radio shadow on the map, relays (a mast or a relay aircraft).
- **Sound and voice** — rotors, pusher, airflow, GCS signals; voice callouts ("Link lost", "Battery thirty percent"). Settings are under ⚙.

## Autopilot and physics

Wing polar with induced drag in turns, hover from momentum theory, climb and descent limited by vertical speed, wind with height shear that depends on air stability (weak on a sunny afternoon, strong on a clear calm night) and the wind triangle, terrain following, battery capacity by temperature. The planner and the live flight share the same physics, so in-flight consumption matches the plan. In a crosswind the aircraft crabs: the nose turns into the wind by the drift angle and the wings stay level, as an autopilot flies it; on top of that the airframe has a small constant asymmetry (a slight bank with the nose a little off the airflow) that is there in calm air too. The pre-flight checks show the wind at flight height and the largest crab angle it gives.

The route planner follows the terrain along the route. If the slope beyond the takeoff site is steeper than the aircraft can climb along the way, the plan adds climb orbits over the site (and descent orbits before landing) instead of cutting through the slope; the orbits show on the map and count in the energy budget. In flight, if a downdraft still leaves the aircraft short of height before a slope, it climbs in an orbit and then continues the route.

Wind near terrain: updrafts on windward slopes, downdrafts and rotor turbulence behind ridges, speed-up over crests and saddles, valley winds and daytime thermals over sunlit slopes. Air density follows height and temperature: hover costs more in the mountains and turns are wider. If the terrain at the site is steeper than the maximum climb, the transition to airplane mode happens higher; RETURN climbs to a safe height above terrain on the way home.

## Graphics

- Terrain with satellite imagery; buildings, roads, water and forests from OpenStreetMap.
- Sky and haze from one scattering model (Rayleigh and Mie): a blue zenith, a bright horizon, a halo around the sun, and distant ridges fading into aerial perspective by distance and height. Haze density follows the visibility in the weather.
- Time of day: the sun reddens near the horizon, skylight turns blue at twilight, exposure adapts.
- Volumetric clouds with self-shadowing and a silver lining against the sun; cloud shadows on the ground match the clouds.
- Taiga spruces and birches; broadleaf trees turn yellow in autumn according to the region's date.
- Rotor dust near the ground, smoke columns and flames of forest fires.

Quality is set in the top bar (low / medium / high); choose low on weak laptops and phones.

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

Satellite imagery — Esri World Imagery. Terrain — Terrain Tiles (Terrarium) from AWS Open Data. Buildings, roads, water, forests and runways — © OpenStreetMap contributors, ODbL. Actual weather — Open-Meteo.com. The 3D aircraft model is generic.

GCS voice — Silero TTS v5.5 (speaker xenia), licensed CC BY-NC-SA 4.0: the files are in `public/voice` (with `LICENSE.txt`); rebuild with `scripts/voice-pack.ts`. Phrases that are not recorded are spoken by the browser's speech synthesis.
