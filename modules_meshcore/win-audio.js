'use strict';

function send(ws, value) {
    try { ws.write(JSON.stringify(value)); } catch (e) { }
}

function validKind(kind) {
    return kind === 'microphone' || kind === 'loopback';
}

function errorText(error) {
    var message = (error && typeof error.message === 'string') ? error.message : String(error);
    return message.substring(0, 256);
}

function stopCapture(ws) {
    var session = ws._mcaudio;
    if (session == null) return;
    if (session.timer != null) { clearInterval(session.timer); session.timer = null; }
    if (session.capture != null) {
        try { session.capture.stop(); } catch (e) { }
        session.capture = null;
    }
    session.lastState = null;
}

function closeTunnel(ws) {
    stopCapture(ws);
    try { delete ws._mcaudio; } catch (e) { ws._mcaudio = null; }
}

function handleTunnelData(ws, data) {
    if (process.platform !== 'win32') { send(ws, { type: 'error', message: 'WASAPI capture requires a Windows agent.' }); return; }
    var message;
    try { message = JSON.parse((typeof data === 'string') ? data : data.toString()); } catch (e) { return; }
    if (message == null || typeof message.cmd !== 'string') return;

    if (message.cmd === 'enumerate') {
        if (!validKind(message.kind)) { send(ws, { type: 'error', message: 'Invalid audio source.' }); return; }
        try {
            var devices = require('wasapi').enumerate(message.kind);
            send(ws, { type: 'devices', kind: message.kind, devices: devices });
        } catch (e) { send(ws, { type: 'error', message: 'Could not enumerate audio devices.' }); }
        return;
    }

    if (message.cmd === 'stop') {
        stopCapture(ws);
        send(ws, { type: 'state', state: 'stopped', message: 'Capture stopped.' });
        return;
    }

    if (message.cmd !== 'start' || !validKind(message.kind) || typeof message.deviceId !== 'string' || message.deviceId.length < 1 || message.deviceId.length > 1024) {
        send(ws, { type: 'error', message: 'Invalid audio command.' });
        return;
    }

    stopCapture(ws);
    var session = null;
    try {
        var wasapi = require('wasapi');
        var available = wasapi.enumerate(message.kind);
        var found = false;
        for (var i = 0; i < available.length; i++) { if (available[i].id === message.deviceId) { found = true; break; } }
        if (!found) { send(ws, { type: 'error', message: 'The selected audio device is unavailable.' }); return; }

        session = { capture: wasapi.createCapture(message.kind, message.deviceId), timer: null, lastState: null, blocked: false };
        ws._mcaudio = session;
        session.capture.start();
        session.timer = setInterval(function () {
            if (ws._mcaudio !== session) return;
            var state;
            try { state = session.capture.getState(); } catch (e) { state = 'error'; }
            if (state !== session.lastState) {
                session.lastState = state;
                send(ws, { type: 'state', state: state, message: (state === 'device-lost') ? 'Device disconnected; waiting for it to return.' : (state === 'reconnected' ? 'Audio device reconnected.' : state) });
            }
            if (state === 'error') {
                send(ws, { type: 'error', message: 'WASAPI capture failed.' });
                stopCapture(ws);
                return;
            }
            if (session.blocked) return;
            var frame;
            try { frame = session.capture.read(480); } catch (e) { frame = null; }
            if (frame == null || frame.length === 0) return;
            try {
                if (ws.write(frame) === false) {
                    session.blocked = true;
                    ws.once('drain', function () { if (ws._mcaudio === session) session.blocked = false; });
                }
            } catch (e) { session.blocked = true; }
        }, 10);
    } catch (e) {
        if (session != null && ws._mcaudio === session) {
            stopCapture(ws);
            try { delete ws._mcaudio; } catch (ignore) { ws._mcaudio = null; }
        }
        send(ws, { type: 'error', message: 'Could not start WASAPI capture: ' + errorText(e) });
    }
}

module.exports = { handleTunnelData: handleTunnelData, closeTunnel: closeTunnel };
