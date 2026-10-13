// Keeps a scrape from ever seeing a mix of two poll cycles.
//
// render() is single-flighted: concurrent scrapes of one target share one
// pass over the registry. exclusive() runs a synchronous apply only when no
// render is in flight. The check and the apply sit in one synchronous
// segment after the last await, so a render cannot start between them, and
// the registry's own awaits inside a render can never interleave with an
// apply.
export class RenderGate {
  #inFlight: Promise<string> | undefined;

  render(produce: () => Promise<string>): Promise<string> {
    this.#inFlight ??= produce().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async exclusive(apply: () => void): Promise<void> {
    while (this.#inFlight !== undefined) {
      await this.#inFlight.catch(() => undefined);
    }
    apply();
  }
}
