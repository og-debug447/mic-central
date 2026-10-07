# Architecture

## Supported integration point

MeshCentral's documented plugin API can register device tabs and invoke plugin lifecycle hooks, but the inspected source does not expose a supported ViewMode/PC Control toolbar extension point. The UI therefore adds two buttons directly to MeshCentral's existing `views/default.handlebars` and `views/default3.handlebars` templates. Clicking either button opens MeshCentral's own modal with source selection, endpoint selection, and Start/Stop controls. The old Audio device tab and separate controls window are not used. The patch uses source anchors and does not poll or mutate the DOM. These template edits are version-sensitive and must be reapplied after MeshCentral updates; the patch fails if expected anchors are missing.

## Audio path

On Windows, microphone input is captured from a selected active `eCapture` Core Audio endpoint. If the endpoint does not support 48 kHz stereo PCM directly, shared-mode WASAPI asks the Windows audio engine to convert it; drivers that reject these flags fall back to the native mix format and the module's software conversion. Capture runs under the Windows MMCSS `Pro Audio` task when available. System output is captured from a selected active render endpoint through shared-mode WASAPI loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`). Both paths produce signed 16-bit little-endian, 48 kHz stereo PCM at an actual payload rate of 1,536,000 bit/s before transport overhead. The AudioWorklet runs in the existing desktop-view page, so audio can play while the remote screen stays open. Closing the modal leaves the stream running; use Stop or disconnect the desktop to stop it.

The capture worker uses a bounded 100 ms PCM ring. Microphone capture waits on the WASAPI event handle; loopback checks packets every 10 ms so it does not depend on event signaling support across Windows versions. A one-second retry loop reopens the selected endpoint after device invalidation; this is endpoint polling/reinitialization, not `IMMNotificationClient` callbacks. The browser starts playback after buffering 30 ms and uses a bounded 500 ms queue, discarding oldest samples if playback falls behind. These settings aim to absorb relay jitter while limiting latency; real network behavior still needs testing. Unexpected relay loss triggers bounded exponential reconnect attempts and resumes capture on the same selected endpoint when it is still available. Unsupported or non-Windows agents return an explicit error.

## Transport and authorization

MeshAgent already has a custom C data-only WebRTC stack; the browser uses MeshCentral's existing `CreateAgentRedirect` and relay. Both carry arbitrary binary data and the existing tunnel can switch from authenticated WebSocket relay to that DataChannel. The implementation uses an ordered, reliable DataChannel so raw PCM chunks cannot be reordered or dropped, and retains the existing WebSocket fallback. No second WebRTC implementation, audio RTP, libwebrtc, Opus, FFmpeg, public listener, or new third-party audio dependency is introduced.

The project reserves relay protocol 15 in the inspected MeshCentral revision. Its authenticated relay checks remain in place; an added protocol-specific check requires Remote Control or Remote View rights and honors No Desktop, with the existing admin exception. The agent repeats the rights check before dispatching commands. Device IDs and commands are validated on both sides. Protocol 7 is existing plugin JSON data exchange and is not used for PCM. Audio is reset during a relay interruption and resumes after a successful retry if the selected endpoint remains available. It stops on user request, source/device change, desktop disconnect, or terminal connection/device error.

## Repository layout

- `config.json`, `mcaudio.js`, `plugin/mcaudio-viewmode.js`, `plugin/audio-worklet.js`, `modules_meshcore/win-audio.js`: plugin metadata and lifecycle shim, desktop-toolbar modal controller, same-origin AudioWorklet processor, and agent-side relay module.
- `agent/ILibDuktape_WASAPI.c` and `.h`: native Windows Core Audio binding.
- `scripts/patch_meshcentral.js`: applies the relay, agent dispatch/cleanup, browser DataChannel changes, installs the AudioWorklet and ViewMode controller as same-origin public scripts, and adds the toolbar controls/lifecycle hooks to both MeshCentral ViewMode templates.
- `scripts/patch_meshagent.js`: adds the native binding to MeshAgent's CMake-era Windows projects and makefile.

The patches were researched against MeshAgent `709f373d2ccb71b82945b56aaf8c9bc28c3fde8a` and MeshCentral `029b7338ecfeeacc65da3b5a1a4cc069baeb2f65`. Protocol number 15 was unused in those revisions; recheck before applying to a different MeshCentral version. The MeshAgent makefile's source-list change is for builds that use that makefile; Windows project builds are the verified target.

## Verification boundary

The Windows x64 and x86 Release solution builds compile the native code into service and console targets. JavaScript syntax checks and patch whitespace checks pass. The user reports smooth system-output loopback and successful microphone device enumeration/start, but microphone playback remains choppy. The updated microphone conversion/MMCSS path, automatic popup playback, reconnection, device removal, end-to-end relay, and latency still require physical retesting with an updated test agent, browser session, and Windows audio endpoints.
