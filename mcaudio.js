"use strict";

module.exports.mcaudio = function (parent) {
    var obj = { parent: parent };
    obj.exports = ["onDeviceRefreshEnd", "onDesktopDisconnect"];

    obj.onDeviceRefreshEnd = function (nodeid) {
        if (typeof pluginHandler === "undefined" || !pluginHandler.registerPluginTab) return;
        pluginHandler.registerPluginTab({ tabId: "mcaudioPage", tabTitle: "Audio" });
        var page = document.getElementById("mcaudioPage");
        if (page == null) return;

        if (window.mcaudioSession && window.mcaudioSession.nodeId === nodeid) {
            if (page.querySelector("#mcaudioConnect")) return;
            window.mcaudioClose();
        }
        if (window.mcaudioSession && window.mcaudioSession.nodeId !== nodeid) window.mcaudioClose();
        var selectedNode = (typeof currentNode !== "undefined" && currentNode) ? currentNode : null;
        var name = selectedNode ? selectedNode.name : nodeid;
        page.innerHTML = "<div style='padding:12px'><h3 id='mcaudioTitle'></h3>" +
            "<p>Audio is sent as 48 kHz, 16-bit stereo PCM (1.536 Mbps before transport overhead).</p>" +
            "<label for='mcaudioMode'>Source </label><select id='mcaudioMode'><option value='loopback'>System output (WASAPI loopback)</option><option value='microphone'>Microphone</option></select> " +
            "<button id='mcaudioConnect'>Connect</button> <button id='mcaudioDisconnect' disabled>Disconnect</button> <button id='mcaudioStart' disabled>Start listening</button> <button id='mcaudioStop' disabled>Stop</button> <button id='mcaudioPopout' disabled>Open controls window</button>" +
            "<select id='mcaudioDevices' aria-label='Audio device' disabled style='min-width:280px'></select><p id='mcaudioStatus' role='status'>Not connected</p></div>";

        document.getElementById("mcaudioTitle").textContent = "Audio from " + name;
        var status = document.getElementById("mcaudioStatus");
        var mode = document.getElementById("mcaudioMode");
        var devices = document.getElementById("mcaudioDevices");
        var connect = document.getElementById("mcaudioConnect");
        var disconnect = document.getElementById("mcaudioDisconnect");
        var start = document.getElementById("mcaudioStart");
        var stop = document.getElementById("mcaudioStop");
        var popoutButton = document.getElementById("mcaudioPopout");
        var popoutWindow = null;
        var workletReady = false;
        function syncPopout() {
            if (!popoutWindow || popoutWindow.closed) { popoutWindow = null; return; }
            try {
                var w = popoutWindow;
                var popMode = w.document.getElementById("mcaudioPopupMode");
                if (!popMode) return;
                popMode.value = mode.value;
                popMode.disabled = mode.disabled;
                var popDevices = w.document.getElementById("mcaudioPopupDevices");
                popDevices.innerHTML = "";
                for (var i = 0; i < devices.options.length; i++) {
                    var option = w.document.createElement("option");
                    option.value = devices.options[i].value;
                    option.textContent = devices.options[i].textContent;
                    popDevices.appendChild(option);
                }
                popDevices.value = devices.value;
                popDevices.disabled = devices.disabled;
                w.document.getElementById("mcaudioPopupConnect").disabled = connect.disabled;
                w.document.getElementById("mcaudioPopupDisconnect").disabled = disconnect.disabled;
                w.document.getElementById("mcaudioPopupStart").disabled = start.disabled || !workletReady;
                w.document.getElementById("mcaudioPopupStop").disabled = stop.disabled;
                w.document.getElementById("mcaudioPopupStatus").textContent = status ? status.textContent : "";
            } catch (e) { popoutWindow = null; }
        }
        function setStatus(s) { if (status) status.textContent = s; syncPopout(); }
        function send(obj) {
            if (!window.mcaudioSession || !window.mcaudioSession.redirect || window.mcaudioSession.redirect.State < 3) return false;
            window.mcaudioSession.redirect.sendText(obj);
            return true;
        }
        function requestDevices() {
            if (!stop.disabled) {
                send({ cmd: "stop" });
                stop.disabled = true;
                if (window.mcaudioSession && window.mcaudioSession.worklet) window.mcaudioSession.worklet.port.postMessage({ reset: true });
            }
            devices.disabled = true;
            start.disabled = true;
            devices.innerHTML = "";
            if (send({ cmd: "enumerate", kind: mode.value }) === false) setStatus("Waiting for the authenticated agent tunnel…");
            else setStatus("Finding audio devices…");
        }
        function openControlsWindow() {
            if (popoutWindow && !popoutWindow.closed) { popoutWindow.focus(); return; }
            var w = window.open("", "mcaudioControls", "popup=yes,width=460,height=320,resizable=yes");
            if (!w) { setStatus("The browser blocked the controls window. Allow popups for this MeshCentral site."); return; }
            popoutWindow = w;
            w.document.open();
            w.document.write("<!doctype html><html><head><meta charset='utf-8'><title>MeshCentral Audio</title></head><body><main><h2>Remote audio</h2><p>Controls stay available while you view the remote desktop.</p><label for='mcaudioPopupMode'>Source </label><select id='mcaudioPopupMode'><option value='loopback'>System output</option><option value='microphone'>Microphone</option></select><br><label for='mcaudioPopupDevices'>Device </label><select id='mcaudioPopupDevices' style='min-width:280px'></select><p><button id='mcaudioPopupConnect'>Connect</button> <button id='mcaudioPopupDisconnect'>Disconnect</button> <button id='mcaudioPopupStart'>Start listening</button> <button id='mcaudioPopupStop'>Stop</button></p><p id='mcaudioPopupStatus' role='status'></p></main></body></html>");
            w.document.close();
            var popMode = w.document.getElementById("mcaudioPopupMode");
            var popDevices = w.document.getElementById("mcaudioPopupDevices");
            w.document.getElementById("mcaudioPopupConnect").addEventListener("click", function () { connect.click(); });
            w.document.getElementById("mcaudioPopupDisconnect").addEventListener("click", function () { disconnect.click(); });
            w.document.getElementById("mcaudioPopupStart").addEventListener("click", function () { devices.value = popDevices.value; start.click(); });
            w.document.getElementById("mcaudioPopupStop").addEventListener("click", function () { stop.click(); });
            popMode.addEventListener("change", function () { mode.value = popMode.value; requestDevices(); });
            popDevices.addEventListener("change", function () { devices.value = popDevices.value; syncPopout(); });
            w.addEventListener("beforeunload", function () { if (popoutWindow === w) popoutWindow = null; });
            startWorklet().then(function () { workletReady = true; syncPopout(); }, function (e) { setStatus("Browser audio playback could not start: " + e.message); });
            syncPopout();
        }
        function startWorklet() {
            var s = window.mcaudioSession;
            if (s.context) return s.context.resume();
            var context = new AudioContext({ latencyHint: "interactive" });
            var workletUrl = domainUrl + "scripts/mcaudio-worklet.js";
            return context.audioWorklet.addModule(workletUrl).then(function () {
                s.context = context;
                s.worklet = new AudioWorkletNode(context, "mc-audio-pcm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
                s.worklet.connect(context.destination);
                return context.resume();
            }, function (e) { context.close(); throw e; }).then(function () {
                workletReady = true;
                syncPopout();
            });
        }
        window.mcaudioClose = function () {
            var s = window.mcaudioSession;
            if (!s) return;
            try { if (s.redirect && s.redirect.State >= 3) s.redirect.sendText({ cmd: "stop" }); } catch (e) { }
            try { if (s.redirect) s.redirect.Stop(); } catch (e) { }
            try { if (s.worklet) s.worklet.disconnect(); } catch (e) { }
            try { if (s.context) s.context.close(); } catch (e) { }
            window.mcaudioSession = null;
            workletReady = false;
            if (popoutButton) popoutButton.disabled = true;
            syncPopout();
        };
        window.mcaudioSend = send;

        connect.disabled = !!(window.mcaudioSession && window.mcaudioSession.nodeId === nodeid);
        if (window.mcaudioSession && window.mcaudioSession.nodeId === nodeid) {
            disconnect.disabled = false;
            devices.disabled = false;
            start.disabled = devices.options.length === 0;
            setStatus("Connected");
        }
        connect.addEventListener("click", function () {
            if (typeof CreateAgentRedirect !== "function" || typeof meshserver === "undefined") { setStatus("MeshCentral agent relay support is unavailable."); return; }
            if (window.mcaudioSession) window.mcaudioClose();
            var m = {
                protocol: 15,
                // PCM must arrive in order. The browser's reliable DataChannel
                // and MeshCentral's authenticated relay carry the same stream.
                dataChannelOptions: { ordered: true },
                ProcessData: function (data) {
                    var msg;
                    try { msg = JSON.parse(data); } catch (e) { return; }
                    if (msg.type === "devices") {
                        devices.innerHTML = "";
                        (msg.devices || []).forEach(function (d) {
                            var o = document.createElement("option"); o.value = d.id; o.textContent = d.name; devices.appendChild(o);
                        });
                        devices.disabled = false; start.disabled = devices.options.length === 0;
                        setStatus(devices.options.length ? "Select a device, then start listening." : "No active audio devices found.");
                    } else if (msg.type === "state") {
                        setStatus(msg.message || msg.state || "Audio status changed.");
                        if (msg.state === "device-lost") { start.disabled = true; }
                    } else if (msg.type === "error") {
                        setStatus("Audio error: " + (msg.message || "Unknown error"));
                    }
                },
                ProcessBinaryData: function (bytes) {
                    var s = window.mcaudioSession;
                    if (!s || !s.worklet || !bytes || bytes.byteLength < 4) return;
                    var n = bytes.byteLength & ~1, view = new DataView(bytes.buffer, bytes.byteOffset, n), samples = new Float32Array(n / 2);
                    for (var i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
                    s.worklet.port.postMessage(samples, [samples.buffer]);
                },
                xxStateChange: function (state) {
                    if (state === 3) { popoutButton.disabled = false; setStatus("Authenticated tunnel connected; enumerating devices…"); requestDevices(); }
                    else if (state === 0) { popoutButton.disabled = true; setStatus("Disconnected."); connect.disabled = false; disconnect.disabled = true; start.disabled = true; stop.disabled = true; devices.disabled = true; if (window.mcaudioSession && window.mcaudioSession.worklet) window.mcaudioSession.worklet.port.postMessage({ reset: true }); }
                }
            };
            var redirect = CreateAgentRedirect(meshserver, m, serverPublicNamePort, authCookie, authRelayCookie, domainUrl);
            window.mcaudioSession = { nodeId: nodeid, redirect: redirect, module: m, context: null, worklet: null };
            redirect.Start(nodeid);
            connect.disabled = true; disconnect.disabled = false; stop.disabled = true;
            setStatus("Connecting through MeshCentral…");
        });
        disconnect.addEventListener("click", function () {
            window.mcaudioClose();
            connect.disabled = false; disconnect.disabled = true; start.disabled = true; stop.disabled = true; devices.disabled = true;
            setStatus("Disconnected.");
        });
        mode.addEventListener("change", requestDevices);
        start.addEventListener("click", function () {
            if (!devices.value) return;
            startWorklet().then(function () {
                if (send({ cmd: "start", kind: mode.value, deviceId: devices.value }) === false) { setStatus("Audio tunnel is not connected."); return; }
                start.disabled = true; stop.disabled = false; setStatus("Starting capture…");
            }).catch(function (e) { setStatus("Browser audio playback could not start: " + e.message); });
        });
        stop.addEventListener("click", function () {
            send({ cmd: "stop" }); start.disabled = !devices.value; stop.disabled = true;
            if (window.mcaudioSession && window.mcaudioSession.worklet) window.mcaudioSession.worklet.port.postMessage({ reset: true });
            setStatus("Capture stopped.");
        });
        popoutButton.addEventListener("click", openControlsWindow);
    };

    obj.onDesktopDisconnect = function () {
        if (window.mcaudioClose) window.mcaudioClose();
    };
    return obj;
};



