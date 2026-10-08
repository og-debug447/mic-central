# mic-central

Native Windows microphone and system-output listening for MeshCentral. Microphones use Windows Core Audio capture; system audio uses WASAPI loopback. While viewing a Windows PC, the desktop toolbar has **Speakers** and **Microphone** buttons. Each opens a MeshCentral dialog with source and device selection plus Start/Stop controls. Playback stays in the desktop page, so the remote screen and audio can be used together.

Audio is uncompressed signed 16-bit PCM. In each source dialog, choose a sample rate from 8,000 to 48,000 Hz and mono or stereo. Microphone starts at 16 kHz mono (256 kbps) with a 100 ms playback buffer; PC audio starts at 48 kHz stereo (1.536 Mbps) with a 30 ms buffer. The displayed bitrate is calculated from the selected format (`sample rate × channels × 16 bits`); 8 kHz mono uses 128 kbps before transport overhead. Bitrate follows the format; it is not an independent compressed-quality setting. Speakers and microphone use separate authenticated agent tunnels and can play at the same time. No audio codec or third-party audio library is used.

## Status

The MeshAgent Windows x64 Release and x86 Release solutions build with the native binding included. The native capture path produces the selected rate/channel format; microphone capture asks the Windows audio engine to convert formats when needed, with a native-format conversion fallback, and schedules capture under MMCSS. The microphone starts at 16 kHz mono with a 100 ms browser buffer to reduce relay underruns. The user reports that system-output loopback is smooth, while microphone playback has been choppy. These mitigations and simultaneous-source playback still need physical testing. Tunnel recovery retries after transient connection loss. See [architecture](docs/architecture.md) for the verification boundary.

## Apply to source checkouts

Use clean, disposable MeshCentral and MeshAgent checkouts. The patch scripts edit those checkouts in place. The MeshCentral patch updates the existing relay scripts and both ViewMode templates (`default.handlebars` and `default3.handlebars`) because MeshCentral does not expose a supported plugin hook for the desktop toolbar. It uses explicit template anchors; if those anchors change in a later MeshCentral release, the patch stops with an error and must be adapted. Reapply it after replacing/updating the MeshCentral package.

```powershell
node .\scripts\patch_meshcentral.js C:\path\to\MeshCentral
node .\scripts\patch_meshagent.js C:\path\to\MeshAgent
```

Run `patch_meshcentral.js` after placing this repository on the build host; it also copies the AudioWorklet and ViewMode controller into MeshCentral's same-origin `public/scripts/` directory. Build and deploy the updated Windows MeshAgent from `MeshAgent-2022.sln` for x64. In MeshCentral's server Plugins page, add the plugin using `https://raw.githubusercontent.com/og-debug447/mic-central/main/config.json`, then install it. The GitHub archive has `config.json`, `mcaudio.js`, and `modules_meshcore/` at its root so MeshCentral can load them. The MeshCentral and MeshAgent source revisions used during development are pinned in [architecture](docs/architecture.md).

Do not deploy to production before testing with a disposable MeshCentral instance and Windows test device. A repository revision mismatch may require adapting the patches, especially the reserved relay protocol number.

## Build checked agent

On a Visual Studio installation with the C++ and Windows SDK workloads:

```powershell
& 'C:\Program Files\Microsoft Visual Studio\<version>\Community\MSBuild\Current\Bin\MSBuild.exe' C:\path\to\MeshAgent\MeshAgent-2022.sln /m /p:Configuration=Debug /p:Platform=x64 /v:minimal
```

The binding uses only Windows SDK Core Audio/COM APIs and existing MeshAgent/Duktape dependencies.


