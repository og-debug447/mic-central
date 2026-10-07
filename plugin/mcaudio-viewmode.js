(function (root) {
    'use strict';

    if (root.mcaudioViewMode) return;

    var session = null;
    var audioContext = null;
    var worklet = null;
    var playbackPromise = null;
    var sourceKind = 'loopback';
    var selectedDeviceId = null;
    var devices = [];
    var wantAudio = false;
    var startingCapture = false;
    var captureAttempt = 0;
    var retryCount = 0;
    var retryTimer = null;
    var closing = false;

    function element(id) { return root.document.getElementById(id); }

    function setStatus(message) {
        var status = element('mcaudioStatus');
        if (status) status.textContent = message;
    }

    function send(message) {
        if (!session || !session.redirect || session.redirect.State < 3) return false;
        try { session.redirect.sendText(message); return true; } catch (e) { return false; }
    }

    function resetAudio() {
        try { if (worklet) worklet.port.postMessage({ reset: true }); } catch (e) { }
    }

    function closePlayback() {
        resetAudio();
        try { if (worklet) worklet.disconnect(); } catch (e) { }
        try { if (audioContext) audioContext.close(); } catch (e) { }
        worklet = null;
        audioContext = null;
        playbackPromise = null;
    }

    function renderDevices(allowDefault) {
        var select = element('mcaudioDevices');
        if (!select) return;
        while (select.options.length) select.remove(0);
        devices.forEach(function (device) {
            if (!device || typeof device.id !== 'string' || typeof device.name !== 'string') return;
            var option = root.document.createElement('option');
            option.value = device.id;
            option.textContent = device.name;
            select.appendChild(option);
        });
        if (selectedDeviceId) select.value = selectedDeviceId;
        else if (select.options.length && allowDefault) select.selectedIndex = 0;
        else select.selectedIndex = -1;
        if (!select.value && selectedDeviceId) selectedDeviceId = null;
        if (!selectedDeviceId && select.value) selectedDeviceId = select.value;
        updateControls();
    }

    function isTunnelConnected() {
        return !!(session && session.redirect && session.redirect.State >= 3);
    }

    function showAudioDialog(title, body) {
        if (typeof root.setModalContent === 'function' && typeof root.showModal === 'function') {
            root.setModalContent('xxAddAgent', title, body, 'small');
            root.showModal('xxAddAgentModal', 'idx_dlgOkButton');
            var closeButton = element('idx_dlgOkButton');
            if (closeButton) closeButton.textContent = 'Close';
            if (typeof root.QV === 'function') root.QV('idx_dlgCancelButton', false);
            return true;
        }
        // The classic MeshCentral ViewMode template uses its original dialog
        // system. It is still a first-party modal, with its normal Close button.
        if (typeof root.setDialogMode === 'function') {
            root.setDialogMode(2, title, 2, null, body);
            return true;
        }
        return false;
    }

    function updateControls() {
        var source = element('mcaudioSource');
        var select = element('mcaudioDevices');
        var start = element('mcaudioStart');
        var stop = element('mcaudioStop');
        if (source) source.value = sourceKind;
        if (select) {
            if (selectedDeviceId && select.value !== selectedDeviceId) select.value = selectedDeviceId;
            select.disabled = !isTunnelConnected() || (select.options.length === 0);
        }
        if (start) start.disabled = !select || !select.value || wantAudio || startingCapture || !isTunnelConnected();
        if (stop) stop.disabled = !wantAudio && !startingCapture;
    }

    function requestDevices() {
        if (wantAudio) {
            send({ cmd: 'stop' });
            wantAudio = false;
            resetAudio();
        }
        startingCapture = false;
        captureAttempt++;
        devices = [];
        selectedDeviceId = null;
        renderDevices();
        if (!send({ cmd: 'enumerate', kind: sourceKind })) {
            setStatus('Connecting to the authenticated agent tunnel…');
        } else {
            setStatus('Finding audio devices…');
        }
        updateControls();
    }

    function ensurePlayback() {
        if (audioContext && worklet) return audioContext.resume();
        if (playbackPromise) return playbackPromise;
        var AudioContextType = root.AudioContext || root.webkitAudioContext;
        if (!AudioContextType || !root.AudioWorkletNode) return Promise.reject(new Error('This browser does not support AudioWorklet playback.'));

        var context = new AudioContextType({ latencyHint: 'interactive' });
        audioContext = context;
        /* Resume during the Start button gesture, before the worklet fetch. */
        var resumePromise = context.resume();
        var setup = context.audioWorklet.addModule((root.domainUrl || '/') + 'scripts/mcaudio-worklet.js').then(function () {
            if (audioContext !== context || closing) throw new Error('The desktop session ended while starting playback.');
            worklet = new root.AudioWorkletNode(context, 'mc-audio-pcm', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });
            worklet.connect(context.destination);
            return Promise.all([resumePromise, context.resume()]);
        }).catch(function (error) {
            if (audioContext === context) {
                try { if (worklet) worklet.disconnect(); } catch (e) { }
                worklet = null;
                audioContext = null;
            }
            try { context.close(); } catch (e) { }
            throw error;
        });
        playbackPromise = setup;
        setup.then(function () { if (playbackPromise === setup) playbackPromise = null; }, function () { if (playbackPromise === setup) playbackPromise = null; });
        return setup;
    }

    function startCapture(resuming) {
        var select = element('mcaudioDevices');
        var deviceId = selectedDeviceId || (select && select.value);
        if (!deviceId || !isTunnelConnected()) {
            setStatus('Connect to the agent and select an audio device first.');
            return;
        }
        if (startingCapture) return;
        selectedDeviceId = deviceId;
        var activeSession = session;
        var attempt = ++captureAttempt;
        startingCapture = true;
        updateControls();
        ensurePlayback().then(function () {
            if (attempt !== captureAttempt || session !== activeSession || activeSession.closing) return;
            if (!send({ cmd: 'start', kind: sourceKind, deviceId: deviceId })) {
                startingCapture = false;
                setStatus('The authenticated agent tunnel is not connected.');
                updateControls();
                return;
            }
            startingCapture = false;
            wantAudio = true;
            updateControls();
            setStatus(resuming ? 'Reconnected; resuming audio…' : 'Starting audio…');
        }).catch(function (error) {
            if (attempt !== captureAttempt) return;
            startingCapture = false;
            wantAudio = false;
            updateControls();
            setStatus('Browser audio playback could not start: ' + error.message);
        });
    }

    function onMessage(activeSession, data) {
        if (session !== activeSession || activeSession.closing) return;
        var message;
        try { message = JSON.parse(data); } catch (e) { return; }
        if (message.type === 'devices') {
            var resumeDeviceId = selectedDeviceId;
            var resumeAudio = wantAudio;
            devices = Array.isArray(message.devices) ? message.devices : [];
            renderDevices(!resumeAudio);
            if (resumeAudio && resumeDeviceId) {
                var found = devices.some(function (device) { return device && device.id === resumeDeviceId; });
                if (found) {
                    selectedDeviceId = resumeDeviceId;
                    var select = element('mcaudioDevices');
                    if (select) select.value = resumeDeviceId;
                    setStatus('Reconnected; resuming audio…');
                    startCapture(true);
                } else {
                    wantAudio = false;
                    selectedDeviceId = null;
                    renderDevices(true);
                    updateControls();
                    setStatus('The selected device is no longer available. Choose a device and start again.');
                }
            } else {
                setStatus(devices.length ? 'Choose a device, then start listening.' : 'No active audio devices found.');
            }
        } else if (message.type === 'state') {
            if (message.state === 'running') setStatus('Audio is playing.');
            else if (message.state === 'device-lost') setStatus('The device disconnected; waiting for it to return.');
            else if (message.state === 'reconnected') setStatus('The audio device reconnected.');
            else setStatus(message.message || message.state || 'Audio status changed.');
        } else if (message.type === 'error') {
            startingCapture = false;
            captureAttempt++;
            wantAudio = false;
            resetAudio();
            updateControls();
            setStatus('Audio error: ' + (message.message || 'Unknown error'));
        }
    }

    function connect(nodeId) {
        if (typeof root.CreateAgentRedirect !== 'function' || !root.meshserver) {
            setStatus('MeshCentral agent relay support is unavailable.');
            return;
        }
        closing = false;
        var activeSession = { nodeId: nodeId, redirect: null, closing: false };
        var module = {
            protocol: 15,
            dataChannelOptions: { ordered: true },
            ProcessData: function (data) { onMessage(activeSession, data); },
            ProcessBinaryData: function (bytes) {
                if (session !== activeSession || activeSession.closing || !worklet || !bytes || bytes.byteLength < 4) return;
                var byteLength = bytes.byteLength & ~1;
                var view = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
                var samples = new Float32Array(byteLength / 2);
                for (var i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
                try { worklet.port.postMessage(samples, [samples.buffer]); } catch (e) { }
            },
            xxStateChange: function (state) {
                if (session !== activeSession || activeSession.closing) return;
                if (state === 3) {
                    retryCount = 0;
                    setStatus('Connected; finding audio devices…');
                    send({ cmd: 'enumerate', kind: sourceKind });
                    updateControls();
                } else if (state === 0) {
                    if (startingCapture) {
                        startingCapture = false;
                        captureAttempt++;
                    }
                    resetAudio();
                    setStatus('Audio connection interrupted; reconnecting…');
                    updateControls();
                    if (retryTimer != null) return;
                    if (retryCount >= 6) {
                        activeSession.closing = true;
                        try { if (activeSession.redirect) activeSession.redirect.Stop(); } catch (e) { }
                        session = null;
                        startingCapture = false;
                        wantAudio = false;
                        resetAudio();
                        setStatus('Audio could not reconnect. Close this dialog and open it again to retry.');
                        updateControls();
                        return;
                    }
                    var delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                    retryCount++;
                    retryTimer = root.setTimeout(function () {
                        retryTimer = null;
                        if (session !== activeSession || activeSession.closing) return;
                        activeSession.closing = true;
                        try { activeSession.redirect.Stop(); } catch (e) { }
                        session = null;
                        connect(nodeId);
                    }, delay);
                }
            }
        };
        activeSession.redirect = root.CreateAgentRedirect(
            root.meshserver,
            module,
            root.serverPublicNamePort,
            root.authCookie,
            root.authRelayCookie,
            root.domainUrl
        );
        session = activeSession;
        activeSession.redirect.Start(nodeId);
        setStatus('Connecting to the authenticated agent tunnel…');
        updateControls();
    }

    function open(kind) {
        if (kind !== 'loopback' && kind !== 'microphone') return false;
        if (!root.currentNode || !root.currentNode._id || !root.currentNode.agent) {
            setStatus('Audio is available for connected Windows MeshAgents.');
            return false;
        }
        if (typeof root.xxdialogMode !== 'undefined' && root.xxdialogMode) return false;

        if (session && session.nodeId !== root.currentNode._id) shutdown();
        if (sourceKind !== kind) {
            devices = [];
            selectedDeviceId = null;
        }
        sourceKind = kind;
        var title = (kind === 'loopback') ? 'Remote speakers' : 'Remote microphone';
        var body = '<div class="mb-3"><label for="mcaudioSource" class="form-label">Audio source</label>' +
            '<select id="mcaudioSource" class="form-select"><option value="loopback">PC audio (speakers)</option><option value="microphone">Microphone</option></select></div>' +
            '<div class="mb-3"><label for="mcaudioDevices" class="form-label">Device</label>' +
            '<select id="mcaudioDevices" class="form-select" disabled><option>Finding devices…</option></select></div>' +
            '<div class="d-flex gap-2 mb-3"><button id="mcaudioStart" type="button" class="btn btn-primary" disabled>Start listening</button>' +
            '<button id="mcaudioStop" type="button" class="btn btn-secondary" disabled>Stop</button></div>' +
            '<p id="mcaudioStatus" class="mb-0" role="status">Connecting…</p>';
        if (!showAudioDialog(title, body)) return false;

        var sourceSelect = element('mcaudioSource');
        var deviceSelect = element('mcaudioDevices');
        var startButton = element('mcaudioStart');
        var stopButton = element('mcaudioStop');
        sourceSelect.value = sourceKind;
        sourceSelect.addEventListener('change', function () {
            sourceKind = sourceSelect.value;
            requestDevices();
        });
        deviceSelect.addEventListener('change', function () {
            if (wantAudio) {
                send({ cmd: 'stop' });
                wantAudio = false;
                resetAudio();
            }
            startingCapture = false;
            captureAttempt++;
            selectedDeviceId = deviceSelect.value || null;
            updateControls();
            setStatus(selectedDeviceId ? 'Device selected. Press Start listening.' : 'Choose an audio device.');
        });
        startButton.addEventListener('click', function () { startCapture(false); });
        stopButton.addEventListener('click', function () {
            startingCapture = false;
            captureAttempt++;
            wantAudio = false;
            send({ cmd: 'stop' });
            resetAudio();
            updateControls();
            setStatus('Audio stopped.');
        });

        renderDevices();
        if (!session || session.nodeId !== root.currentNode._id || !session.redirect || session.redirect.State === 0) {
            connect(root.currentNode._id);
        } else if (session.redirect.State >= 3) {
            requestDevices();
        } else {
            setStatus('Connecting to the authenticated agent tunnel…');
        }
        return false;
    }

    function shutdown() {
        closing = true;
        wantAudio = false;
        startingCapture = false;
        captureAttempt++;
        if (retryTimer != null) { root.clearTimeout(retryTimer); retryTimer = null; }
        if (session) {
            session.closing = true;
            try { if (session.redirect && session.redirect.State >= 3) session.redirect.sendText({ cmd: 'stop' }); } catch (e) { }
            try { if (session.redirect) session.redirect.Stop(); } catch (e) { }
            session = null;
        }
        closePlayback();
        updateControls();
    }

    root.mcaudioViewMode = { open: open, desktopDisconnected: shutdown };
    root.addEventListener('beforeunload', shutdown);
})(window);
