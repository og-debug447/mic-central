"use strict";

class McAudioPcm extends AudioWorkletProcessor {
    constructor() {
        super();
        this.sourceSampleRate = 48000;
        this.channels = 2;
        this.targetBufferMs = 30;
        this.playing = false;
        this.hasStartedPlayback = false;
        this.statsFrames = 0;
        this.underruns = 0;
        this.gapFrames = 0;
        this.capacity = 24000; // 500 ms at the configured source rate
        this.targetBuffer = 1440; // targetBufferMs absorbs relay and scheduling jitter
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.phase = 0;
        this.sourceStep = this.sourceSampleRate / sampleRate;
        this.buffering = true;
        this.port.onmessage = (event) => {
            const samples = event.data;
            if (samples && samples.configure) {
                const rate = samples.configure.sampleRate;
                const channels = samples.configure.channels;
                const targetBufferMs = samples.configure.targetBufferMs;
                if ([8000, 16000, 24000, 32000, 44100, 48000].includes(rate) && (channels === 1 || channels === 2) && Number.isInteger(targetBufferMs) && targetBufferMs >= 30 && targetBufferMs <= 150 && typeof samples.configure.playing === "boolean") {
                    this.sourceSampleRate = rate;
                    this.channels = channels;
                    this.targetBufferMs = targetBufferMs;
                    this.playing = samples.configure.playing;
                    this.hasStartedPlayback = false;
                    this.statsFrames = 0;
                    this.underruns = 0;
                    this.gapFrames = 0;
                    this.sourceStep = this.sourceSampleRate / sampleRate;
                    this.capacity = Math.max(1024, Math.ceil(this.sourceSampleRate * 0.5));
                    this.targetBuffer = Math.max(64, Math.ceil(this.sourceSampleRate * this.targetBufferMs / 1000));
                    this.left = new Float32Array(this.capacity);
                    this.right = new Float32Array(this.capacity);
                    this.readIndex = 0;
                    this.writeIndex = 0;
                    this.available = 0;
                    this.phase = 0;
                    this.buffering = true;
                }
                return;
            }
            if (samples && samples.reset) {
                this.playing = false;
                this.hasStartedPlayback = false;
                this.readIndex = this.writeIndex;
                this.available = 0;
                this.phase = 0;
                this.buffering = true;
                return;
            }
            if (!samples || typeof samples.length !== "number") return;
            const step = this.channels === 1 ? 1 : 2;
            for (let i = 0; i + step - 1 < samples.length; i += step) {
                // Keep the newest audio if the consumer stalls; old PCM only
                // increases latency and cannot be recovered usefully.
                if (this.available === this.capacity) {
                    this.readIndex = (this.readIndex + 1) % this.capacity;
                    this.available--;
                }
                this.left[this.writeIndex] = samples[i];
                this.right[this.writeIndex] = (this.channels === 1) ? samples[i] : samples[i + 1];
                this.writeIndex = (this.writeIndex + 1) % this.capacity;
                this.available++;
            }
        };
    }

    process(_, outputs) {
        const output = outputs[0];
        const left = output[0];
        const right = output[1] || output[0];
        if (this.playing) {
            this.statsFrames += left.length;
            if (this.statsFrames >= sampleRate * 2) {
                this.statsFrames -= sampleRate * 2;
                this.port.postMessage({ audioStats: {
                    underruns: this.underruns,
                    gapMs: Math.round(this.gapFrames * 1000 / sampleRate),
                    queuedMs: Math.round(this.available * 1000 / this.sourceSampleRate),
                    targetBufferMs: this.targetBufferMs
                } });
                this.underruns = 0;
                this.gapFrames = 0;
            }
        }
        if (this.buffering) {
            if (this.available < this.targetBuffer) {
                if (this.playing && this.hasStartedPlayback) this.gapFrames += left.length;
                left.fill(0);
                if (right !== left) right.fill(0);
                return true;
            }
            this.buffering = false;
            this.hasStartedPlayback = true;
        }

        for (let i = 0; i < left.length; i++) {
            if (this.available < 2) {
                this.underruns++;
                if (this.playing && this.hasStartedPlayback) this.gapFrames += left.length - i;
                left.fill(0, i);
                if (right !== left) right.fill(0, i);
                this.buffering = true;
                this.phase = 0;
                break;
            }

            const next = (this.readIndex + 1) % this.capacity;
            const fraction = this.phase;
            left[i] = this.left[this.readIndex] * (1 - fraction) + this.left[next] * fraction;
            right[i] = this.right[this.readIndex] * (1 - fraction) + this.right[next] * fraction;
            this.phase += this.sourceStep;
            const advance = Math.floor(this.phase);
            if (advance > 0) {
                const consumed = Math.min(advance, this.available - 1);
                this.readIndex = (this.readIndex + consumed) % this.capacity;
                this.available -= consumed;
                this.phase -= consumed;
            }
        }
        return true;
    }
}

registerProcessor("mc-audio-pcm", McAudioPcm);
