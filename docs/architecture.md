# Architecture

## Supported integration point

MeshCentral's documented plugin API can register a device tab and invoke plugin lifecycle hooks. The source inspected for this change does not expose a supported ViewMode/PC Control toolbar extension point, so the UI is an **Audio** tab on the selected device. The plugin does not poll or mutate private ViewMode DOM.

## Audio path

On Windows, microphone input is captured from a selected active `eCapture` Core Audio endpoint. System output is captured from a selected active render endpoint through shared-mode WASAPI loopback (`AUDCLNT_STREAMFLAGS_LOOPBACK`). The native module converts to signed 16-bit little-endian, 48 kHz stereo PCM. Its actual payload rate is 1,536,000 bit/s before transport overhead. The browser receives binary chunks and schedules samples through an `AudioWorklet` hosted in the separate controls window when it is open, so playback is independent of MeshCentral's desktop view lifecycle.

The capture worker uses a bounded 100 ms PCM ring. Microphone capture waits on the WASAPI event handle; loopback checks packets every 10 ms so it does not depend on event signaling support across Windows versions. A one-second retry loop reopens the selected endpoint after device invalidation; this is endpoint polling/reinitialization, not `IMMNotificationClient` callbacks. This polling behavior and reconnection on real endpoint removal still require physical Windows testing. The browser starts playback after buffering 30 ms and uses a bounded 500 ms queue, discarding oldest samples if playback falls behind. These settings aim to absorb relay jitter while limiting latency; real network behavior still needs testing. Unsupported or non-Windows agents return an explicit error.

## Transport and authorization

MeshAgent already has a custom C data-only WebRTC stack; the browser uses MeshCentral's existing `CreateAgentRedirect` and relay. Both carry arbitrary binary data and the existing tunnel can switch from authenticated WebSocket relay to that DataChannel. The implementation uses an ordered, reliable DataChannel so raw PCM chunks cannot be reordered or dropped, and retains the existing WebSocket fallback. No second WebRTC implementation, audio RTP, libwebrtc, Opus, FFmpeg, public listener, or new third-party audio dependency is introduced.

The project reserves relay protocol 15 in the inspected MeshCentral revision. Its authenticated relay checks remain in place; an added protocol-specific check requires Remote Control or Remote View rights and honors No Desktop, with the existing admin exception. The agent repeats the rights check before dispatching commands. Device IDs and commands are validated on both sides. Protocol 7 is existing plugin JSON data exchange and is not used for PCM. Audio is not stopped by MeshCentral's desktop-disconnect hook; it only stops on user request, device change, agent/network loss, or device removal/error.

## Repository layout

- `config.json`, `mcaudio.js`, `plugin/audio-worklet.js`, `modules_meshcore/win-audio.js`: plugin metadata, browser device tab and controls window, static same-origin AudioWorklet processor, and agent-side relay module.
- `agent/ILibDuktape_WASAPI.c` and `.h`: native Windows Core Audio binding.
- `scripts/patch_meshcentral.js`: applies the relay, agent dispatch/cleanup, browser DataChannel changes, and installs the worklet as a same-origin public script in a MeshCentral checkout.
- `scripts/patch_meshagent.js`: adds the native binding to MeshAgent's CMake-era Windows projects and makefile.

The patches were researched against MeshAgent `709f373d2ccb71b82945b56aaf8c9bc28c3fde8a` and MeshCentral `029b7338ecfeeacc65da3b5a1a4cc069baeb2f65`. Protocol number 15 was unused in those revisions; recheck before applying to a different MeshCentral version. The MeshAgent makefile's source-list change is for builds that use that makefile; Windows project builds are the verified target.

## Verification boundary

The Windows x64 Debug solution build compiles the native code into both service and console targets. JavaScript syntax checks and patch whitespace checks pass. This is not proof of live WASAPI capture, microphone enumeration, system loopback, tunnel relay, browser playback, device reconnection, or latency. Those require a running MeshCentral instance, an updated test agent, a browser session, and physical Windows audio endpoints.
