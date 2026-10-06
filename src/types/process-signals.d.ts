/**
 * bun-types re-declares `Process.on` with only a `memoryPressure` overload, and an
 * interface re-declaration replaces the inherited `EventEmitter.on` rather than adding
 * to it. Signal names that Node and Bun both support are therefore rejected by the
 * type checker even though they work at runtime. Re-declaring the signal overloads is
 * the same remedy bun-types already applies to `off` and `removeListener`.
 */
declare global {
  namespace NodeJS {
    interface Process {
      on(event: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): this;
    }
  }
}

export {};
