'use strict';

function send(ws, value) {
    try { ws.write(JSON.stringify(value)); } catch (e) { }
}

function validKind(kind) {
    return kind === 'microphone' || kind === 'loopback';
}

function validSampleRate(sampleRate) {
    return typeof sampleRate === 'number' && sampleRate === Math.floor(sampleRate) && [8000, 16000, 24000, 32000, 44100, 48000].indexOf(sampleRate) >= 0;
}

function validChannels(channels) {
    return channels === 1 || channels === 2;
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
        if (!validKind(message.kind)) { send(ws, { type: 'error', operation: 'enumerate', message: 'Invalid audio source.' }); return; }
        try {
            var devices = require('wasapi').enumerate(message.kind);
            send(ws, { type: 'devices', kind: message.kind, devices: devices });
        } catch (e) { send(ws, { type: 'error', operation: 'enumerate', message: 'Could not enumerate audio devices.' }); }
        return;
    }

    if (message.cmd === 'stop') {
        stopCapture(ws);
        send(ws, { type: 'state', state: 'stopped', message: 'Capture stopped.' });
        return;
    }

    if (message.cmd !== 'start' || !validKind(message.kind) || typeof message.deviceId !== 'string' || message.deviceId.length < 1 || message.deviceId.length > 1024) {
        send(ws, { type: 'error', operation: 'command', message: 'Invalid audio command.' });
        return;
    }

    // Keep older browser clients working at the original full-quality format.
    var sampleRate = (message.sampleRate === undefined) ? 48000 : message.sampleRate;
    var channels = (message.channels === undefined) ? 2 : message.channels;
    if (!validSampleRate(sampleRate) || !validChannels(channels)) {
        send(ws, { type: 'error', operation: 'start', message: 'Unsupported PCM sample rate or channel count.' });
        return;
    }

    stopCapture(ws);
    var session = null;
    try {
        var wasapi = require('wasapi');
        var available = wasapi.enumerate(message.kind);
        var found = false;
        for (var i = 0; i < available.length; i++) { if (available[i].id === message.deviceId) { found = true; break; } }
        if (!found) { send(ws, { type: 'error', operation: 'start', message: 'The selected audio device is unavailable.' }); return; }

        session = {
            capture: wasapi.createCapture(message.kind, message.deviceId, sampleRate, channels),
            timer: null, lastState: null, blocked: false,
            sampleRate: sampleRate, channels: channels,
            lastPollTime: 0,
            stats: newCaptureStats(Date.now())
        };
        ws._mcaudio = session;
        session.capture.start();
        session.timer = setInterval(function () {
            if (ws._mcaudio !== session) return;
            var now = Date.now();
            session.stats.polls++;
            if (session.lastPollTime !== 0) {
                var intervalMs = now - session.lastPollTime;
                if (intervalMs > session.stats.maxIntervalMs) session.stats.maxIntervalMs = intervalMs;
                if (intervalMs > 20) session.stats.latePolls++;
            }
            session.lastPollTime = now;
            var state;
            try { state = session.capture.getState(); } catch (e) { state = 'error'; }
            if (state !== session.lastState) {
                session.lastState = state;
                send(ws, { type: 'state', state: state, message: (state === 'device-lost') ? 'Device disconnected; waiting for it to return.' : (state === 'reconnected' ? 'Audio device reconnected.' : state) });
            }
            if (state === 'error') {
                send(ws, { type: 'error', operation: 'capture', message: 'WASAPI capture failed.' });
                stopCapture(ws);
                return;
            }
            if (session.blocked) {
                session.stats.blockedPolls++;
                if (session.stats.polls >= 200) sendCaptureStats(ws, session);
                return;
            }
            var frame;
            try { frame = session.capture.read(session.sampleRate / 100); } catch (e) { frame = null; }
            if (frame == null || frame.length === 0) {
                session.stats.emptyReads++;
                if (session.stats.polls >= 200) sendCaptureStats(ws, session);
                return;
            }
            var expectedBytes = (session.sampleRate / 100) * session.channels * 2;
            if (frame.length < expectedBytes) session.stats.partialReads++;
            session.stats.frames += frame.length / (session.channels * 2);
            try {
                if (ws.write(frame) === false) {
                    session.blocked = true;
                    ws.once('drain', function () { if (ws._mcaudio === session) session.blocked = false; });
                }
            } catch (e) { session.blocked = true; }
            if (session.stats.polls >= 200) sendCaptureStats(ws, session);
        }, 10);
    } catch (e) {
        if (session != null && ws._mcaudio === session) {
            stopCapture(ws);
            try { delete ws._mcaudio; } catch (ignore) { ws._mcaudio = null; }
        }
        send(ws, { type: 'error', operation: 'start', message: 'Could not start WASAPI capture: ' + errorText(e) });
    }
}

function sendCaptureStats(ws, session) {
    var stats = session.stats;
    send(ws, {
        type: 'captureStats',
        sampleRate: session.sampleRate,
        polls: stats.polls,
        elapsedMs: Date.now() - stats.windowStart,
        emptyReads: stats.emptyReads,
        partialReads: stats.partialReads,
        blockedPolls: stats.blockedPolls,
        latePolls: stats.latePolls,
        maxIntervalMs: stats.maxIntervalMs,
        capturedFrames: Math.round(stats.frames)
    });
    session.stats = newCaptureStats(Date.now());
}

function newCaptureStats(now) {
    return { windowStart: now, polls: 0, emptyReads: 0, partialReads: 0, blockedPolls: 0, latePolls: 0, maxIntervalMs: 0, frames: 0 };
}

module.exports = { handleTunnelData: handleTunnelData, closeTunnel: closeTunnel };
