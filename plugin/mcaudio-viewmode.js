(function (root) {
    'use strict';

    if (root.mcaudioViewMode) return;

    var audioContext = null;
    var audioModulePromise = null;
    var dialogSource = 'loopback';
    var closing = false;

    function createSource(kind) {
        return {
            kind: kind,
            nodeId: null,
            session: null,
            devices: [],
            selectedDeviceId: null,
            sampleRate: kind === 'microphone' ? 16000 : 48000,
            channels: kind === 'microphone' ? 1 : 2,
            activeSampleRate: kind === 'microphone' ? 16000 : 48000,
            activeChannels: kind === 'microphone' ? 1 : 2,
            wantAudio: false,
            startingCapture: false,
            captureAttempt: 0,
            retryCount: 0,
            retryTimer: null,
            resumeAfterEnumeration: false,
            worklet: null,
            workletPromise: null,
            gainNode: null,
            status: 'Not connected'
        };
    }

    var sources = {
        loopback: createSource('loopback'),
        microphone: createSource('microphone')
    };

    function element(id) { return root.document.getElementById(id); }
    function activeSource() { return sources[dialogSource]; }

    function setStatus(source, message) {
        source.status = message;
        if (source.kind === dialogSource) {
            var status = element('mcaudioStatus');
            if (status) status.textContent = message;
        }
    }

    function isConnected(source) {
        return !!(source.session && source.session.redirect && source.session.redirect.State >= 3);
    }

    function send(source, message) {
        if (!isConnected(source)) return false;
        try { source.session.redirect.sendText(message); return true; } catch (e) { return false; }
    }

    function resetWorklet(source) {
        try { if (source.worklet) source.worklet.port.postMessage({ reset: true }); } catch (e) { }
    }

    function configureWorklet(source) {
        if (!source.worklet) return;
        try {
            source.worklet.port.postMessage({ configure: {
                sampleRate: source.sampleRate,
                channels: source.channels,
                targetBufferMs: source.kind === 'microphone' ? 100 : 30
            } });
        } catch (e) { }
    }

    function updateMixGain() {
        if (!audioContext) return;
        var activeCount = 0;
        for (var key in sources) {
            if (sources[key].startingCapture || (sources[key].wantAudio && isConnected(sources[key]))) activeCount++;
        }
        var gain = activeCount > 1 ? 0.5 : 1.0;
        for (var key2 in sources) {
            var node = sources[key2].gainNode;
            if (!node || !node.gain) continue;
            if (typeof node.gain.setTargetAtTime === 'function') node.gain.setTargetAtTime(gain, audioContext.currentTime, 0.02);
            else node.gain.value = gain;
        }
    }

    function releaseWorklet(source) {
        resetWorklet(source);
        try { if (source.worklet) source.worklet.disconnect(); } catch (e) { }
        try { if (source.gainNode) source.gainNode.disconnect(); } catch (e) { }
        source.worklet = null;
        source.workletPromise = null;
        source.gainNode = null;
    }

    function closeAudioContextIfIdle() {
        var source;
        for (var key in sources) {
            source = sources[key];
            if (source.wantAudio || source.startingCapture) return;
        }
        for (var key2 in sources) releaseWorklet(sources[key2]);
        if (audioContext) {
            try { audioContext.close(); } catch (e) { }
        }
        audioContext = null;
        audioModulePromise = null;
    }

    function renderDevices(source, allowDefault) {
        if (source.kind !== dialogSource) return;
        var select = element('mcaudioDevices');
        if (!select) return;
        while (select.options.length) select.remove(0);
        source.devices.forEach(function (device) {
            if (!device || typeof device.id !== 'string' || typeof device.name !== 'string') return;
            var option = root.document.createElement('option');
            option.value = device.id;
            option.textContent = device.name;
            select.appendChild(option);
        });
        if (source.selectedDeviceId) select.value = source.selectedDeviceId;
        else if (allowDefault && select.options.length) select.selectedIndex = 0;
        else select.selectedIndex = -1;
        if (!select.value && source.selectedDeviceId) source.selectedDeviceId = null;
        if (!source.selectedDeviceId && select.value) source.selectedDeviceId = select.value;
        updateControls();
    }

    function formatBitrate(sampleRate, channels) {
        var bitsPerSecond = sampleRate * channels * 16;
        if (bitsPerSecond >= 1000000) return (bitsPerSecond / 1000000).toFixed(3) + ' Mbps';
        return (bitsPerSecond / 1000).toFixed(1).replace(/\.0$/, '') + ' kbps';
    }

    function formatDescription(source) {
        return source.sampleRate.toLocaleString() + ' Hz, ' + (source.channels === 1 ? 'mono' : 'stereo') + ', ' + formatBitrate(source.sampleRate, source.channels) + ' PCM';
    }

    function updateBitrate(source) {
        if (source.kind !== dialogSource) return;
        var bitrate = element('mcaudioBitrate');
        if (bitrate) bitrate.textContent = formatBitrate(source.sampleRate, source.channels) + ' (16-bit PCM payload)';
    }

    function updateControls() {
        var source = activeSource();
        var sourceSelect = element('mcaudioSource');
        var deviceSelect = element('mcaudioDevices');
        var rateSelect = element('mcaudioSampleRate');
        var channelSelect = element('mcaudioChannels');
        var start = element('mcaudioStart');
        var stop = element('mcaudioStop');
        if (!source) return;
        if (sourceSelect) sourceSelect.value = dialogSource;
        if (deviceSelect) {
            if (source.selectedDeviceId && deviceSelect.value !== source.selectedDeviceId) deviceSelect.value = source.selectedDeviceId;
            deviceSelect.disabled = !isConnected(source) || deviceSelect.options.length === 0;
        }
        if (rateSelect) rateSelect.value = String(source.sampleRate);
        if (channelSelect) channelSelect.value = String(source.channels);
        if (start) start.disabled = !deviceSelect || !deviceSelect.value || source.wantAudio || source.startingCapture || !isConnected(source);
        if (stop) stop.disabled = !source.wantAudio && !source.startingCapture;
        updateBitrate(source);
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
        if (typeof root.setDialogMode === 'function') {
            root.setDialogMode(2, title, 2, null, body);
            return true;
        }
        return false;
    }

    function enumerateDevices(source) {
        if (!isConnected(source)) {
            if (!source.session || source.session.nodeId !== source.nodeId) connect(source, source.nodeId, false);
            else setStatus(source, 'Connecting to the authenticated agent tunnel…');
            return;
        }
        if (!send(source, { cmd: 'enumerate', kind: source.kind })) setStatus(source, 'The authenticated agent tunnel is not connected.');
        else setStatus(source, 'Finding audio devices…');
    }

    function stopCapture(source, message) {
        source.captureAttempt++;
        source.startingCapture = false;
        source.wantAudio = false;
        source.resumeAfterEnumeration = false;
        updateMixGain();
        send(source, { cmd: 'stop' });
        resetWorklet(source);
        if (message) setStatus(source, message);
        updateControls();
        closeAudioContextIfIdle();
    }

    function ensurePlayback(source) {
        var AudioContextType = root.AudioContext || root.webkitAudioContext;
        if (!AudioContextType || !root.AudioWorkletNode) return Promise.reject(new Error('This browser does not support AudioWorklet playback.'));

        if (!audioContext) {
            audioContext = new AudioContextType({ latencyHint: 'interactive' });
            audioModulePromise = null;
        }
        var context = audioContext;
        /* Resume synchronously during the Start button gesture. */
        var resumePromise = context.resume();
        if (source.worklet && source.worklet.context === context) {
            configureWorklet(source);
            return resumePromise;
        }
        if (source.workletPromise) return Promise.all([resumePromise, source.workletPromise]).then(function () { configureWorklet(source); });

        if (!audioModulePromise) {
            audioModulePromise = context.audioWorklet.addModule((root.domainUrl || '/') + 'scripts/mcaudio-worklet.js');
            audioModulePromise.catch(function () { audioModulePromise = null; });
        }
        var modulePromise = audioModulePromise;
        var nodePromise = modulePromise.then(function () {
            if (audioContext !== context || closing) throw new Error('The desktop session ended while starting playback.');
            var node = new root.AudioWorkletNode(context, 'mc-audio-pcm', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });
            source.worklet = node;
            source.gainNode = context.createGain();
            node.connect(source.gainNode);
            source.gainNode.connect(context.destination);
            configureWorklet(source);
            updateMixGain();
            return node;
        });
        source.workletPromise = nodePromise;
        nodePromise.then(function () {
            if (source.workletPromise === nodePromise) source.workletPromise = null;
        }, function () {
            if (source.workletPromise === nodePromise) source.workletPromise = null;
        });
        return Promise.all([resumePromise, nodePromise]).then(function () { configureWorklet(source); });
    }

    function startCapture(source, resuming) {
        var deviceId = source.selectedDeviceId;
        if (!deviceId || !isConnected(source)) {
            setStatus(source, 'Connect to the agent and select an audio device first.');
            return;
        }
        if (source.startingCapture) return;
        var activeSession = source.session;
        var attempt = ++source.captureAttempt;
        source.startingCapture = true;
        updateMixGain();
        updateControls();
        ensurePlayback(source).then(function () {
            if (attempt !== source.captureAttempt || source.session !== activeSession || activeSession.closing) {
                closeAudioContextIfIdle();
                return;
            }
            if (!send(source, {
                cmd: 'start', kind: source.kind, deviceId: deviceId,
                sampleRate: source.sampleRate, channels: source.channels
            })) {
                source.startingCapture = false;
                updateMixGain();
                setStatus(source, 'The authenticated agent tunnel is not connected.');
                updateControls();
                closeAudioContextIfIdle();
                return;
            }
            source.activeSampleRate = source.sampleRate;
            source.activeChannels = source.channels;
            source.startingCapture = false;
            source.wantAudio = true;
            updateMixGain();
            updateControls();
            setStatus(source, (resuming ? 'Reconnected; resuming audio. ' : 'Starting audio. ') + formatDescription(source));
        }).catch(function (error) {
            if (attempt !== source.captureAttempt) return;
            source.startingCapture = false;
            source.wantAudio = false;
            updateMixGain();
            updateControls();
            setStatus(source, 'Browser audio playback could not start: ' + error.message);
            closeAudioContextIfIdle();
        });
    }

    function onMessage(source, activeSession, data) {
        if (source.session !== activeSession || activeSession.closing) return;
        var message;
        try { message = JSON.parse(data); } catch (e) { return; }
        if (message.type === 'devices') {
            var resumeDeviceId = source.selectedDeviceId;
            var shouldResume = source.resumeAfterEnumeration && source.wantAudio;
            source.resumeAfterEnumeration = false;
            source.devices = Array.isArray(message.devices) ? message.devices : [];
            var found = !resumeDeviceId || source.devices.some(function (device) { return device && device.id === resumeDeviceId; });
            if (shouldResume && !found) {
                source.wantAudio = false;
                source.selectedDeviceId = null;
                updateMixGain();
                resetWorklet(source);
                setStatus(source, 'The selected device is no longer available. Choose a device and start again.');
            }
            if (source.kind === dialogSource) renderDevices(source, !shouldResume || !found);
            if (shouldResume && found) {
                setStatus(source, 'Reconnected; resuming audio…');
                startCapture(source, true);
            } else if (!shouldResume) {
                if (source.wantAudio) setStatus(source, 'Audio is playing. ' + formatDescription(source));
                else setStatus(source, source.devices.length ? 'Choose a device, then start listening.' : 'No active audio devices found.');
            }
            updateControls();
        } else if (message.type === 'state') {
            if (message.state === 'running') setStatus(source, 'Audio is playing. ' + formatDescription(source));
            else if (message.state === 'device-lost') setStatus(source, 'The device disconnected; waiting for it to return.');
            else if (message.state === 'reconnected') setStatus(source, 'The audio device reconnected.');
            else if (message.state === 'stopped') setStatus(source, 'Audio stopped.');
            else setStatus(source, message.message || message.state || 'Audio status changed.');
        } else if (message.type === 'error') {
            if (message.operation !== 'enumerate') {
                source.startingCapture = false;
                source.wantAudio = false;
                source.captureAttempt++;
                updateMixGain();
                resetWorklet(source);
                closeAudioContextIfIdle();
            }
            updateControls();
            setStatus(source, 'Audio error: ' + (message.message || 'Unknown error'));
        }
    }

    function connect(source, nodeId, reconnecting) {
        if (typeof root.CreateAgentRedirect !== 'function' || !root.meshserver) {
            setStatus(source, 'MeshCentral agent relay support is unavailable.');
            return;
        }
        if (source.retryTimer != null) { root.clearTimeout(source.retryTimer); source.retryTimer = null; }
        if (source.session) {
            source.session.closing = true;
            try { source.session.redirect.Stop(); } catch (e) { }
        }
        closing = false;
        source.nodeId = nodeId;
        source.resumeAfterEnumeration = reconnecting && source.wantAudio;
        var activeSession = { nodeId: nodeId, redirect: null, closing: false };
        var module = {
            protocol: 15,
            dataChannelOptions: { ordered: true },
            ProcessData: function (data) { onMessage(source, activeSession, data); },
            ProcessBinaryData: function (bytes) {
                if (source.session !== activeSession || activeSession.closing || !source.wantAudio || !source.worklet || !bytes || bytes.byteLength < 2) return;
                var bytesPerFrame = source.activeChannels * 2;
                var byteLength = bytes.byteLength - (bytes.byteLength % bytesPerFrame);
                if (byteLength < bytesPerFrame) return;
                var view = new DataView(bytes.buffer, bytes.byteOffset, byteLength);
                var sampleCount = byteLength / 2;
                var samples = new Float32Array(sampleCount);
                for (var i = 0; i < sampleCount; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
                try { source.worklet.port.postMessage(samples, [samples.buffer]); } catch (e) { }
            },
            xxStateChange: function (state) {
                if (source.session !== activeSession || activeSession.closing) return;
                if (state === 3) {
                    source.retryCount = 0;
                    source.resumeAfterEnumeration = reconnecting && source.wantAudio;
                    setStatus(source, 'Connected; finding audio devices…');
                    send(source, { cmd: 'enumerate', kind: source.kind });
                    updateControls();
                } else if (state === 0) {
                    if (source.startingCapture) {
                        source.startingCapture = false;
                        source.captureAttempt++;
                    }
                    updateMixGain();
                    resetWorklet(source);
                    setStatus(source, 'Audio connection interrupted; reconnecting…');
                    updateControls();
                    if (source.retryTimer != null) return;
                    if (source.retryCount >= 6) {
                        activeSession.closing = true;
                        try { if (activeSession.redirect) activeSession.redirect.Stop(); } catch (e) { }
                        source.session = null;
                        source.wantAudio = false;
                        source.startingCapture = false;
                        updateMixGain();
                        source.resumeAfterEnumeration = false;
                        releaseWorklet(source);
                        setStatus(source, 'Audio could not reconnect. Close this dialog and open it again to retry.');
                        updateControls();
                        closeAudioContextIfIdle();
                        return;
                    }
                    var delay = Math.min(1000 * Math.pow(2, source.retryCount), 10000);
                    source.retryCount++;
                    source.retryTimer = root.setTimeout(function () {
                        source.retryTimer = null;
                        if (source.session !== activeSession || activeSession.closing) return;
                        activeSession.closing = true;
                        try { activeSession.redirect.Stop(); } catch (e) { }
                        source.session = null;
                        connect(source, nodeId, true);
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
        source.session = activeSession;
        activeSession.redirect.Start(nodeId);
        setStatus(source, 'Connecting to the authenticated agent tunnel…');
        updateControls();
    }

    function onSourceChanged(sourceKind) {
        if (sourceKind !== 'loopback' && sourceKind !== 'microphone') return;
        dialogSource = sourceKind;
        var source = activeSource();
        renderDevices(source, false);
        var rate = element('mcaudioSampleRate');
        var channels = element('mcaudioChannels');
        if (rate) rate.value = String(source.sampleRate);
        if (channels) channels.value = String(source.channels);
        updateBitrate(source);
        if (!source.session || source.session.nodeId !== root.currentNode._id || !source.session.redirect || source.session.redirect.State === 0) {
            connect(source, root.currentNode._id, false);
        } else if (isConnected(source)) {
            if (source.wantAudio) setStatus(source, 'Audio is playing. ' + formatDescription(source));
            else if (source.startingCapture) setStatus(source, 'Starting audio…');
            else enumerateDevices(source);
        } else {
            setStatus(source, 'Connecting to the authenticated agent tunnel…');
        }
        updateControls();
    }

    function changeFormat(source) {
        var rate = element('mcaudioSampleRate');
        var channels = element('mcaudioChannels');
        var sampleRate = rate ? parseInt(rate.value, 10) : source.sampleRate;
        var channelCount = channels ? parseInt(channels.value, 10) : source.channels;
        if ([8000, 16000, 24000, 32000, 44100, 48000].indexOf(sampleRate) < 0 || (channelCount !== 1 && channelCount !== 2)) return;
        var wasRunning = source.wantAudio || source.startingCapture;
        if (wasRunning) stopCapture(source, 'Format changed. Press Start listening to apply it.');
        source.sampleRate = sampleRate;
        source.channels = channelCount;
        configureWorklet(source);
        updateBitrate(source);
        updateControls();
        if (!wasRunning) setStatus(source, 'Audio format: ' + formatDescription(source));
    }

    function open(kind) {
        if (kind !== 'loopback' && kind !== 'microphone') return false;
        if (!root.currentNode || !root.currentNode._id || !root.currentNode.agent) {
            if (root.document.getElementById('mcaudioStatus')) setStatus(activeSource(), 'Audio is available for connected Windows MeshAgents.');
            return false;
        }
        if (typeof root.xxdialogMode !== 'undefined' && root.xxdialogMode) return false;
        if (typeof root.isWindowsNode === 'function' && !root.isWindowsNode(root.currentNode)) return false;

        dialogSource = kind;
        var source = activeSource();
        var title = (kind === 'loopback') ? 'Remote speakers' : 'Remote microphone';
        var rates = [8000, 16000, 24000, 32000, 44100, 48000];
        var rateOptions = rates.map(function (rate) {
            return '<option value="' + rate + '">' + rate.toLocaleString() + ' Hz</option>';
        }).join('');
        var body = '<div class="mb-3"><label for="mcaudioSource" class="form-label">Audio source</label>' +
            '<select id="mcaudioSource" class="form-select"><option value="loopback">PC audio (speakers)</option><option value="microphone">Microphone</option></select></div>' +
            '<div class="mb-3"><label for="mcaudioDevices" class="form-label">Device</label>' +
            '<select id="mcaudioDevices" class="form-select" disabled></select></div>' +
            '<div class="row mb-2"><div class="col"><label for="mcaudioSampleRate" class="form-label">Sample rate</label>' +
            '<select id="mcaudioSampleRate" class="form-select">' + rateOptions + '</select></div>' +
            '<div class="col"><label for="mcaudioChannels" class="form-label">Channels</label>' +
            '<select id="mcaudioChannels" class="form-select"><option value="1">Mono</option><option value="2">Stereo</option></select></div></div>' +
            '<p class="mb-2">PCM bitrate: <strong id="mcaudioBitrate"></strong></p>' +
            '<p class="mb-2">Microphone starts at 16,000 Hz mono with a 100 ms playback buffer; PC audio starts at 48,000 Hz stereo.</p>' +
            '<p class="mb-2">Speakers and microphone can run together. Settings apply to the selected source.</p>' +
            '<div class="d-flex gap-2 mb-2"><button id="mcaudioStart" type="button" class="btn btn-primary" disabled>Start listening</button>' +
            '<button id="mcaudioStop" type="button" class="btn btn-secondary" disabled>Stop</button></div>' +
            '<p id="mcaudioStatus" class="mb-0" role="status"></p>';
        if (!showAudioDialog(title, body)) return false;

        var sourceSelect = element('mcaudioSource');
        var deviceSelect = element('mcaudioDevices');
        var rateSelect = element('mcaudioSampleRate');
        var channelSelect = element('mcaudioChannels');
        var startButton = element('mcaudioStart');
        var stopButton = element('mcaudioStop');
        sourceSelect.value = kind;
        renderDevices(source, false);
        rateSelect.value = String(source.sampleRate);
        channelSelect.value = String(source.channels);
        updateBitrate(source);
        sourceSelect.addEventListener('change', function () { onSourceChanged(sourceSelect.value); });
        deviceSelect.addEventListener('change', function () {
            var current = activeSource();
            if (current.wantAudio || current.startingCapture) stopCapture(current, 'Device changed. Press Start listening to apply it.');
            current.selectedDeviceId = deviceSelect.value || null;
            updateControls();
            setStatus(current, current.selectedDeviceId ? 'Device selected. Press Start listening.' : 'Choose an audio device.');
        });
        rateSelect.addEventListener('change', function () { changeFormat(activeSource()); });
        channelSelect.addEventListener('change', function () { changeFormat(activeSource()); });
        startButton.addEventListener('click', function () { startCapture(activeSource(), false); });
        stopButton.addEventListener('click', function () { stopCapture(activeSource(), 'Audio stopped.'); });

        if (!source.session || source.session.nodeId !== root.currentNode._id || !source.session.redirect || source.session.redirect.State === 0) {
            connect(source, root.currentNode._id, false);
        } else if (isConnected(source) && !source.wantAudio && !source.startingCapture) {
            renderDevices(source, false);
            enumerateDevices(source);
        } else if (isConnected(source)) {
            renderDevices(source, false);
            setStatus(source, 'Audio is playing. ' + formatDescription(source));
        } else {
            setStatus(source, 'Connecting to the authenticated agent tunnel…');
        }
        updateControls();
        return false;
    }

    function shutdown() {
        closing = true;
        for (var key in sources) {
            var source = sources[key];
            source.captureAttempt++;
            source.wantAudio = false;
            source.startingCapture = false;
            source.resumeAfterEnumeration = false;
            if (source.retryTimer != null) { root.clearTimeout(source.retryTimer); source.retryTimer = null; }
            if (source.session) {
                source.session.closing = true;
                try { if (isConnected(source)) source.session.redirect.sendText({ cmd: 'stop' }); } catch (e) { }
                try { source.session.redirect.Stop(); } catch (e) { }
                source.session = null;
            }
            releaseWorklet(source);
        }
        if (audioContext) {
            try { audioContext.close(); } catch (e) { }
        }
        audioContext = null;
        audioModulePromise = null;
        updateControls();
    }

    root.mcaudioViewMode = { open: open, desktopDisconnected: shutdown };
    root.addEventListener('beforeunload', shutdown);
})(window);
