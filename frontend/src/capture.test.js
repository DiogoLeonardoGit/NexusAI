import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ api: vi.fn().mockResolvedValue({}) }));

import { recorderFor } from "./capture";


describe("audio chunk recorder", () => {
  afterEach(() => vi.useRealTimers());

  it("restarts MediaRecorder so every chunk has its own WebM header", async () => {
    vi.useFakeTimers();
    const instances = [];
    global.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() {
        this.state = "inactive";
        this.listeners = {};
        this.start = vi.fn(() => { this.state = "recording"; });
        instances.push(this);
      }
      addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
      stop() {
        this.state = "inactive";
        for (const callback of this.listeners.dataavailable || []) callback({ data: new Blob(["audio"]) });
        for (const callback of this.listeners.stop || []) callback();
      }
    };

    const uploads = [];
    const controller = recorderFor({}, "microphone", 1, vi.fn(), uploads);
    expect(instances[0].start).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(instances).toHaveLength(2);
    expect(instances[1].start).toHaveBeenCalledWith();
    await controller.stop();
  });
});
