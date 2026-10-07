"use strict";

class McAudioPcm extends AudioWorkletProcessor {
    constructor() {
        super();
        this.capacity = 24000; // 500 ms at 48 kHz, per channel
        this.targetBuffer = 1440; // 30 ms absorbs relay and scheduling jitter
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        this.phase = 0;
        this.sourceStep = 48000 / sampleRate;
        this.buffering = true;
        this.port.onmessage = (event) => {
            const samples = event.data;
            if (samples && samples.reset) {
                this.readIndex = this.writeIndex;
                this.available = 0;
                this.phase = 0;
                this.buffering = true;
                return;
            }
            if (!samples || typeof samples.length !== "number") return;
            for (let i = 0; i + 1 < samples.length; i += 2) {
                // Keep the newest audio if the consumer stalls; old PCM only
                // increases latency and cannot be recovered usefully.
                if (this.available === this.capacity) {
                    this.readIndex = (this.readIndex + 1) % this.capacity;
                    this.available--;
                }
                this.left[this.writeIndex] = samples[i];
                this.right[this.writeIndex] = samples[i + 1];
                this.writeIndex = (this.writeIndex + 1) % this.capacity;
                this.available++;
            }
        };
    }

    process(_, outputs) {
        const output = outputs[0];
        const left = output[0];
        const right = output[1] || output[0];
        if (this.buffering) {
            if (this.available < this.targetBuffer) {
                left.fill(0);
                if (right !== left) right.fill(0);
                return true;
            }
            this.buffering = false;
        }

        for (let i = 0; i < left.length; i++) {
            if (this.available < 2) {
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
