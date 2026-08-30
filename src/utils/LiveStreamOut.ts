// src/utils/LiveStreamOut.ts

export class LiveStreamOut {
    private audioContext: AudioContext;
    private masterGain: GainNode;
    private stream: MediaStreamAudioDestinationNode;

    constructor(audioContext: AudioContext) {
        this.audioContext = audioContext;
        this.masterGain = this.audioContext.createGain();
        this.stream = this.audioContext.createMediaStreamDestination();
        this.masterGain.connect(this.stream);
    }

    // Connect this to the main out of the Mischpult/Mastering module
    connectMasterOutput(sourceNode: AudioNode) {
        sourceNode.connect(this.masterGain);
    }

    getStream() {
        return this.stream.stream;
    }
}
