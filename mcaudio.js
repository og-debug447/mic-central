"use strict";

module.exports.mcaudio = function (parent) {
    var obj = { parent: parent };
    obj.exports = ["onDeviceRefreshEnd"];

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
            "<button id='mcaudioConnect'>Connect</button> <button id='mcaudioDisconnect' disabled>Disconnect</button> <button id='mcaudioStart' disabled>Start listening</button> <button id='mcaudioStop' disabled>Stop</button> <button id='mcaudioPopout' disabled>Open audio controls</button>" +
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
        var shouldListen = false;
        var selectedDeviceId = null;
        var retryCount = 0;
        var retryTimer = null;
        var reconnecting = false;
        var popupBlockedPlayback = false;
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
            if (popoutWindow && !popoutWindow.closed) { popoutWindow.focus(); return popoutWindow; }
            var w = window.open("", "mcaudioControls", "popup=yes,width=460,height=320,resizable=yes");
            if (!w) { popupBlockedPlayback = true; setStatus("The browser blocked the controls window. Allow popups for this MeshCentral site."); return null; }
            popupBlockedPlayback = false;
            popoutWindow = w;
            w.document.open();
            w.document.write("<!doctype html><html><head><meta charset='utf-8'><title>MeshCentral Audio</title></head><body><main><h2>Remote audio</h2><p>Leave this window open while you view the remote desktop. Closing it stops audio.</p><label for='mcaudioPopupMode'>Source </label><select id='mcaudioPopupMode'><option value='loopback'>System output</option><option value='microphone'>Microphone</option></select><br><label for='mcaudioPopupDevices'>Device </label><select id='mcaudioPopupDevices' style='min-width:280px'></select><p><button id='mcaudioPopupConnect'>Connect</button> <button id='mcaudioPopupDisconnect'>Disconnect</button> <button id='mcaudioPopupStart'>Start listening</button> <button id='mcaudioPopupStop'>Stop</button></p><p id='mcaudioPopupStatus' role='status'></p></main></body></html>");
            w.document.close();
            var popMode = w.document.getElementById("mcaudioPopupMode");
            var popDevices = w.document.getElementById("mcaudioPopupDevices");
            w.document.getElementById("mcaudioPopupConnect").addEventListener("click", function () { connect.click(); });
            w.document.getElementById("mcaudioPopupDisconnect").addEventListener("click", function () { disconnect.click(); });
            w.document.getElementById("mcaudioPopupStart").addEventListener("click", function () { devices.value = popDevices.value; start.click(); });
            w.document.getElementById("mcaudioPopupStop").addEventListener("click", function () { stop.click(); });
            popMode.addEventListener("change", function () { shouldListen = false; selectedDeviceId = null; mode.value = popMode.value; requestDevices(); });
            popDevices.addEventListener("change", function () { devices.value = popDevices.value; syncPopout(); });
            w.addEventListener("beforeunload", function () {
                if (window.mcaudioSession && window.mcaudioSession.audioWindow === w) {
                    shouldListen = false;
                    send({ cmd: "stop" });
                    try { if (window.mcaudioSession.worklet) window.mcaudioSession.worklet.port.postMessage({ reset: true }); } catch (e) { }
                    window.mcaudioSession.context = null;
                    window.mcaudioSession.worklet = null;
                    window.mcaudioSession.audioWindow = null;
                    workletReady = false;
                    stop.disabled = true;
                    start.disabled = !devices.value;
                    setStatus("Audio stopped because the controls window was closed.");
                }
                if (popoutWindow === w) popoutWindow = null;
            });
            startWorklet(w).then(function () { workletReady = true; syncPopout(); }, function (e) { setStatus("Browser audio playback could not start: " + e.message); });
            syncPopout();
            return w;
        }
        function startWorklet(targetWindow) {
            var s = window.mcaudioSession;
            if (!s) return Promise.reject(new Error("Audio tunnel is not connected."));
            var audioWindow = targetWindow || ((popoutWindow && !popoutWindow.closed) ? popoutWindow : window);
            if (s.workletPromise && s.audioWindow === audioWindow) return s.workletPromise;
            if (s.context && s.audioWindow === audioWindow) return s.context.resume();
            if (s.context) {
                try { if (s.worklet) s.worklet.disconnect(); } catch (e) { }
                try { s.context.close(); } catch (e) { }
                s.context = null;
                s.worklet = null;
                s.audioWindow = null;
            }
            var AudioContextType = audioWindow.AudioContext || audioWindow.webkitAudioContext;
            var WorkletNodeType = audioWindow.AudioWorkletNode;
            if (!AudioContextType || !WorkletNodeType) return Promise.reject(new Error("This browser does not support AudioWorklet playback."));
            var context = new AudioContextType({ latencyHint: "interactive" });
            var workletUrl = domainUrl + "scripts/mcaudio-worklet.js";
            /* Request resume synchronously from the user gesture, before the
             * worklet script fetch yields control and the browser may expire it. */
            var resumePromise = context.resume();
            s.context = context;
            s.audioWindow = audioWindow;
            var worklet = null;
            var setup = context.audioWorklet.addModule(workletUrl).then(function () {
                if (window.mcaudioSession !== s || s.context !== context || s.audioWindow !== audioWindow) throw new Error("Audio tunnel changed while starting playback.");
                worklet = new WorkletNodeType(context, "mc-audio-pcm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
                s.worklet = worklet;
                worklet.connect(context.destination);
                return Promise.all([resumePromise, context.resume()]);
            }).then(function () {
                workletReady = true;
                syncPopout();
            }).catch(function (e) {
                try { if (worklet) worklet.disconnect(); } catch (ignore) { }
                if (s.context === context) {
                    s.context = null;
                    s.worklet = null;
                    s.audioWindow = null;
                    s.workletPromise = null;
                }
                try { context.close(); } catch (ignore2) { }
                throw e;
            });
            s.workletPromise = setup;
            setup.then(function () { if (s.workletPromise === setup) s.workletPromise = null; }, function () { });
            return setup;
        }
        function closeSession(preservePlayback) {
            var s = window.mcaudioSession;
            if (!s) {
                if (!preservePlayback && window.mcaudioPlaybackCache) {
                    try { if (window.mcaudioPlaybackCache.worklet) window.mcaudioPlaybackCache.worklet.disconnect(); } catch (e) { }
                    try { if (window.mcaudioPlaybackCache.context) window.mcaudioPlaybackCache.context.close(); } catch (e) { }
                    window.mcaudioPlaybackCache = null;
                }
                return;
            }
            s.closing = true;
            try { if (s.redirect && s.redirect.State >= 3) s.redirect.sendText({ cmd: "stop" }); } catch (e) { }
            try { if (s.redirect) s.redirect.Stop(); } catch (e) { }
            try { if (s.worklet) s.worklet.port.postMessage({ reset: true }); } catch (e) { }
            if (preservePlayback && s.context && s.worklet) {
                window.mcaudioPlaybackCache = { context: s.context, worklet: s.worklet, audioWindow: s.audioWindow };
            } else {
                try { if (s.worklet) s.worklet.disconnect(); } catch (e) { }
                try { if (s.context) s.context.close(); } catch (e) { }
                window.mcaudioPlaybackCache = null;
            }
            s.audioWindow = null;
            window.mcaudioSession = null;
            workletReady = !!window.mcaudioPlaybackCache;
            if (popoutButton) popoutButton.disabled = true;
            syncPopout();
        }
        window.mcaudioClose = function () {
            shouldListen = false;
            if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
            closeSession(false);
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
            var keepPlayback = reconnecting || shouldListen;
            if (window.mcaudioSession) closeSession(keepPlayback);
            var retainedPlayback = keepPlayback ? window.mcaudioPlaybackCache : null;
            if (retainedPlayback) window.mcaudioPlaybackCache = null;
            var session = null;
            var m = {
                protocol: 15,
                // PCM must arrive in order. The browser's reliable DataChannel
                // and MeshCentral's authenticated relay carry the same stream.
                dataChannelOptions: { ordered: true },
                ProcessData: function (data) {
                    if (!session || window.mcaudioSession !== session) return;
                    var msg;
                    try { msg = JSON.parse(data); } catch (e) { return; }
                    if (msg.type === "devices") {
                        devices.innerHTML = "";
                        (msg.devices || []).forEach(function (d) {
                            var o = document.createElement("option"); o.value = d.id; o.textContent = d.name; devices.appendChild(o);
                        });
                        if (selectedDeviceId) devices.value = selectedDeviceId;
                        devices.disabled = false; start.disabled = devices.options.length === 0;
                        if (shouldListen && selectedDeviceId && devices.value !== selectedDeviceId) {
                            shouldListen = false;
                            setStatus("The selected audio device is unavailable. Choose a device and start listening again.");
                        } else if (shouldListen && devices.options.length) {
                            setStatus("Reconnected; resuming audio…");
                            start.click();
                        } else {
                            setStatus(devices.options.length ? "Select a device, then start listening." : "No active audio devices found.");
                        }
                    } else if (msg.type === "state") {
                        setStatus(msg.message || msg.state || "Audio status changed.");
                        if (msg.state === "device-lost") { start.disabled = true; }
                        else if (msg.state === "running" && popupBlockedPlayback) setStatus("Audio is playing in this tab. Allow popups so it can stay active while you view the desktop.");
                    } else if (msg.type === "error") {
                        shouldListen = false;
                        start.disabled = !devices.value;
                        stop.disabled = true;
                        setStatus("Audio error: " + (msg.message || "Unknown error"));
                    }
                },
                ProcessBinaryData: function (bytes) {
                    if (!session || window.mcaudioSession !== session) return;
                    var s = session;
                    if (!s || !s.worklet || !bytes || bytes.byteLength < 4) return;
                    var n = bytes.byteLength & ~1, view = new DataView(bytes.buffer, bytes.byteOffset, n), samples = new Float32Array(n / 2);
                    for (var i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
                    s.worklet.port.postMessage(samples, [samples.buffer]);
                },
                xxStateChange: function (state) {
                    if (!session || window.mcaudioSession !== session) return;
                    if (state === 3) { retryCount = 0; popoutButton.disabled = false; setStatus("Authenticated tunnel connected; enumerating devices…"); requestDevices(); }
                    else if (state === 0) {
                        var lostSession = session;
                        if (lostSession.closing) return;
                        setStatus("Audio tunnel interrupted; reconnecting…");
                        connect.disabled = true; disconnect.disabled = true; start.disabled = true; stop.disabled = true; devices.disabled = true;
                        try { if (lostSession.worklet) lostSession.worklet.port.postMessage({ reset: true }); } catch (e) { }
                        if (retryTimer == null) {
                            if (retryCount >= 8) {
                                connect.disabled = false;
                                setStatus("Audio tunnel could not reconnect. Press Connect to try again.");
                            } else {
                                var delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                                retryCount++;
                                retryTimer = setTimeout(function () {
                                    retryTimer = null;
                                    if (window.mcaudioSession !== lostSession || lostSession.closing) return;
                                    reconnecting = true;
                                    connect.disabled = false;
                                    connect.click();
                                    reconnecting = false;
                                }, delay);
                            }
                        }
                    }
                }
            };
            var redirect = CreateAgentRedirect(meshserver, m, serverPublicNamePort, authCookie, authRelayCookie, domainUrl);
            session = {
                nodeId: nodeid, redirect: redirect, module: m,
                context: retainedPlayback ? retainedPlayback.context : null,
                worklet: retainedPlayback ? retainedPlayback.worklet : null,
                audioWindow: retainedPlayback ? retainedPlayback.audioWindow : null,
                workletPromise: null,
                closing: false
            };
            window.mcaudioSession = session;
            redirect.Start(nodeid);
            connect.disabled = true; disconnect.disabled = false; stop.disabled = true;
            setStatus("Connecting through MeshCentral…");
        });
        disconnect.addEventListener("click", function () {
            window.mcaudioClose();
            connect.disabled = false; disconnect.disabled = true; start.disabled = true; stop.disabled = true; devices.disabled = true;
            setStatus("Disconnected.");
        });
        mode.addEventListener("change", function () { shouldListen = false; selectedDeviceId = null; requestDevices(); });
        start.addEventListener("click", function () {
            if (!devices.value) return;
            /* Put the playback engine in a small window that remains alive
             * when the main MeshCentral page switches to desktop view. */
            var audioWindow = openControlsWindow();
            var popupBlocked = !audioWindow;
            if (!audioWindow) audioWindow = window;
            startWorklet(audioWindow).then(function () {
                if (send({ cmd: "start", kind: mode.value, deviceId: devices.value }) === false) { setStatus("Audio tunnel is not connected."); return; }
                selectedDeviceId = devices.value;
                shouldListen = true;
                popupBlockedPlayback = popupBlocked;
                start.disabled = true; stop.disabled = false;
                setStatus(popupBlocked ? "Starting capture in this tab. Allow popups to keep audio active while viewing the desktop." : "Starting capture…");
            }).catch(function (e) { setStatus("Browser audio playback could not start: " + e.message); });
        });
        stop.addEventListener("click", function () {
            shouldListen = false;
            send({ cmd: "stop" }); start.disabled = !devices.value; stop.disabled = true;
            try { if (window.mcaudioSession && window.mcaudioSession.worklet) window.mcaudioSession.worklet.port.postMessage({ reset: true }); } catch (e) { }
            setStatus("Capture stopped.");
        });
        popoutButton.addEventListener("click", openControlsWindow);
    };

    return obj;
};



