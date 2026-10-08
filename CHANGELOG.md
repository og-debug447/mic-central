# Changelog

## 0.1.3

- Increase the microphone's default browser jitter buffer to 100 ms to reduce gaps caused by relay timing variation.

## 0.1.2

- Add selectable PCM sample rates and mono/stereo output, with bitrate calculated from the actual 16-bit PCM format.
- Give microphone and PC audio independent authenticated tunnels and playback queues so they can run together.
- Keep each source's device and format selection independent.

## 0.1.1

- Move controls to Speakers and Microphone buttons in MeshCentral PC Control/ViewMode.
- Open device/source selection and Start/Stop controls in MeshCentral's standard modal.
- Remove the separate Audio tab and popup controls window.
- Patch both default and default3 ViewMode templates with explicit, version-sensitive anchors.

## 0.1.0

- Add a MeshCentral Audio device tab for microphone and system-output listening.
- Capture Windows audio through native WASAPI microphone and loopback APIs.
- Stream PCM over the existing authenticated MeshCentral relay and MeshAgent data channel.
