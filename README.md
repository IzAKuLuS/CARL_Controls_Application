# CARL Controls Application

Browser telemetry and touch joystick control for CARL. The **Telemetry only** page receives
live ROS 2 telemetry through rosbridge. The **Joystick** page displays controls and
control feedback without loading telemetry or connecting to rosbridge. Joystick commands use the CARL-specific
FastAPI/WebSocket server in the sibling `CARL_Joystick` repository.

## Run against CARL

On the laptop connected to the STM32, start the existing CARL bridge in its ROS
environment. In a second terminal, source the **same ROS distribution and CARL
workspace overlay**, then start rosbridge:

```bash
source /opt/ros/lyrical/setup.bash
source /home/izakulus/Documents/AVL/AVL_CARL/ros2_ws/install/setup.bash
ros2 launch rosbridge_server rosbridge_websocket_launch.xml
```

Use your actual distribution/overlay if these differ. rosbridge needs the
`carl_msgs` package to deserialize CARL's custom messages, and must share the
CARL bridge's ROS domain and discovery configuration. The CARL bringup launch
currently starts the hardware bridge, not rosbridge.

Serve the controls pages in another terminal:

```bash
cd /home/izakulus/Documents/AVL/CARL_Controls_Application
python3 -m http.server 8000 --bind 0.0.0.0 --directory src
```

Open `http://localhost:8000`, sign in using an existing configured passcode, and
select **Telemetry only** or **Joystick**. The Telemetry only page automatically connects to
`ws://<page-hostname>:9090`. If rosbridge runs elsewhere, enter its WebSocket URL
and press Connect. The address is remembered on that browser.

For another device on the same network, open `http://<laptop-LAN-IP>:8000`.
Its rosbridge address must refer to the laptop, such as
`ws://<laptop-LAN-IP>:9090`; `localhost` on a phone refers to the phone. The
HTTP and rosbridge ports must be reachable on the network and rosbridge must
listen on a reachable interface. An HTTPS deployment requires rosbridge through
`wss://` with a trusted certificate; the app rejects insecure mixed connections.

## What to check

- **rosbridge connected** confirms the WebSocket connection only.
- **CARL heartbeat: live** confirms a heartbeat arrived within the last second.
- Each topic requests at most 10 messages/second with a one-sample rosbridge
  queue; the screen also renders at 10 Hz. Counts describe received samples,
  not the publisher's original rate. This bounds telemetry traffic on a shared
  Wi-Fi link while preserving the joystick input frequency.
- Existing vehicle metrics use a one-second stale threshold; IMU-specific
  thresholds are listed below. UI freshness is separate from the firmware's safety watchdog.
- Expand **Complete ROS message** to inspect the entire latest received payload.
- Encoders, throttle status, heartbeat, and the three IMU topics are subscribed:
  `/carl/imu` (`sensor_msgs/msg/Imu`), `/carl/imu/temperature`
  (`sensor_msgs/msg/Temperature`), and `/carl/imu/diagnostics` (`std_msgs/msg/String`).
  These are existing ROS publishers; any ROS client can subscribe to them.
- IMU motion shows acceleration X/Y/Z in m/s² (including gravity) and gyro
  X/Y/Z in rad/s, in sensor axes. The current raw MPU stream has no fused
  orientation or heading. IMU temperature is sensor die temperature, not ambient
  air temperature. Health decodes the diagnostic JSON and shows model, interface,
  stage, readiness, error, and cumulative error count.
- IMU motion becomes stale after 500 ms; die temperature after 1 second;
  diagnostics after 2.5 seconds. Malformed IMU messages clear the old readings
  and show a data error; healthy data recovers automatically. A historical
  nonzero error count does not mark an otherwise healthy sensor as faulty.
- Waiting means no message has been observed. This baseline does not claim to
  distinguish a missing publisher from a silent publisher using ROS graph queries.
- Disconnect/reconnect clears previous data. Unexpected loss reconnects with
  delays from 1 to 30 seconds and restores all subscriptions. Disconnect stops
  retries; Connect starts them again.

If the WebSocket connects but messages do not arrive, check these in the same
ROS environment used by rosbridge:

```bash
ros2 topic list -t
ros2 topic echo /carl/heartbeat --once
ros2 topic info /carl/heartbeat --verbose
```

Check the rosbridge terminal for missing custom interfaces, topic restrictions,
or QoS incompatibility. A socket connection alone does not prove STM32 data is
arriving. This transport only sends subscription requests through rosbridge; joystick
commands use a separate connection to the joystick server.

## Verification

```bash
node tests/joystick-client.test.js
node tests/joystick-ui.test.js
node tests/ros-client.test.js
node tests/telemetry-ui.test.js
```

The transport tests use fake sockets and deterministic timers, covering telemetry
reconnect and joystick readiness, release, acknowledgements and timeouts.
Telemetry screen tests cover the installed topic subscriptions, rendered values,
freshness, disconnect cleanup, subscription errors, and page lifecycle.

## Joystick mode

Build and launch the `carl_joystick` package from `CARL_Joystick`, following its
README. With ROS and both workspace overlays sourced:

```bash
ros2 launch carl_joystick joystick.launch.py \
  controls_dir:=/home/izakulus/Documents/AVL/CARL_Controls_Application/src
```

This can serve these pages directly at `http://<server-IP>:8001`. The existing
HTTP server on port 8000 is also supported. The joystick connection defaults to
`ws://<page-hostname>:8001/ws`; enter the actual endpoint if the server differs.
An HTTPS page requires `wss://` with a trusted certificate.

Sign in, choose **Joystick**, and press **Connect joystick**. Hold the joystick
to drive; release commands zero. Up/down drives forward/reverse; right turns
right. The default per-wheel command limit is 75% in forward and reverse; pure
turning retains its 40% limit. This is motor output, not a
speed measurement. CARL coasts at zero output.

The joystick reads its visible center for each pointer event, including the
first touch. Scrolling or resizing during a hold cancels it; layout changes
before a touch do not turn an initial forward touch into reverse. The native
pointer control sends normalized displacement directly to the server. The server retains its 5% center
deadzone and applies a signed quadratic throttle curve before mixing with the
existing linear steering response: 25%, 50%, 75%, and full straight travel
request about 3.3%, 16.8%, 40.7%, and 75% throttle. Reverse is symmetric.
This reserves more stick travel for low/medium throttle and reaches the existing
75% maximum only at full straight travel. The server's `throttle_exponent` YAML
parameter defaults to `2.0` (quadratic); `1.0` restores linear throttle and `3.0`
gives cubic throttle. Apply shaping on the server only, so it is not doubled in
the browser. The existing firmware 2% output deadband means PWM starts at roughly
20.3% travel after command rounding; mechanical breakaway still depends on load.

The joystick page shows the server's accepted signed left/right command
percentages and configured wheel-command limit. Reverse is negative. These are
commands, separate from measured speed or applied-output telemetry: existing
rear RPM balancing may adjust actual rear PWM above/below the nominal command.
Update/restart `carl_joystick` and reload this page together for the new behavior.

The server requires live healthy CARL heartbeat and motor status. It accepts one
controller, stops stale input after 250 ms (plus up to a 50 ms watchdog tick),
and uses CARL's existing `/carl/throttle_cmd` and `/carl/estop` topics through
`carl_bridge`. Stop other ROS teleop publishers before using it. The joystick page
connects only to the joystick server; it does not subscribe to vehicle telemetry.
Telemetry-only mode sends no commands.

The browser sends inputs at 20 Hz with one packet awaiting acknowledgement.
A missing reply for 200 ms cancels movement while retaining the connection.
Neutral acknowledgement and a fresh touch are required before driving again.
After three seconds without a reply, the client reconnects automatically at
neutral. Healthy idle sessions send neutral keepalives and remain connected. Hiding the page disconnects; returning
restores a previously requested connection without restoring held input.
Explicit Disconnect or sign-out stops reconnecting. Losing focus cancels current
input. **E-STOP** latches the firmware stop;
**Reset e-stop** clears it with zero output and requires a fresh touch. These
buttons need a working joystick connection.

A rapid Reset click is rejected while an E-stop is queued or awaiting its
acknowledgement, so Reset cannot erase an unsent stop. Invalid joystick move
events release held input. Refresh the browser after updating these scripts.
The server's inclusive +/-0.05 horizontal dead zone requests equal left/right
drive; it does not intentionally stop an individual rear motor in that band.

The server expires silent/blocked sessions after three seconds. A reconnect that
encounters an existing controller retries with bounded backoff, without taking
control from that session. This also handles the phone's own old half-open
session. Protocol v2 echoes a single-use server token for drive/reset commands;
expired or replayed commands stop output and require neutral. **Update the
joystick server and reload this page together**; an old server is rejected, and
an old browser cannot drive the updated server. Neutral and e-stop requests
remain usable without a fresh token. No firmware reflash is needed for this update.

The phone shows last reply latency, input pauses and reconnect attempts for the
page lifetime. `/health` and joystick server logs report readiness/stop reasons
and session closures. The existing browser passcode is an admission
screen; the joystick service currently assumes a trusted vehicle network.

### iPhone long-press and interrupted-touch recovery

The joystick area and its children disable Safari touch callouts, selection,
native dragging and touch scrolling. This is scoped to the joystick; address
fields, test notes and other page content retain normal editing/selection.
The control uses native Pointer Events with one captured pointer and the same
150px stick / 75px travel radius, replacing the library's persistent touch state.
Browsers without Pointer Events leave driving unavailable.

Release, pointer/touch cancellation, lost capture, copy/context menus, drag,
selection, a second contact, focus loss, scroll, rotation and resize all discard
the hold and recenter the knob. Reconnect and e-stop/reset also clear ownership.
Old movement events cannot arm input: lift and touch again after readiness
returns. No reload or manual reconnect is needed after a cancelled gesture.
An unchanged finger held on the control continues to drive normally.

Before every held command the client checks that this pointer is still captured.
A quick retouch cannot replace a queued release: neutral must be acknowledged
before a fresh hold can start.
A missing capture fails to neutral even if a cancellation event was missed;
a control-timer gap of 200ms or more also cancels held input. Existing server
input/lease and firmware watchdogs remain independent of these browser checks.
Zero output coasts CARL and cannot guarantee an immediate physical stop.

After updating, **reload the iPhone page once** to load `joystick-input.js` and
the changed CSS/client scripts. With wheels lifted, verify a stationary long
hold, release outside the pad, an interrupted touch/app switch, fresh-touch
recovery, and disconnect/reconnect. Confirm zero commanded and applied outputs
after interruption before a controlled ground test. Native iOS menus must still
be checked on the physical phone; Linux WebKit emulation is not an iPhone test.

Run the browser unit tests above for deterministic cancellation and delayed-event
regressions. Optional real Chromium/WebKit page checks use a simulated peer:

```bash
npm install --prefix /tmp/carl-browser-tests playwright
/tmp/carl-browser-tests/node_modules/.bin/playwright install chromium webkit
CARL_PLAYWRIGHT_MODULE=/tmp/carl-browser-tests/node_modules/playwright \
  node tests/integration-browser-input.js
```

Browser checks require the Playwright browser system libraries. They exercise
scoped CSS, actual pointer capture, interruption-to-neutral, release outside the
pad, stationary holds and reconnect on a mobile viewport; Chromium also injects
native touch hold/cancel events. They verify that the joystick page has no ROS
telemetry display or rosbridge connection. Set `CARL_BROWSER_ENGINES=chromium`
to check Chromium alone and `CARL_CHROMIUM_EXECUTABLE` to use an installed Chromium.
They never connect to CARL. The sibling joystick
ROS integration suite checks the production input/UI/client through the real
server and bridge with simulated vehicle transport.

Interruption validation on November 4, 2026 passed: 21 client/transport tests,
23 input/UI tests and all five browser unit-test files; Chromium and Linux
WebKit mobile-viewport checks; 45 joystick unit/API tests; five ROS integration
tests including a 65-second held-input recovery soak; and seven firmware host
regressions. The final re-arming checks cover queued release, neutral acknowledgement
and first touch during an idle keepalive. All vehicle transports were simulated.
The native iOS callout property is not implemented by Linux WebKit, so its CSS
declaration is checked there and the physical iPhone menu still needs verification.

## Joystick test diagnostics

The joystick page records command/reply timing, disconnect and retry details,
browser online/network signals, page lifecycle events and timer stalls. It
keeps a rolling 20,000-event IndexedDB copy and uploads bounded batches separately
from drive commands. Use **Download browser log** after a test, including when
the server never reconnects. The status beside the button reports storage/upload
problems and dropped upload events. Reload the page after updating its scripts.

The sibling `CARL_Joystick/README.md` documents server JSONL runs, bridge hardware
link diagnostics, optional ROS bags, correlation fields, retention limits and
the offline summary/timeline command. Browser offline and WebSocket close events
are evidence, not definitive internet/Wi-Fi root-cause labels.

### IMU browser checks

`node --test tests/*.test.js` includes IMU units, malformed/absent values,
zero temperature, diagnostic JSON, fault/recovery, freshness, and disconnect
checks. Optional desktop/mobile Chromium integration uses a localhost-only
rosbridge fixture and synthetic admission; it sends no vehicle commands:

```bash
CARL_PLAYWRIGHT_MODULE=/path/to/playwright \
CARL_WS_MODULE=/path/to/ws \
CARL_CHROMIUM_EXECUTABLE=/path/to/chromium \
node tests/integration-browser-telemetry.js
```

Set `CARL_LIVE_ROSBRIDGE_URL=ws://127.0.0.1:9090` to run the browser check
against the live IMU topics instead. This mode only reads telemetry and skips
fixture fault injection. The GUI/controls integration checks were also run
against the live MPU-9250 streams on 2026-11-05.
