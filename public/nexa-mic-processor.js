/* global AudioWorkletProcessor, registerProcessor, sampleRate */

class NexaMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 16000
    this.ratio = sampleRate / this.targetSampleRate
    this.carry = new Float32Array(0)
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]

    if (output) {
      output.fill(0)
    }

    if (!input || input.length === 0) {
      return true
    }

    const data = new Float32Array(this.carry.length + input.length)
    data.set(this.carry)
    data.set(input, this.carry.length)

    const outputLength = Math.floor(data.length / this.ratio)
    if (outputLength <= 0) {
      this.carry = data
      return true
    }

    const pcm = new Int16Array(outputLength)
    for (let i = 0; i < outputLength; i += 1) {
      const start = Math.floor(i * this.ratio)
      const end = Math.min(Math.floor((i + 1) * this.ratio), data.length)
      let sum = 0
      let count = 0

      for (let j = start; j < end; j += 1) {
        sum += data[j]
        count += 1
      }

      const sample = Math.max(-1, Math.min(1, count ? sum / count : 0))
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }

    const consumed = Math.floor(outputLength * this.ratio)
    this.carry = data.slice(consumed)
    this.port.postMessage(pcm.buffer, [pcm.buffer])
    return true
  }
}

registerProcessor('nexa-mic-processor', NexaMicProcessor)
