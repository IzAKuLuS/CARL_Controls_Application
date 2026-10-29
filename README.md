# CARL Controls Application
> Authored by Isaac Alvarado

Browser telemetry and touch joystick control for CARL. Both mode pages receive
live ROS 2 telemetry through the rosbridge_server running on the host computer. Joystick commands use the CARL-specific
FastAPI/WebSocket server in the sibling `CARL_Joystick` repository.

## Run against CAR 1

On the laptop connected to the STM32, start the existing CARL bridge in its ROS
environment. In a second terminal, source the **same ROS distribution and CARL
workspace overlay**, then start rosbridge:

##Installation

```bash
source /opt/ros/lyrical/setup.bash
source install/setup.bash
ros2 launch rosbridge_server rosbridge_websocket_launch.xml
```

## Verification

```bash
node tests/joystick-client.test.js
node tests/joystick-ui.test.js
node tests/ros-client.test.js
```

## Joystick mode

Build and launch the `carl_joystick` package from `CARL_Joystick`, following its
README. With ROS and both workspace overlays sourced:

```bash
ros2 launch carl_joystick joystick.launch.py \
  controls_dir:=/home/izakulus/Documents/AVL/CARL_Controls_Application/src
```
