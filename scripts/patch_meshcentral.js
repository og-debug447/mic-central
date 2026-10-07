'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(root, 'meshrelay.js')) || !fs.existsSync(path.join(root, 'agents', 'meshcore.js'))) throw new Error('Pass a MeshCentral checkout root');
const workletSource = path.join(__dirname, '..', 'plugin', 'audio-worklet.js');
const workletTarget = path.join(root, 'public', 'scripts', 'mcaudio-worklet.js');
const viewModeSource = path.join(__dirname, '..', 'plugin', 'mcaudio-viewmode.js');
const viewModeTarget = path.join(root, 'public', 'scripts', 'mcaudio-viewmode.js');
if (fs.existsSync(workletTarget)) {
    const installed = fs.readFileSync(workletTarget, 'utf8');
    const expected = fs.readFileSync(workletSource, 'utf8');
    if (installed !== expected && !installed.includes('registerProcessor("mc-audio-pcm"')) throw new Error('MeshCentral public/scripts/mcaudio-worklet.js already exists and does not look like the MeshCentral Audio worklet');
}
fs.copyFileSync(workletSource, workletTarget);
if (fs.existsSync(viewModeTarget)) {
    const installed = fs.readFileSync(viewModeTarget, 'utf8');
    const expected = fs.readFileSync(viewModeSource, 'utf8');
    if (installed !== expected) throw new Error('MeshCentral public/scripts/mcaudio-viewmode.js already exists with different contents');
}
fs.copyFileSync(viewModeSource, viewModeTarget);
function edit(relativePath, transform) {
    const file = path.join(root, relativePath);
    const old = fs.readFileSync(file, 'utf8');
    const next = transform(old);
    if (old !== next) fs.writeFileSync(file, next, 'utf8');
}
edit('meshrelay.js', function (source) {
    if (source.includes('    if (protocol == 15) {')) {
        return source.replace(
            'if (rights == null || ((rights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEWONLY)) == 0) || ((rights & MESHRIGHT_NODESKTOP) != 0)) { return false; }',
            'if ((rights != MESHRIGHT_ADMIN) && (rights == null || ((rights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEWONLY)) == 0) || ((rights & MESHRIGHT_NODESKTOP) != 0))) { return false; }'
        );
    }
    const marker = 'function isProtocolAllowedByRights(rights, protocol) {';
    const at = source.indexOf(marker);
    if (at < 0) throw new Error('MeshRelay rights check changed');
    const body = source.indexOf('\n', at) + 1;
    const check = '    if (protocol == 15) {\r\n' +
        '        if ((rights != MESHRIGHT_ADMIN) && (rights == null || ((rights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEWONLY)) == 0) || ((rights & MESHRIGHT_NODESKTOP) != 0))) { return false; }\r\n' +
        '    }\r\n';
    return source.slice(0, body) + check + source.slice(body);
});
edit(path.join('agents', 'meshcore.js'), function (source) {
    if (!source.includes('require("win-audio").handleTunnelData(this, data)')) {
        const start = source.indexOf('        } else if (this.httprequest.protocol == 7) { // Plugin data exchange');
        const comment = source.indexOf('//sendConsoleText("Got tunnel #', start);
        const close = source.lastIndexOf('        }', comment);
        if (start < 0 || comment < 0 || close <= start) throw new Error('MeshCore tunnel dispatch changed');
        const lineEnd = source.indexOf('\n', close);
        if (lineEnd < 0 || source.slice(close, lineEnd).trim() !== '}') throw new Error('MeshCore tunnel dispatch boundary changed');
        const newline = source[lineEnd - 1] === '\r' ? '\r\n' : '\n';
        const branch = '        } else if (this.httprequest.protocol == 15) {' + newline +
            '            // Audio uses the authenticated relay and existing MeshAgent WebRTC DataChannel.' + newline +
            '            var rights = this.httprequest.rights;' + newline +
            '            if ((rights != MESHRIGHT_ADMIN) && (((rights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEW)) == 0) || ((rights & MESHRIGHT_NODESKTOP) != 0))) { this.httprequest.s.end(); return; }' + newline +
            '            this.descriptorMetadata = "Remote Audio";' + newline +
            '            try { require("win-audio").handleTunnelData(this, data); } catch (ex) {' + newline +
            '                try { this.write(JSON.stringify({ type: "error", message: "Audio capture is unavailable." })); } catch (e) { }' + newline +
            '            }' + newline +
            '        }' + newline;
        source = source.slice(0, close) + branch + source.slice(lineEnd + 1);
    }
    const closeMarker = 'function onTunnelClosed()';
    if (!source.includes('this.httprequest.protocol == 15) { try { require("win-audio").closeTunnel(this);')) {
        const at = source.indexOf(closeMarker);
        const brace = source.indexOf('{', at) + 1;
        if (at < 0 || brace <= 0) throw new Error('MeshCore close handler changed');
        const newline = source[brace] === '\r' ? '\r\n' : '\n';
        const cleanup = newline + '    if (this.httprequest && this.httprequest.protocol == 15) { try { require("win-audio").closeTunnel(this); } catch (ex) { } }';
        source = source.slice(0, brace) + cleanup + source.slice(brace);
    }
    return source;
});
edit(path.join('public', 'scripts', 'agent-redir-ws-0.1.1.js'), function (source) {
    const old = "obj.webchannel = obj.webrtc.createDataChannel('DataChannel', {}); // { ordered: false, maxRetransmits: 2 }";
    const next = "obj.webchannel = obj.webrtc.createDataChannel('DataChannel', obj.m.dataChannelOptions || {});";
    if (source.includes(next)) return source;
    if (!source.includes(old)) throw new Error('Browser DataChannel creation changed');
    return source.replace(old, next);
});

function addViewModeScript(source) {
    const marker = '<!-- MeshCentral Audio ViewMode controller -->';
    if (source.includes(marker)) {
        if (!source.includes('src="scripts/mcaudio-viewmode.js"')) throw new Error('MeshCentral ViewMode controller marker exists without its script include');
        return source;
    }
    const anchor = '<script type="text/javascript" src="scripts/agent-redir-ws-0.1.1{{{min}}}.js"></script>';
    if (!source.includes(anchor)) throw new Error('MeshCentral ViewMode relay script reference changed');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    return source.replace(anchor, anchor + newline + '    ' + marker + newline + '    <script type="text/javascript" src="scripts/mcaudio-viewmode.js"></script>');
}

function addViewModeButtons(source) {
    const marker = '<!-- MeshCentral Audio ViewMode buttons -->';
    if (source.includes(marker)) {
        if (!source.includes('id=MCAudioSpeakersButton') || !source.includes('id=MCAudioMicrophoneButton')) throw new Error('MeshCentral ViewMode button marker exists without both audio buttons');
        return source;
    }
    const anchor = '<input id=DeskToolsButton';
    if (!source.includes(anchor)) throw new Error('MeshCentral ViewMode toolbar anchor DeskToolsButton changed');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const buttons = '<!-- MeshCentral Audio ViewMode buttons -->' + newline +
        '                            <input id=MCAudioSpeakersButton type=button class="btn btn-primary btn-sm mx-1" value="Speakers" title="Listen to PC audio" onkeypress="return false" onkeydown="return false" onclick="if(window.mcaudioViewMode)window.mcaudioViewMode.open(\'loopback\')" style="display:none" />' + newline +
        '                            <input id=MCAudioMicrophoneButton type=button class="btn btn-primary btn-sm mx-1" value="Microphone" title="Listen to a microphone" onkeypress="return false" onkeydown="return false" onclick="if(window.mcaudioViewMode)window.mcaudioViewMode.open(\'microphone\')" style="display:none" />' + newline +
        '                            ';
    return source.replace(anchor, buttons + anchor);
}

function insertAfterLine(source, anchor, text, errorMessage) {
    const at = source.indexOf(anchor);
    if (at < 0) throw new Error(errorMessage);
    const lineEnd = source.indexOf('\n', at);
    if (lineEnd < 0) throw new Error(errorMessage);
    return source.slice(0, lineEnd + 1) + text + source.slice(lineEnd + 1);
}

function addViewModeLifecycle(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const updateMarker = '// MeshCentral Audio ViewMode visibility';
    if (!source.includes(updateMarker)) {
        const updateAnchor = "QV('DeskToolsButton', (currentNode.agent) && online);";
        const visibility = '            // MeshCentral Audio ViewMode visibility' + newline +
            '            var mcaudioAllowed = (rights == 0xFFFFFFFF) || (((rights & (8 | 256)) != 0) && ((rights & 65536) == 0));' + newline +
            '            var mcaudioVisible = (deskState == 3) && online && (currentNode.agent != null) && isWindowsNode(currentNode) && mcaudioAllowed;' + newline +
            "            QV('MCAudioSpeakersButton', mcaudioVisible);" + newline +
            "            QV('MCAudioMicrophoneButton', mcaudioVisible);" + newline;
        source = insertAfterLine(source, updateAnchor, visibility, 'MeshCentral updateDesktopButtons toolbar anchor changed');
    }
    const disconnectMarker = 'if (window.mcaudioViewMode) window.mcaudioViewMode.desktopDisconnected();';
    if (!source.includes(disconnectMarker)) {
        const functionStart = source.indexOf('function onDesktopStateChange(');
        const switchStart = source.indexOf('switch (state)', functionStart);
        const disconnectCase = source.indexOf('case 0:', switchStart);
        if (functionStart < 0 || switchStart < 0 || disconnectCase < 0) throw new Error('MeshCentral desktop disconnect lifecycle anchor changed');
        const lineEnd = source.indexOf('\n', disconnectCase);
        if (lineEnd < 0) throw new Error('MeshCentral desktop disconnect lifecycle anchor changed');
        source = source.slice(0, lineEnd + 1) + '                    ' + disconnectMarker + newline + source.slice(lineEnd + 1);
    }
    return source;
}

for (const template of ['views/default3.handlebars', 'views/default.handlebars']) {
    edit(template, function (source) {
        source = addViewModeScript(source);
        source = addViewModeButtons(source);
        return addViewModeLifecycle(source);
    });
}
