




"use strict";

// CARL's ROS 2 topic catalog. Field paths preserve the ROS message names.
const telemetryGroups = [
    {
        title: "Encoders",
        topic: "/carl/encoders",
        type: "carl_msgs/msg/CarlEncoderFeedback",
        fields: [
            ["Rear-left encoder counts", "rear_left_counts"],
            ["Rear-right encoder counts", "rear_right_counts"]
        ]
    },
    {
        title: "Throttle status",
        topic: "/carl/throttle_status",
        type: "carl_msgs/msg/CarlThrottleStatus",
        fields: [
            ["Controller state", "state", ["Init", "Idle", "Driving", "Safe stop", "E-stop"]],
            ["Fault flags", "faults"],
            ["Applied left output", "applied_left"],
            ["Applied right output", "applied_right"]
        ]
    },
    {
        title: "Heartbeat",
        topic: "/carl/heartbeat",
        type: "carl_msgs/msg/CarlHeartbeat",
        fields: [
            ["Heartbeat counter", "counter"],
            ["Status flags", "flags"],
            ["Operating mode", "mode", ["Idle", "Teleop", "E-stop"]]
        ]
    },
    {
        title: "IMU",
        topic: "/carl/imu",
        type: "sensor_msgs/msg/Imu",
        fields: [
            ["Orientation quaternion — X, Y, Z, W", "orientation"],
            ["Angular velocity — X, Y, Z (rad/s)", "angular_velocity"],
            ["Linear acceleration — X, Y, Z (m/s²)", "linear_acceleration"],
            ["Orientation covariance", "orientation_covariance"],
            ["Angular velocity covariance", "angular_velocity_covariance"],
            ["Linear acceleration covariance", "linear_acceleration_covariance"]
        ]
    },
    {
        title: "IMU temperature",
        topic: "/carl/imu/temperature",
        type: "sensor_msgs/msg/Temperature",
        fields: [
            ["Temperature (°C)", "temperature"],
            ["Temperature variance (°C²)", "variance"]
        ]
    }
];

const telemetryContainer = document.getElementById("telemetry-sections");

if (telemetryContainer) {
    const views = new Map();
    for (const group of telemetryGroups) {
        const section = document.createElement("section");
        section.className = "telemetry-section";

        const heading = document.createElement("h2");
        heading.textContent = group.title;

        const topic = document.createElement("p");
        topic.className = "topic";
        topic.textContent = `ROS topic: ${group.topic}`;

        // A description list pairs field names with their values.
        const values = document.createElement("dl");
        const fieldViews = [];

        for (const [labelText, path, names] of [...group.fields,
            ["ROS message timestamp", "header.stamp"], ["Frame ID", "header.frame_id"]]) {
            const row = document.createElement("div");
            row.className = "telemetry-row";

            const label = document.createElement("dt");
            label.textContent = labelText;

            const value = document.createElement("dd");

            // Never show a made-up measurement as real telemetry.
            value.textContent = "Not connected";

            row.append(label, value);
            values.append(row);
            fieldViews.push({ path, names, element: value });
        }

        const health = document.createElement("p");
        health.textContent = "Waiting for connection";
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Complete ROS message";
        const raw = document.createElement("pre");
        raw.textContent = "No message received";
        details.append(summary, raw);
        section.append(heading, topic, health, values, details);
        telemetryContainer.append(section);
        views.set(group.topic, { section, health, raw, fieldViews,
            count: 0, message: null, receivedAt: null, error: null });
    }

    const form = document.getElementById("ros-connection-form");
    const address = document.getElementById("rosbridge-url");
    const status = document.getElementById("ros-connection-status");
    const carlStatus = document.getElementById("carl-connection-status");
    const storageKey = "carl.rosbridge.url.v1";
    let connectionState = "disconnected";
    let enabled = true;
    let renderTimer = null;
    const host = window.location.hostname || "localhost";
    const defaultUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${host}:9090`;
    try { address.value = localStorage.getItem(storageKey) || defaultUrl; }
    catch { address.value = defaultUrl; }

    function clearMessages() {
        for (const view of views.values()) {
            view.message = null;
            view.receivedAt = null;
            view.count = 0;
            view.error = null;
        }
    }

    const client = new CarlRosClient({
        topics: telemetryGroups,
        onState(state, detail) {
            connectionState = state;
            status.textContent = detail;
            status.dataset.state = state === "connected" ? "live" : "waiting";
            // Never carry old values across a dropped connection or endpoint change.
            if (state !== "connected") clearMessages();
            render();
        },
        onMessage(topic, message) {
            const view = views.get(topic);
            view.message = message;
            view.receivedAt = performance.now();
            view.count++;
            view.error = null;
        },
        onTopicError(topic, error) {
            views.get(topic).error = error;
        }
    });

    function valueAt(message, path) {
        return path.split(".").reduce((value, key) => value?.[key], message);
    }

    function format(value, names) {
        if (value === undefined || value === null) return "Not provided";
        if (names) return `${names[value] ?? "Unknown"} (${value})`;
        if (typeof value === "object") return JSON.stringify(value);
        return String(value) || "(empty)";
    }

    function render() {
        const now = performance.now();
        for (const view of views.values()) {
            const age = view.receivedAt === null ? null : now - view.receivedAt;
            const live = connectionState === "connected" && age !== null && age <= 1000 && !view.error;
            view.section.dataset.state = live ? "live" : age !== null ? "stale" : "waiting";
            view.health.textContent = view.error ? `Subscription error: ${view.error}`
                : connectionState !== "connected" ? "rosbridge disconnected"
                : age === null ? "Waiting for messages — publisher or data not yet observed"
                : `${live ? "Live" : "Stale — showing last received values"} · ${view.count} messages · last received ${(age / 1000).toFixed(1)}s ago`;
            for (const field of view.fieldViews) {
                field.element.textContent = view.message
                    ? format(valueAt(view.message, field.path), field.names) : "No data";
            }
            if (view.raw.parentElement.open || view.count <= 1) {
                view.raw.textContent = view.message ? JSON.stringify(view.message, null, 2) : "No message received";
            }
        }
        const heartbeat = views.get("/carl/heartbeat");
        const live = connectionState === "connected" && heartbeat.receivedAt !== null
            && now - heartbeat.receivedAt <= 1000 && !heartbeat.error;
        carlStatus.textContent = live ? "CARL heartbeat: live"
            : connectionState !== "connected" ? "CARL heartbeat: unknown while rosbridge is disconnected"
            : heartbeat.receivedAt === null ? "CARL heartbeat: waiting for first message"
            : "CARL heartbeat: stale";
        carlStatus.dataset.state = live ? "live" : "waiting";
    }

    function connect() {
        let endpoint;
        try {
            endpoint = CarlRosClient.endpoint(address.value.trim(), window.location.protocol);
        } catch (error) {
            status.textContent = error.message;
            return;
        }
        enabled = true;
        address.value = endpoint;
        try { localStorage.setItem(storageKey, endpoint); } catch { /* Connection does not require storage. */ }
        client.connect(endpoint);
    }

    form.addEventListener("submit", (event) => { event.preventDefault(); connect(); });
    document.getElementById("ros-disconnect").addEventListener("click", () => {
        enabled = false;
        client.disconnect();
    });
    window.addEventListener("pagehide", () => {
        window.clearInterval(renderTimer);
        renderTimer = null;
        client.disconnect();
    });
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) {
            renderTimer = window.setInterval(render, 100);
            if (enabled) connect();
        }
    });
    renderTimer = window.setInterval(render, 100);
    // auth.js has already checked admission before this deferred script executes.
    if (!document.documentElement.classList.contains("auth-pending")) connect();
}

