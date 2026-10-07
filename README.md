# mic-central

Microphone and system audio listening for MeshCentral, implemented as a plugin with native Windows WASAPI capture.

Native Windows microphone and system-output listening for MeshCentral. Microphones use Windows Core Audio capture; system audio uses WASAPI loopback. The plugin UI is a device **Audio** tab, exposed through MeshCentral's plugin API.

Audio is uncompressed signed 16-bit, 48 kHz, stereo PCM: 1.536 Mbps of payload before transport overhead. No audio codec or third-party audio library is used.

## Status

The MeshAgent Windows x64 Debug solution builds with the native binding included. The plugin and patch scripts pass JavaScript syntax checks. Physical capture, WebRTC/relay delivery, playback, reconnection, and latency have not yet been demonstrated; see [architecture](docs/architecture.md) for the verification boundary.

## Apply to source checkouts

Use clean, disposable MeshCentral and MeshAgent checkouts. The patch scripts edit those checkouts in place.

```powershell
node .\scripts\patch_meshcentral.js C:\path\to\MeshCentral
node .\scripts\patch_meshagent.js C:\path\to\MeshAgent
```

Run `patch_meshcentral.js` after placing this repository on the build host; it also copies the worklet processor into MeshCentral's same-origin `public/scripts/` directory, which is needed because the default Content Security Policy blocks Blob-loaded scripts. Copy the contents of `plugin/` into the MeshCentral `plugins/mcaudio/` directory. Build the updated Windows agent from `MeshAgent-2022.sln` for x64 and deploy that agent to a test device. Consult MeshCentral's plugin documentation for enabling the plugin in the server configuration. The MeshCentral and MeshAgent source revisions used during development are pinned in [architecture](docs/architecture.md).

Do not deploy to production before testing with a disposable MeshCentral instance and Windows test device. A repository revision mismatch may require adapting the patches, especially the reserved relay protocol number.

## Build checked agent

On a Visual Studio installation with the C++ and Windows SDK workloads:

```powershell
& 'C:\Program Files\Microsoft Visual Studio\<version>\Community\MSBuild\Current\Bin\MSBuild.exe' C:\path\to\MeshAgent\MeshAgent-2022.sln /m /p:Configuration=Debug /p:Platform=x64 /v:minimal
```

The binding uses only Windows SDK Core Audio/COM APIs and existing MeshAgent/Duktape dependencies.


