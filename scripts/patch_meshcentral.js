'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(root, 'meshrelay.js')) || !fs.existsSync(path.join(root, 'agents', 'meshcore.js'))) throw new Error('Pass a MeshCentral checkout root');
const workletSource = path.join(__dirname, '..', 'plugin', 'audio-worklet.js');
const workletTarget = path.join(root, 'public', 'scripts', 'mcaudio-worklet.js');
if (fs.existsSync(workletTarget) && !fs.readFileSync(workletTarget, 'utf8').equals(fs.readFileSync(workletSource, 'utf8'))) throw new Error('MeshCentral public/scripts/mcaudio-worklet.js already exists with different contents');
fs.copyFileSync(workletSource, workletTarget);
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
