// worker.js — runs analysis off the main thread.
import { analyzeAudio } from './analyzer.js';

self.onmessage = (e) => {
  const { id, name, sampleRate, channels, isDemo } = e.data;
  try {
    const { report, spectrum } = analyzeAudio({ name, sampleRate, channels }, { isDemo });
    self.postMessage({ id, ok: true, report, spectrum }, [spectrum.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
