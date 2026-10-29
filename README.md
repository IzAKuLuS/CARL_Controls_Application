# CARL Controls Application
> Authored by Isaac Alvarado

Browser telemetry and touch joystick control for CARL. Both mode pages receive
live ROS 2 telemetry through rosbridge. Joystick commands use the CARL-specific
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
select **Telemetry only** or **Joystick**. The app automatically connects to
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
  not the publisher's original rate. High-rate IMU traffic therefore competes
  less with the phone's joystick connection on a weak shared Wi-Fi link.
- Values older than one second are explicitly marked stale. This is a UI
  freshness threshold, separate from the firmware's safety watchdog.
- Expand **Complete ROS message** to inspect the entire latest received payload.
- Encoders, throttle status, heartbeat, IMU, and IMU temperature are subscribed.
  The bridge source currently publishes the first three; optional sensor topics
  can stay in the waiting state until publishers exist.
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
```

The transport tests use fake sockets and deterministic timers, covering telemetry
reconnect and joystick readiness, release, acknowledgements and timeouts.

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
right. The default per-wheel output limit is 40%. This is motor output, not a
speed measurement. CARL coasts at zero output.

The joystick refreshes its visible center for each input event, including the
first touch. Scrolling, resizing or status-message layout changes therefore do
not turn an initial forward touch into reverse. The existing soft-center input
response curve and motor limits are preserved.

The server requires live healthy CARL heartbeat and motor status. It accepts one
controller, stops stale input after 250 ms (plus up to a 50 ms watchdog tick),
and uses CARL's existing `/carl/throttle_cmd` and `/carl/estop` topics through
`carl_bridge`. Stop other ROS teleop publishers before using it. Telemetry and
joystick connections are independent; telemetry-only mode sends no commands.

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
