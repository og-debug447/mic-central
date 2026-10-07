"use strict";

class McAudioPcm extends AudioWorkletProcessor {
    constructor() {
        super();
        this.capacity = 12000; // 250 ms at 48 kHz
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.phase = 0;
        this.sourceStep = 48000 / sampleRate;
        this.port.onmessage = (event) => {
            const samples = event.data;
            if (samples && samples.reset) {
                this.readIndex = this.writeIndex;
                this.phase = 0;
                return;
            }
            for (let i = 0; i + 1 < samples.length; i += 2) {
                let next = (this.writeIndex + 1) % this.capacity;
                if (next === this.readIndex) this.readIndex = (this.readIndex + 1) % this.capacity;
                this.left[this.writeIndex] = samples[i];
                this.right[this.writeIndex] = samples[i + 1];
                this.writeIndex = next;
            }
        };
    }

    process(_, outputs) {
        const output = outputs[0];
        const left = output[0];
        const right = output[1] || output[0];
        for (let i = 0; i < left.length; i++) {
            const next = (this.readIndex + 1) % this.capacity;
            if (next !== this.writeIndex) {
                const fraction = this.phase;
                left[i] = this.left[this.readIndex] * (1 - fraction) + this.left[next] * fraction;
                right[i] = this.right[this.readIndex] * (1 - fraction) + this.right[next] * fraction;
                this.phase += this.sourceStep;
                while (this.phase >= 1) {
                    this.readIndex = (this.readIndex + 1) % this.capacity;
                    this.phase -= 1;
                }
            } else {
                left[i] = 0;
                right[i] = 0;
            }
        }
        return true;
    }
}

registerProcessor("mc-audio-pcm", McAudioPcm);
