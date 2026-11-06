




"use strict";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const vector = (value) => value && [value.x, value.y, value.z].every(finite);
const measurement = (unit) => (value) => finite(value) ? `${value.toFixed(3)} ${unit}` : "Not provided";
function imuHealth(message) {
    if (typeof message.data !== "string" || message.data.length > 4096) throw new Error("Invalid diagnostic payload");
    const data = JSON.parse(message.data);
    if (!data || Array.isArray(data) || data.schema !== 1 || typeof data.ready !== "boolean"
        || !Number.isInteger(data.error_count) || data.error_count < 0 || data.error_count > 65535
        || ![data.sensor, data.stage, data.error].every((v) => typeof v === "string" && v.length <= 64)) {
        throw new Error("Invalid diagnostic fields");
    }
    return data;
}

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
        title: "IMU motion", topic: "/carl/imu", type: "sensor_msgs/msg/Imu", staleMs: 500,
        validate: (message) => vector(message.linear_acceleration) && vector(message.angular_velocity),
        note: "Sensor axes. Acceleration includes gravity. The current MPU stream does not estimate orientation or heading.",
        fields: [
            ["Acceleration X", "linear_acceleration.x", measurement("m/s²")],
            ["Acceleration Y", "linear_acceleration.y", measurement("m/s²")],
            ["Acceleration Z", "linear_acceleration.z", measurement("m/s²")],
            ["Gyro X", "angular_velocity.x", measurement("rad/s")],
            ["Gyro Y", "angular_velocity.y", measurement("rad/s")],
            ["Gyro Z", "angular_velocity.z", measurement("rad/s")]
        ]
    },
    {
        title: "IMU temperature", topic: "/carl/imu/temperature", type: "sensor_msgs/msg/Temperature",
        validate: (message) => finite(message.temperature) && message.temperature >= -273.15,
        note: "Sensor die temperature, not ambient air temperature.",
        fields: [["IMU die temperature", "temperature", measurement("°C")]]
    },
    {
        title: "IMU health", topic: "/carl/imu/diagnostics", type: "std_msgs/msg/String", staleMs: 2500,
        decode: imuHealth, header: false, isFault: (message) => message.error !== "ok",
        note: "The error count is cumulative since STM32 restart; old errors do not necessarily indicate a current fault.",
        fields: [["Sensor model", "sensor"], ["Interface", "interface"], ["Sensor stage", "stage"],
            ["Ready", "ready", (v) => v ? "Yes" : "No"], ["Sensor error", "error"], ["Sensor error count", "error_count"]]
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

        for (const [labelText, path, names] of [...group.fields, ...(group.header === false ? [] :
            [["ROS message timestamp", "header.stamp"], ["Frame ID", "header.frame_id"]])]) {
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
        if (group.note) {
            const note = document.createElement("p");
            note.className = "telemetry-note";
            note.textContent = group.note;
            section.append(note);
        }
        telemetryContainer.append(section);
        views.set(group.topic, { group, section, health, raw, fieldViews,
            count: 0, message: null, rawMessage: null, receivedAt: null, error: null, dataError: null });
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
            view.rawMessage = null;
            view.receivedAt = null;
            view.count = 0;
            view.error = null;
            view.dataError = null;
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
            if (!view) return;
            let decoded;
            try {
                decoded = view.group.decode ? view.group.decode(message) : message;
                if (view.group.validate && !view.group.validate(decoded)) throw new Error("Invalid sensor fields");
            } catch {
                view.message = view.rawMessage = null;
                view.receivedAt = null;
                view.dataError = "Malformed sensor message";
                return;
            }
            view.message = decoded;
            view.rawMessage = message;
            view.receivedAt = performance.now();
            view.count++;
            view.error = null;
            view.dataError = null;
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
        if (typeof names === "function") return names(value);
        if (names) return `${names[value] ?? "Unknown"} (${value})`;
        if (typeof value === "object") return JSON.stringify(value);
        return String(value) || "(empty)";
    }

    function render() {
        const now = performance.now();
        for (const view of views.values()) {
            const age = view.receivedAt === null ? null : now - view.receivedAt;
            const live = connectionState === "connected" && age !== null && age <= (view.group.staleMs || 1000) && !view.error && !view.dataError;
            const fault = live && view.group.isFault?.(view.message);
            view.section.dataset.state = fault ? "fault" : live ? "live" : age !== null ? "stale" : "waiting";
            view.health.textContent = view.error ? `Subscription error: ${view.error}`
                : view.dataError ? `Data error: ${view.dataError}`
                : connectionState !== "connected" ? "rosbridge disconnected"
                : age === null ? "Waiting for messages — publisher or data not yet observed"
                : `${fault ? "Sensor reports a fault" : live ? "Live" : "Stale — showing last received values"} · ${view.count} messages · last received ${(age / 1000).toFixed(1)}s ago`;
            for (const field of view.fieldViews) {
                field.element.textContent = view.message
                    ? format(valueAt(view.message, field.path), field.names) : "No data";
            }
            if (view.raw.parentElement.open || view.count <= 1) {
                view.raw.textContent = view.rawMessage ? JSON.stringify(view.rawMessage, null, 2) : "No message received";
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

