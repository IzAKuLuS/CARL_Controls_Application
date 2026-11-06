"use strict";
// Receive-only browser integration, using synthetic admission and a local rosbridge fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {once} = require("node:events");
const {chromium} = require(process.env.CARL_PLAYWRIGHT_MODULE || "playwright");
const {WebSocketServer} = require(process.env.CARL_WS_MODULE || "ws");
const src = path.resolve(__dirname, "../src");
const artifacts = process.env.CARL_BROWSER_ARTIFACT_DIR || "/tmp/carl-controls-imu-browser";
fs.mkdirSync(artifacts, {recursive: true});

(async () => {
    let mode = "live", commands = 0, browser;
    const clients = new Map();
    const ws = new WebSocketServer({host:"127.0.0.1", port:0});
    await once(ws,"listening");
    ws.on("connection", socket => {
        const topics = new Set(); clients.set(socket,topics);
        socket.on("message", raw => {
            const msg=JSON.parse(raw.toString());
            if(msg.op==="subscribe") topics.add(msg.topic);
            if(msg.op==="publish") commands++;
        });
        const timer=setInterval(() => {
            if(mode==="pause" || socket.readyState!==1) return;
            const messages={
                "/carl/encoders":{rear_left_counts:1234,rear_right_counts:-5678},
                "/carl/throttle_status":{state:1,faults:0,applied_left:0,applied_right:0},
                "/carl/heartbeat":{counter:42,flags:1,mode:0},
                "/carl/imu":{linear_acceleration:{x:mode==="malformed"?null:1.25,y:-2.5,z:9.80665},
                    angular_velocity:{x:.1,y:-.2,z:0},orientation_covariance:[-1,0,0,0,0,0,0,0,0]},
                "/carl/imu/temperature":{temperature:34.125},
                "/carl/imu/diagnostics":{data:mode==="malformed"?"bad JSON":JSON.stringify({schema:1,
                    sensor:"MPU-9250",interface:"spi",ready:mode!=="fault",stage:mode==="fault"?"retry_wait":"ready",
                    error:mode==="fault"?"data_timeout":"ok",error_count:mode==="recovered"||mode==="fault"?5:0})}
            };
            for(const topic of topics) if(messages[topic]) socket.send(JSON.stringify({op:"publish",topic,msg:messages[topic]}));
        },100);
        socket.on("close",()=>{clearInterval(timer); clients.delete(socket);});
    });
    const server=http.createServer((req,res)=>{
        const filename=path.basename(new URL(req.url,"http://localhost").pathname);
        if(filename==="passcodes.js") {res.setHeader("Content-Type","text/javascript");return res.end('window.CARL_PASSCODES=["00000000"];');}
        const file=path.join(src,filename);
        if(!fs.existsSync(file) || !fs.statSync(file).isFile()){res.statusCode=404;return res.end();}
        res.setHeader("Content-Type",filename.endsWith(".js")?"text/javascript":filename.endsWith(".css")?"text/css":"text/html");
        res.end(fs.readFileSync(file));
    });
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    try {
        browser=await chromium.launch({headless:true,executablePath:process.env.CARL_CHROMIUM_EXECUTABLE || undefined,
            args:["--no-sandbox","--disable-dev-shm-usage"]});
        const context=await browser.newContext({viewport:{width:1280,height:900}});
        await context.addInitScript(url=>{
            sessionStorage.setItem("carl.login.session.v1","00000000");
            localStorage.setItem("carl.rosbridge.url.v1",url);
        },process.env.CARL_LIVE_ROSBRIDGE_URL || `ws://127.0.0.1:${ws.address().port}`);
        const page=await context.newPage(), errors=[];
        page.on("pageerror", e=>errors.push(e.message));
        page.on("websocket", socket=>socket.on("framesent", event=>{
            try { if(JSON.parse(event.payload).op==="publish") commands++; } catch { /* Not a ROS envelope. */ }
        }));
        const section=title=>page.locator(".telemetry-section").filter({has:page.getByRole("heading",{name:title,exact:true})});
        const waitState=(title,state)=>page.waitForFunction(({title,state})=>[...document.querySelectorAll(".telemetry-section")]
            .some(el=>el.querySelector("h2").textContent===title && el.dataset.state===state),{title,state});
        await page.goto(`http://127.0.0.1:${server.address().port}/telemetry.html`);
        await waitState("IMU motion","live"); await waitState("IMU health","live");
        if(process.env.CARL_LIVE_ROSBRIDGE_URL) {
            await waitState("IMU temperature","live");
            assert.match(await section("IMU motion").locator("dd").first().textContent(),/m\/s²$/);
            assert.match(await section("IMU temperature").locator("dd").first().textContent(),/°C$/);
            assert.match(await section("IMU health").innerText(),/MPU-9250/);
            await page.screenshot({path:path.join(artifacts,"telemetry-live-desktop.png"),fullPage:true});
            await page.setViewportSize({width:390,height:844});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
            await page.screenshot({path:path.join(artifacts,"telemetry-live-mobile.png"),fullPage:true});
            assert.deepEqual(errors,[]); assert.equal(commands,0);
            console.log("Live ROS: telemetry-only desktop/mobile received MPU motion, die temperature and decoded health without publishing commands");
            await context.close();
            return;
        }
        assert.equal([...clients.values()][0].size,6);
        assert.equal(await section("IMU motion").locator("dd").first().textContent(),"1.250 m/s²");
        assert.match(await section("IMU motion").innerText(),/-2.500 m\/s²/);
        assert.match(await section("IMU motion").innerText(),/0.000 rad\/s/);
        assert.match(await section("IMU temperature").innerText(),/34.125 °C/);
        assert.match(await section("IMU health").innerText(),/MPU-9250/);
        await page.screenshot({path:path.join(artifacts,"telemetry-desktop.png"),fullPage:true});
        mode="pause"; await waitState("IMU health","stale");
        mode="malformed"; await waitState("IMU motion","waiting");
        assert.match(await section("IMU motion").innerText(),/Data error/);
        assert.equal(await section("IMU motion").locator("dd").first().textContent(),"No data");
        mode="fault"; await waitState("IMU health","fault");
        assert.match(await section("IMU health").innerText(),/data_timeout/);
        mode="recovered"; await waitState("IMU health","live");
        assert.equal(await section("IMU health").locator("dd").last().textContent(),"5");
        await page.getByRole("button",{name:"Disconnect",exact:true}).click();
        assert.equal(await section("IMU motion").locator("dd").first().textContent(),"No data");
        await page.getByRole("button",{name:"Connect",exact:true}).click(); await waitState("IMU motion","live");
        assert.equal(clients.size,1); assert.equal([...clients.values()][0].size,6);
        await page.setViewportSize({width:390,height:844});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
        await page.screenshot({path:path.join(artifacts,"telemetry-mobile.png"),fullPage:true});
        assert.deepEqual(errors,[]); assert.equal(commands,0);
        console.log("Chromium desktop/mobile telemetry: IMU units, JSON health, stale/malformed/fault/recovery, reconnect, no overflow or command publications passed");
        await context.close();
    } finally {
        await browser?.close();
        for(const socket of clients.keys()) socket.terminate();
        await new Promise(resolve=>ws.close(resolve));
        await new Promise(resolve=>server.close(resolve));
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
